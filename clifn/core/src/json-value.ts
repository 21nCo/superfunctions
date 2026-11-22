import { constants } from "node:buffer";
import { types } from "node:util";
import { isSensitiveKey } from "./sensitive-keys.js";

/** Turns a value into one `JSON.stringify` accepts: bigints become strings and cycles become "[Circular]". */
export function normalizeJsonValue(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === "bigint") {
    return value.toString();
  }

  if (Array.isArray(value)) {
    if (seen.has(value)) {
      return "[Circular]";
    }

    seen.add(value);
    try {
      return value.map((item) => normalizeJsonValue(item, seen));
    } finally {
      seen.delete(value);
    }
  }

  if (value && typeof value === "object") {
    if (seen.has(value)) {
      return "[Circular]";
    }

    seen.add(value);
    try {
      if (typeof (value as { toJSON?: () => unknown }).toJSON === "function") {
        return normalizeJsonValue((value as { toJSON: () => unknown }).toJSON(), seen);
      }

      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([key, nested]) => [
          key,
          normalizeJsonValue(nested, seen),
        ])
      );
    } finally {
      seen.delete(value);
    }
  }

  return value;
}

const CIRCULAR = '"[Circular]"';
const REDACTED = '"[REDACTED]"';
/**
 * How many projections of one original member value may be open on the active path at once (see
 * `serializeJsonMember`). A toJSON that keeps returning fresh objects which lead back to the same value (where
 * JSON.stringify recurses until its stack overflows) is marked "[Circular]" in place at the next recurrence; finite
 * chains up to this depth print exactly as JSON.stringify prints them.
 */
export const PROJECTION_REPEAT_LIMIT = 64;

/** Thrown when a value's JSON text cannot fit what is left of a document's budget. */
export class DocumentBudgetExceeded extends RangeError {}

/** How many characters of JSON text one result document may still print. */
export interface DocumentBudget {
  charsLeft: number;
}

/**
 * The budget of one result document: the engine's maximum string length, where `JSON.stringify` itself throws a
 * RangeError, or a smaller `limit` (used by tests). Every piece of text is charged at its exact length as it is
 * written, so a document that stays within its budget is exactly that long. A value, or its JSON text, that does not
 * fit the heap exhausts it here as it would in `JSON.stringify`: that is outside this bound.
 */
export function createDocumentBudget(limit: number = constants.MAX_STRING_LENGTH): DocumentBudget {
  return { charsLeft: limit };
}

/** Counts `chars` of text against the budget; throws a RangeError when they do not fit. */
export function spendText(budget: DocumentBudget, chars: number): void {
  budget.charsLeft -= chars;
  if (budget.charsLeft < 0) {
    throw new DocumentBudgetExceeded("Value too large for a result document");
  }
}

/**
 * The JSON text of `text` as a string, or undefined when it is longer than `room` characters. A string whose bare
 * length and quotes already exceed `room` is rejected before it is encoded.
 */
export function encodeString(text: string, room: number): string | undefined {
  if (text.length + 2 > room) {
    return undefined;
  }
  let encoded: string;
  try {
    encoded = JSON.stringify(text);
  } catch {
    // Escapes made it longer than the engine allows.
    return undefined;
  }
  return encoded.length <= room ? encoded : undefined;
}

/** Receives JSON text in order. */
interface TextSink {
  write(text: string): void;
}

const DISCARD: TextSink = { write() {} };
/** Parts joined into one flat chunk, so many small writes do not each stay a separate string. */
const PARTS_PER_CHUNK = 4096;

/**
 * JSON text built in order from small writes, joined into flat chunks as it grows, so it holds about the text itself
 * and no copy of the value it came from.
 */
export class JsonText implements TextSink {
  private chunks: string[] = [];
  private parts: string[] = [];
  /** The first piece written: "{" for an object, "[" for an array. */
  first: string | undefined;

  write(text: string): void {
    this.first ??= text;
    this.parts.push(text);
    if (this.parts.length === PARTS_PER_CHUNK) {
      this.chunks.push(this.parts.join(""));
      this.parts = [];
    }
  }

  /** Appends the text of `other`, without copying it. */
  append(other: JsonText): void {
    for (const chunk of other.chunks) {
      this.write(chunk);
    }
    for (const part of other.parts) {
      this.write(part);
    }
  }

  toString(): string {
    return [...this.chunks, ...this.parts].join("");
  }
}

const booleanValueOf = Boolean.prototype.valueOf;
const bigintValueOf = BigInt.prototype.valueOf;

interface Walk {
  /** The objects being serialized, as JSON.stringify's stack holds them. */
  readonly nodes: Set<object>;
  /** How many of those objects were produced from each original member value (before its toJSON ran). */
  readonly originals: Map<unknown, number>;
  /** Originals that reached PROJECTION_REPEAT_LIMIT while still open: any further recurrence of them is marked. */
  readonly capped: Set<unknown>;
  /** Where text goes and what it is charged to; a redacted value is walked into a discard sink with its own budget. */
  out: TextSink;
  budget: DocumentBudget;
  /** Print the value of every sensitive object key as "[REDACTED]", as `redactValue` does. */
  redact: boolean;
}

function emit(walk: Walk, text: string): void {
  spendText(walk.budget, text.length);
  walk.out.write(text);
}

function emitString(walk: Walk, text: string): void {
  const encoded = encodeString(text, walk.budget.charsLeft);
  if (encoded === undefined) {
    throw new DocumentBudgetExceeded("Value too large for a result document");
  }
  emit(walk, encoded);
}

function isTracked(value: unknown): value is object {
  return (typeof value === "object" && value !== null) || typeof value === "function";
}

/** ToLength, as JSON.stringify applies it to an array's length; unary plus is ToNumber, so a bigint throws. */
function toLength(value: unknown): number {
  const number = +(value as number);
  if (Number.isNaN(number) || number <= 0) {
    return 0;
  }
  return Math.min(Math.trunc(number), Number.MAX_SAFE_INTEGER);
}

/**
 * Unwraps a boxed primitive by internal slot, in any realm, as JSON.stringify does: a Number box through ToNumber
 * (unary plus, which throws when its valueOf returns a bigint), a String box through ToString, a Boolean box and a
 * BigInt box from their slot. Any other object is returned unchanged.
 */
function unbox(value: object): unknown {
  if (types.isNumberObject(value)) {
    return +value;
  }
  if (types.isStringObject(value)) {
    return String(value);
  }
  if (types.isBooleanObject(value)) {
    return Reflect.apply(booleanValueOf, value, []);
  }
  if (types.isBigIntObject(value)) {
    return Reflect.apply(bigintValueOf, value, []);
  }
  return value;
}

/** Writes a primitive's JSON text (bigints as strings); returns false when JSON drops it. */
function writePrimitive(walk: Walk, value: unknown): boolean {
  if (typeof value === "string") {
    emitString(walk, value);
  } else if (typeof value === "number") {
    emit(walk, Number.isFinite(value) ? String(value) : "null");
  } else if (value === null || typeof value === "boolean") {
    emit(walk, String(value));
  } else if (typeof value === "bigint") {
    emitString(walk, value.toString());
  } else {
    return false;
  }
  return true;
}

/** The first steps of SerializeJSONProperty: reads `holder[key]` once, applies its toJSON and unboxes the result. */
function project(holder: object, key: string): { original: unknown; value: unknown } {
  const original: unknown = Reflect.get(holder, key);
  let value = original;
  if (isTracked(value) || typeof value === "bigint") {
    const toJSON: unknown = (value as { toJSON?: unknown }).toJSON;
    if (typeof toJSON === "function") {
      value = Reflect.apply(toJSON, value, [key]);
    }
  }
  return { original, value: typeof value === "object" && value !== null ? unbox(value) : value };
}

/**
 * SerializeJSONProperty: writes the JSON text of `holder[key]`, after `before` once the member is known to print.
 * Returns false when JSON drops the member.
 */
function serializeProperty(walk: Walk, holder: object, key: string, before?: () => void): boolean {
  const { original, value } = project(holder, key);
  if (typeof value === "object" && value !== null) {
    before?.();
    serializeNode(walk, value, original);
    return true;
  }
  if (value === undefined || typeof value === "function" || typeof value === "symbol") {
    return false;
  }
  before?.();
  return writePrimitive(walk, value);
}

/** True when `node` must print as "[Circular]": it is being serialized, or its original recurs past the limit. */
function isRecurrence(walk: Walk, node: object, original: unknown, open: number): boolean {
  if (walk.nodes.has(node)) {
    return true;
  }
  if (open > 0 && (open >= PROJECTION_REPEAT_LIMIT || walk.capped.has(original))) {
    walk.capped.add(original);
    return true;
  }
  return false;
}

/**
 * Serializes an object or array with `node` on the active path, in one pass. A node already on the path is
 * "[Circular]" (where JSON.stringify throws a TypeError). A node produced from an original value that already has
 * PROJECTION_REPEAT_LIMIT projections open is "[Circular]" in place, and so is every later recurrence of that original
 * while it stays open, so a toJSON that branches back to itself cannot multiply the work.
 */
function serializeNode(walk: Walk, node: object, original: unknown): void {
  const open = walk.originals.get(original) ?? 0;
  if (isRecurrence(walk, node, original, open)) {
    emit(walk, CIRCULAR);
    return;
  }
  walk.nodes.add(node);
  walk.originals.set(original, open + 1);
  try {
    if (Array.isArray(node)) {
      serializeArray(walk, node);
    } else {
      serializeObject(walk, node);
    }
  } finally {
    walk.nodes.delete(node);
    if (open === 0) {
      walk.originals.delete(original);
      walk.capped.delete(original);
    } else {
      walk.originals.set(original, open);
    }
  }
}

/**
 * SerializeJSONArray: the length is converted once. Every index prints at least one character and a separator, so an
 * array whose brackets, separators and one character per item (2n + 1) cannot fit throws before any index is read.
 * Each index is read once; a dropped item prints null.
 */
function serializeArray(walk: Walk, array: object): void {
  const length = toLength(Reflect.get(array, "length"));
  if ((length === 0 ? 2 : 2 * length + 1) > walk.budget.charsLeft) {
    throw new DocumentBudgetExceeded("Value too large for a result document");
  }
  emit(walk, "[");
  for (let index = 0; index < length; index += 1) {
    if (index > 0) {
      emit(walk, ",");
    }
    if (!serializeProperty(walk, array, String(index))) {
      emit(walk, "null");
    }
  }
  emit(walk, "]");
}

/**
 * Walks the value of a sensitive member into a discard sink, so its getters and toJSON run in order, against a
 * budget of its own at the engine's limit, so a value JSON.stringify could not print still fails. Returns false when
 * JSON drops the member.
 */
function discardProperty(walk: Walk, record: object, name: string): boolean {
  const { out, budget, redact } = walk;
  walk.out = DISCARD;
  walk.budget = createDocumentBudget();
  walk.redact = false;
  try {
    return serializeProperty(walk, record, name);
  } finally {
    walk.out = out;
    walk.budget = budget;
    walk.redact = redact;
  }
}

/**
 * SerializeJSONObject: own enumerable string keys in order, each read once; dropped members are left out. With
 * `redact`, a sensitive member that JSON prints is written as "[REDACTED]".
 */
function serializeObject(walk: Walk, record: object): void {
  emit(walk, "{");
  let members = 0;
  const writeKey = (name: string) => {
    if (members > 0) {
      emit(walk, ",");
    }
    emitString(walk, name);
    emit(walk, ":");
    members += 1;
  };
  for (const name of Object.keys(record)) {
    if (walk.redact && isSensitiveKey(name)) {
      if (discardProperty(walk, record, name)) {
        writeKey(name);
        emit(walk, REDACTED);
      }
    } else {
      serializeProperty(walk, record, name, () => writeKey(name));
    }
  }
  emit(walk, "}");
}

/**
 * Writes the JSON text `JSON.stringify` writes for a value as the member `key` of an object, following its algorithm
 * step by step in a single pass: each member is read once, each getter and toJSON runs exactly as often as
 * JSON.stringify runs it, toJSON (on an object, function or bigint) gets its real key or array index, an array length
 * is converted once, boxed primitives are unwrapped by internal slot, and dropped members are left out or become null
 * in arrays. Only the text is kept, never a copy of the value, and each piece is charged to `budget` at its exact
 * length as it is written.
 *
 * Where JSON.stringify would throw or never finish, the text stays printable, and these are the only divergences:
 * - bigints become strings, as in `normalizeJsonValue`;
 * - an object or array that is already being serialized prints "[Circular]" (JSON.stringify throws a TypeError);
 * - a toJSON that keeps returning fresh objects leading back to the same original value prints
 *   PROJECTION_REPEAT_LIMIT (64) nested projections and then "[Circular]" in place, and later recurrences of that
 *   value inside it are marked at once; a finite chain deeper than 64 projections of one value is cut the same way;
 * - text that cannot fit what is left of `budget` (see `createDocumentBudget`) throws a RangeError, as JSON.stringify
 *   does past the engine's string limit; an array checks 2n + 1 characters before its index 0 is read, so an
 *   oversized sparse or proxy array fails at once.
 *
 * With `redact`, every sensitive object key below the member (see `redactValue`) prints "[REDACTED]" when JSON prints
 * it at all. Its value is still walked in order, so its getters and toJSON run as in JSON.stringify, but its text is
 * discarded and counted only against a budget of its own at the engine's limit.
 *
 * A value, or its text, that does not fit the heap exhausts it as it would in JSON.stringify; that is not caught.
 *
 * Returns undefined when JSON drops the member (undefined, a function, a symbol, or a `toJSON` that returns one).
 * Throws what JSON.stringify throws, such as a throwing getter or `toJSON`, or a Number box whose `valueOf` returns a
 * bigint. On a throw, `budget` has been charged for part of the text: callers charge a copy and keep it on success.
 */
export function serializeJsonMember(
  key: string,
  value: unknown,
  { budget = createDocumentBudget(), redact = false }: { budget?: DocumentBudget; redact?: boolean } = {}
): JsonText | undefined {
  const holder = Object.create(null) as Record<string, unknown>;
  holder[key] = value;
  const out = new JsonText();
  const walk: Walk = { nodes: new Set(), originals: new Map(), capped: new Set(), out, budget, redact };
  return serializeProperty(walk, holder, key) ? out : undefined;
}

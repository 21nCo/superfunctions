import { constants } from "node:buffer";
import { types } from "node:util";

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

const CIRCULAR = "[Circular]";
/**
 * How many projections of one original member value may be open on the active path at once (see
 * `resolveJsonMember`). A toJSON that keeps returning fresh objects which lead back to the same value (where
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
 * RangeError, or a smaller `limit` (used by tests). Data, error details and diagnostics charge a lower bound of the
 * text they print against it, so a value whose text cannot be printed is rejected before it is built. A value, or its
 * JSON text, that does not fit the heap exhausts it here as it would in `JSON.stringify`: that is outside this bound.
 */
export function createDocumentBudget(limit: number = constants.MAX_STRING_LENGTH): DocumentBudget {
  return { charsLeft: limit };
}

/** Counts `chars` of text against the budget; throws a RangeError, before they are built, when they do not fit. */
export function spendText(budget: DocumentBudget, chars: number): void {
  budget.charsLeft -= chars;
  if (budget.charsLeft < 0) {
    throw new DocumentBudgetExceeded("Value too large for a result document");
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
  readonly budget: DocumentBudget;
}

function isTracked(value: unknown): value is object {
  return (typeof value === "object" && value !== null) || typeof value === "function";
}

/**
 * The length of `text` as a JSON string, without its escapes: read from `length` alone, so no string is scanned or
 * flattened. Escapes only make the printed text longer; `createDocumentOutput` checks the final text.
 */
function jsonStringLength(text: string): number {
  return text.length + 2;
}

/** The length of the JSON text of a primitive `toJsonPrimitive` returned (0 when JSON drops it). */
function primitiveLength(value: string | number | boolean | null | undefined): number {
  if (typeof value === "string") {
    return jsonStringLength(value);
  }
  return value === undefined ? 0 : String(value).length;
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

/** The JSON primitive a non-object value prints as (bigints as strings), or undefined when JSON drops it. */
function toJsonPrimitive(value: unknown): string | number | boolean | null | undefined {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return value;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  return undefined;
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

/** SerializeJSONProperty: the JSON value of `holder[key]`, or undefined when JSON drops the member. */
function serializeProperty(walk: Walk, holder: object, key: string): unknown {
  const { original, value } = project(holder, key);
  if (typeof value === "object" && value !== null) {
    return serializeNode(walk, value, original);
  }
  const primitive = toJsonPrimitive(value);
  spendText(walk.budget, primitiveLength(primitive));
  return primitive;
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
function serializeNode(walk: Walk, node: object, original: unknown): unknown {
  const open = walk.originals.get(original) ?? 0;
  if (isRecurrence(walk, node, original, open)) {
    spendText(walk.budget, jsonStringLength(CIRCULAR));
    return CIRCULAR;
  }
  walk.nodes.add(node);
  walk.originals.set(original, open + 1);
  try {
    return Array.isArray(node) ? serializeArray(walk, node) : serializeObject(walk, node);
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
 * SerializeJSONArray: the length is converted once. Every index prints at least one character and a separator, so
 * the brackets, separators and one character per item (2n + 1) are counted before any index is read, and an array
 * whose text cannot fit throws at once. Each index is read once; a dropped item becomes null.
 */
function serializeArray(walk: Walk, array: object): unknown[] {
  const length = toLength(Reflect.get(array, "length"));
  spendText(walk.budget, length === 0 ? 2 : 2 * length + 1);
  const items: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    // The item's own text replaces the one character already counted for it.
    walk.budget.charsLeft += 1;
    const item = serializeProperty(walk, array, String(index));
    if (item === undefined) {
      spendText(walk.budget, "null".length);
    }
    items.push(item === undefined ? null : item);
  }
  return items;
}

/** SerializeJSONObject: own enumerable string keys in order, each read once; dropped members are left out. */
function serializeObject(walk: Walk, record: object): Record<string, unknown> {
  spendText(walk.budget, 2);
  const entries: Array<[string, unknown]> = [];
  for (const name of Object.keys(record)) {
    const member = serializeProperty(walk, record, name);
    if (member !== undefined) {
      // The key, its colon and, after the first member, a separator.
      spendText(walk.budget, jsonStringLength(name) + 1 + (entries.length > 0 ? 1 : 0));
      entries.push([name, member]);
    }
  }
  return Object.fromEntries(entries);
}

/**
 * Resolves a value to the plain JSON value that `JSON.stringify` writes for it as the member `key` of an object,
 * following its algorithm step by step in a single pass: each member is read once, each getter and toJSON runs
 * exactly as often as JSON.stringify runs it, toJSON (on an object, function or bigint) gets its real key or array
 * index, an array length is converted once, boxed primitives are unwrapped by internal slot, and dropped members are
 * left out or become null in arrays. The result is built from fresh plain objects and arrays, so redacting it and
 * serializing it again calls no user code.
 *
 * Where JSON.stringify would throw or never finish, the result stays printable, and these are the only divergences:
 * - bigints become strings, as in `normalizeJsonValue`;
 * - an object or array that is already being serialized prints "[Circular]" (JSON.stringify throws a TypeError);
 * - a toJSON that keeps returning fresh objects leading back to the same original value prints
 *   PROJECTION_REPEAT_LIMIT (64) nested projections and then "[Circular]" in place, and later recurrences of that
 *   value inside it are marked at once; a finite chain deeper than 64 projections of one value is cut the same way;
 * - a value whose JSON text cannot fit what is left of `budget` (see `createDocumentBudget`) throws a RangeError, as
 *   JSON.stringify does past the engine's string limit, but before the rest of the value is resolved: each value
 *   counts a lower bound of its text (punctuation, separators, keys and strings with their quotes, number and literal
 *   text), and an array counts 2n + 1 characters before its index 0 is read, so an oversized sparse or proxy array
 *   fails at once. Nothing is refunded on a throw; the caller restores `budget.charsLeft` when it drops the member.
 *
 * A value, or its text, that does not fit the heap exhausts it as it would in JSON.stringify; that is not caught.
 *
 * Returns undefined when JSON drops the member (undefined, a function, a symbol, or a `toJSON` that returns one).
 * Throws what JSON.stringify throws, such as a throwing getter or `toJSON`, or a Number box whose `valueOf` returns a
 * bigint.
 */
export function resolveJsonMember(
  key: string,
  value: unknown,
  { budget = createDocumentBudget() }: { budget?: DocumentBudget } = {}
): unknown {
  const holder = Object.create(null) as Record<string, unknown>;
  holder[key] = value;
  const walk: Walk = { nodes: new Set(), originals: new Map(), capped: new Set(), budget };
  return serializeProperty(walk, holder, key);
}

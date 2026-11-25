import { constants } from "node:buffer";
import { types } from "node:util";
import { getHeapStatistics } from "node:v8";

const CIRCULAR = '"[Circular]"';
const REDACTED = '"[REDACTED]"';
/**
 * How many projections of one original member value may be open on the active path at once (see
 * `serializeJsonMember`). A toJSON that keeps returning fresh objects which lead back to the same value (where
 * JSON.stringify recurses until its stack overflows) is marked "[Circular]" in place at the next recurrence; finite
 * chains up to this depth print exactly as JSON.stringify prints them. Once a value has reached the limit, each later
 * projection of it on the same path (a sibling of the capped branch) is still printed, one level deep: projections of
 * that value inside it print "[Circular]", so a toJSON that branches back to itself costs linear, not exponential, work.
 */
export const PROJECTION_REPEAT_LIMIT = 64;
/**
 * How many objects and arrays may be nested inside one member. A deeper value fails with a RangeError before its next
 * level is read, where JSON.stringify would exhaust the stack.
 */
export const MAX_NESTING_DEPTH = 512;
/** The share of V8's heap limit one result document may use as text (see `documentLimit`). */
const HEAP_SHARE = 16;
/**
 * The work units an index of a typed array costs before its keys are listed: `Object.keys` creates each index key as a
 * new string (about 32 bytes with its slot) although the array stores its elements outside the heap, so the units bound
 * that allocation, not just the walk.
 */
export const TYPED_ARRAY_INDEX_UNITS = 32;

/** Thrown when a value's JSON text, or the work to walk it, cannot fit what is left of a document's budget. */
export class DocumentBudgetExceeded extends RangeError {}

/** How many characters of JSON text one result document may still print. */
export interface DocumentBudget {
  charsLeft: number;
}

/**
 * How much walking one result document may still do, in units: each printed character, each value walked under a
 * redacted key and each object member or array item reserved before it is read. It is never given back, so work spent
 * on text that is then dropped (redacted values, details or diagnostics that do not fit) stays bounded.
 */
export interface WorkBudget {
  unitsLeft: number;
}

/**
 * The longest result document, in characters including its newline: the smaller of the engine's maximum string
 * length (where `JSON.stringify` itself throws) and a sixteenth of V8's heap limit, so the document text and the one
 * copy that joins it fit the heap the process runs with.
 */
export function documentLimit(): number {
  return Math.min(constants.MAX_STRING_LENGTH, Math.floor(getHeapStatistics().heap_size_limit / HEAP_SHARE));
}

/** A document budget of `limit` characters, `documentLimit()` by default (tests pass a smaller one). */
export function createDocumentBudget(limit: number = documentLimit()): DocumentBudget {
  return { charsLeft: limit };
}

/** The work budget of a document whose text budget is `limit`: the text itself and as much again for discarded work. */
export function createWorkBudget(limit: number = documentLimit()): WorkBudget {
  return { unitsLeft: 2 * limit };
}

function exceeded(): never {
  throw new DocumentBudgetExceeded("Value too large for a result document");
}

/** Counts `chars` of text against the budget; throws a RangeError when they do not fit. */
export function spendText(budget: DocumentBudget, chars: number): void {
  budget.charsLeft -= chars;
  if (budget.charsLeft < 0) {
    exceeded();
  }
}

/** Counts `units` of work against the budget, never given back; throws a RangeError when they do not fit. */
export function spendWork(work: WorkBudget, units: number): void {
  work.unitsLeft -= units;
  if (work.unitsLeft < 0) {
    exceeded();
  }
}

/** The JSON escape length of the code unit at `index` of `text` (a lone surrogate prints as `\uXXXX`). */
function escapedUnitLength(text: string, index: number, code: number): number {
  if (code === 0x22 || code === 0x5c || code === 0x08 || code === 0x0c || code === 0x0a || code === 0x0d || code === 0x09) {
    return 2;
  }
  if (code < 0x20) {
    return 6;
  }
  if (code >= 0xd800 && code <= 0xdbff) {
    const next = text.charCodeAt(index + 1);
    return next >= 0xdc00 && next <= 0xdfff ? 1 : 6;
  }
  if (code >= 0xdc00 && code <= 0xdfff) {
    const previous = index > 0 ? text.charCodeAt(index - 1) : 0;
    return previous >= 0xd800 && previous <= 0xdbff ? 1 : 6;
  }
  return 1;
}

/**
 * Whether the JSON text of `text` (with its quotes) fits `room`, counted without building it: the scan stops at the
 * first code unit past `room`. A scan that finds the text too long charges each scanned code unit to `work`, so dropped
 * text stays bounded; a text that fits is charged once, at its encoded length, when it is written.
 */
function escapedFits(text: string, room: number, work: WorkBudget | undefined): boolean {
  let length = 2;
  let index = 0;
  for (; index < text.length && length <= room; index += 1) {
    length += escapedUnitLength(text, index, text.charCodeAt(index));
  }
  if (length > room && work) {
    spendWork(work, index);
  }
  return length <= room;
}

/**
 * The JSON text of `text` as a string, or undefined when it is longer than `room` characters. Nothing is built for a
 * string that does not fit: one whose bare length and quotes already exceed `room` is rejected from its length, and
 * one that could only fit without escapes is counted first (that scan is charged to `work`).
 */
export function encodeString(text: string, room: number, work?: WorkBudget): string | undefined {
  if (text.length + 2 > room) {
    return undefined;
  }
  // Every code unit prints as at most six characters.
  if (text.length * 6 + 2 > room && !escapedFits(text, room, work)) {
    return undefined;
  }
  const encoded = JSON.stringify(text);
  return encoded.length <= room ? encoded : undefined;
}

/** Receives JSON text in order. */
interface TextSink {
  write(text: string): void;
}

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
/** %TypedArray%.prototype.length: reads the length from the internal slot, for a typed array of any realm. */
const typedArrayLength = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), "length")
  ?.get as () => number;
/** log10(2): the decimal digits each bit of a bigint adds. */
const DIGITS_PER_BIT = Math.log10(2);

interface Walk {
  /** The objects being serialized, as JSON.stringify's stack holds them. */
  readonly nodes: Set<object>;
  /** How many of those objects were produced from each original member value (before its toJSON ran). */
  readonly originals: Map<unknown, number>;
  /** Originals that reached PROJECTION_REPEAT_LIMIT while still open (cleared when they close). */
  readonly capped: Set<unknown>;
  /** Capped originals with a projection being printed one level deep: projections of them inside it are marked. */
  readonly cappedWalks: Set<unknown>;
  readonly out: TextSink;
  readonly budget: DocumentBudget;
  readonly work: WorkBudget;
  /** Which object keys print "[REDACTED]" instead of their value, or undefined for none. */
  readonly isSensitive: ((key: string) => boolean) | undefined;
  /** True while a redacted value is walked: no text is written or charged, and each value costs one unit of work. */
  discarding: boolean;
}

function emit(walk: Walk, text: string): void {
  if (walk.discarding) {
    return;
  }
  spendText(walk.budget, text.length);
  spendWork(walk.work, text.length);
  walk.out.write(text);
}

function emitString(walk: Walk, text: string): void {
  if (walk.discarding) {
    // A redacted string is neither scanned nor encoded: its one unit was charged when it was read.
    return;
  }
  const encoded = encodeString(text, Math.min(walk.budget.charsLeft, walk.work.unitsLeft), walk.work);
  if (encoded === undefined) {
    exceeded();
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

/**
 * Writes a bigint as a string. Under a redacted key it is not converted at all; otherwise its magnitude is checked by
 * bit length first, so no decimal text longer than what is left of the budgets is ever built.
 */
function emitBigInt(walk: Walk, value: bigint): void {
  if (walk.discarding) {
    return;
  }
  const room = Math.min(walk.budget.charsLeft, walk.work.unitsLeft);
  const magnitude = value < 0n ? -value : value;
  // A magnitude of at least 2^bits has more than `room` decimal digits, so its text cannot fit.
  const bits = Math.max(1, Math.ceil(room / DIGITS_PER_BIT) + 1);
  if (BigInt.asUintN(bits, magnitude) !== magnitude) {
    exceeded();
  }
  emitString(walk, value.toString());
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
    emitBigInt(walk, value);
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
function serializeProperty(walk: Walk, holder: object, key: string, depth: number, before?: () => void): boolean {
  if (walk.discarding) {
    spendWork(walk.work, 1);
  }
  const { original, value } = project(holder, key);
  if (typeof value === "object" && value !== null) {
    before?.();
    serializeNode(walk, value, original, depth);
    return true;
  }
  if (value === undefined || typeof value === "function" || typeof value === "symbol") {
    return false;
  }
  before?.();
  return writePrimitive(walk, value);
}

/**
 * How `node` is printed: "circular" when it is being serialized, its original already has PROJECTION_REPEAT_LIMIT
 * projections open, or its original is capped and already has a projection printed one level deep on the path;
 * "capped" when its original is capped and this projection is printed one level deep; "walk" otherwise.
 */
function classifyNode(walk: Walk, node: object, original: unknown, open: number): "circular" | "capped" | "walk" {
  if (walk.nodes.has(node)) {
    return "circular";
  }
  if (open === 0) {
    return "walk";
  }
  if (open >= PROJECTION_REPEAT_LIMIT) {
    walk.capped.add(original);
    return "circular";
  }
  if (walk.capped.has(original)) {
    return walk.cappedWalks.has(original) ? "circular" : "capped";
  }
  return "walk";
}

/**
 * Serializes an object or array with `node` on the active path, in one pass. A node already on the path is
 * "[Circular]" (where JSON.stringify throws a TypeError). A node produced from an original value that already has
 * PROJECTION_REPEAT_LIMIT projections open is "[Circular]" in place, and that original is capped while it stays open:
 * each later projection of it (such as a finite sibling of the capped branch) is printed, but projections of it nested
 * inside that one are "[Circular]", so a toJSON that branches back to itself cannot multiply the work.
 */
function serializeNode(walk: Walk, node: object, original: unknown, depth: number): void {
  const open = walk.originals.get(original) ?? 0;
  const kind = classifyNode(walk, node, original, open);
  if (kind === "circular") {
    emit(walk, CIRCULAR);
    return;
  }
  if (depth >= MAX_NESTING_DEPTH) {
    exceeded();
  }
  walk.nodes.add(node);
  walk.originals.set(original, open + 1);
  if (kind === "capped") {
    walk.cappedWalks.add(original);
  }
  try {
    if (Array.isArray(node)) {
      serializeArray(walk, node, depth + 1);
    } else {
      serializeObject(walk, node, depth + 1);
    }
  } finally {
    walk.nodes.delete(node);
    if (kind === "capped") {
      walk.cappedWalks.delete(original);
    }
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
 * array whose brackets, separators and one character per item (2n + 1) cannot fit the text budget, or whose items
 * cannot fit the work budget, throws before any index is read. Each index is read once; a dropped item prints null.
 */
function serializeArray(walk: Walk, array: object, depth: number): void {
  const length = toLength(Reflect.get(array, "length"));
  if (length > walk.work.unitsLeft || (!walk.discarding && (length === 0 ? 2 : 2 * length + 1) > walk.budget.charsLeft)) {
    exceeded();
  }
  emit(walk, "[");
  for (let index = 0; index < length; index += 1) {
    if (index > 0) {
      emit(walk, ",");
    }
    if (!serializeProperty(walk, array, String(index), depth)) {
      emit(walk, "null");
    }
  }
  emit(walk, "]");
}

/**
 * Walks the value of a sensitive member without writing it, so its getters and toJSON run in order as in
 * JSON.stringify. Its text is never built: each value in it costs one unit of the work budget, which is never given
 * back. Returns false when JSON drops the member.
 */
function discardProperty(walk: Walk, record: object, name: string, depth: number): boolean {
  const discarding = walk.discarding;
  walk.discarding = true;
  try {
    return serializeProperty(walk, record, name, depth);
  } finally {
    walk.discarding = discarding;
  }
}

/**
 * Bounds a typed array by its internal length before its keys are listed: each index costs TYPED_ARRAY_INDEX_UNITS of
 * work (under a redacted key too), and outside one, an array of numbers whose members (`"0":0` and a separator, 6n + 1
 * characters) cannot fit the text budget throws. Other objects hold their own keys, so listing them is bounded by
 * the memory the value already takes, and they are charged one unit per key once listed.
 */
function boundTypedArray(walk: Walk, record: object): void {
  if (!types.isTypedArray(record)) {
    return;
  }
  const length = Reflect.apply(typedArrayLength, record, []);
  spendWork(walk.work, length * TYPED_ARRAY_INDEX_UNITS);
  // A bigint member can be dropped by a toJSON, so only arrays of numbers are known to print every index.
  const numbers = !types.isBigInt64Array(record) && !types.isBigUint64Array(record);
  if (!walk.discarding && numbers && length > 0 && 6 * length + 1 > walk.budget.charsLeft) {
    exceeded();
  }
}

/**
 * SerializeJSONObject: own enumerable string keys in order, each read once; dropped members are left out. Each key
 * costs one unit of work before any value is read, and a typed array is bounded by its length before its keys are
 * listed. A sensitive member that JSON prints is written as "[REDACTED]".
 */
function serializeObject(walk: Walk, record: object, depth: number): void {
  boundTypedArray(walk, record);
  const names = Object.keys(record);
  spendWork(walk.work, names.length);
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
  for (const name of names) {
    if (!walk.discarding && walk.isSensitive?.(name)) {
      if (discardProperty(walk, record, name, depth)) {
        writeKey(name);
        emit(walk, REDACTED);
      }
    } else {
      serializeProperty(walk, record, name, depth, () => writeKey(name));
    }
  }
  emit(walk, "}");
}

export interface SerializeJsonMemberOptions {
  /** The text budget, charged as text is written. Defaults to a fresh `createDocumentBudget()`. */
  budget?: DocumentBudget;
  /** The work budget, never given back. Defaults to a fresh `createWorkBudget()`. */
  work?: WorkBudget;
  /** Object keys whose values print "[REDACTED]". */
  isSensitive?: (key: string) => boolean;
}

/**
 * Writes the JSON text `JSON.stringify` writes for a value as the member `key` of an object, following its algorithm
 * step by step in a single pass: each member is read once, each getter and toJSON runs exactly as often as
 * JSON.stringify runs it, toJSON (on an object, function or bigint) gets its real key or array index, an array length
 * is converted once, boxed primitives are unwrapped by internal slot, and dropped members are left out or become null
 * in arrays. Only the text is kept, never a copy of the value, and each piece is charged to `budget` at its exact
 * length as it is written.
 *
 * Where JSON.stringify would throw, never finish or exhaust memory, the text stays printable or the call fails with a
 * RangeError, and these are the only divergences:
 * - bigints become strings;
 * - an object or array that is already being serialized prints "[Circular]" (JSON.stringify throws a TypeError);
 * - a toJSON that keeps returning fresh objects leading back to the same original value prints
 *   PROJECTION_REPEAT_LIMIT (64) nested projections and then "[Circular]" in place; while that value stays open, a
 *   later projection of it (a finite sibling of the capped branch) still prints, but projections of it nested inside
 *   that one print "[Circular]"; a finite chain deeper than 64 projections of one value is cut the same way;
 * - nesting deeper than MAX_NESTING_DEPTH (512) objects and arrays throws a RangeError before the next level is read;
 * - text that cannot fit what is left of `budget`, or a walk that cannot fit what is left of `work`, throws a
 *   RangeError; an array checks 2n + 1 characters (and n units of work) before its index 0 is read, a typed array
 *   checks its internal length before its keys are listed, and an object charges one unit per key before any value is
 *   read, so oversized sparse, proxy, typed or generated values fail at once; a bigint is checked by bit length before
 *   its decimal text is built, and not converted under a redacted key. A Proxy's own keys are listed by the engine
 *   (through its ownKeys trap) before they can be charged, so a Proxy is bounded only by the keys its trap returns.
 *
 * With `isSensitive`, every object key below the member that it matches prints "[REDACTED]" when JSON prints the
 * member at all; the key is matched after the holder's toJSON ran, so keys a projection creates are covered too. Its
 * value is still walked in order, so its getters and toJSON run as in JSON.stringify, but no text is built for it:
 * it charges `budget` only for the placeholder, and its walk is charged to `work`.
 *
 * Returns undefined when JSON drops the member (undefined, a function, a symbol, or a `toJSON` that returns one).
 * Throws what JSON.stringify throws, such as a throwing getter or `toJSON`, or a Number box whose `valueOf` returns a
 * bigint. On a throw, `budget` has been charged for part of the text: callers charge a copy and keep it on success.
 */
export function serializeJsonMember(
  key: string,
  value: unknown,
  { budget = createDocumentBudget(), work = createWorkBudget(), isSensitive }: SerializeJsonMemberOptions = {}
): JsonText | undefined {
  const holder = Object.create(null) as Record<string, unknown>;
  holder[key] = value;
  const out = new JsonText();
  const walk: Walk = {
    nodes: new Set(),
    originals: new Map(),
    capped: new Set(),
    cappedWalks: new Set(),
    out,
    budget,
    work,
    isSensitive,
    discarding: false,
  };
  return serializeProperty(walk, holder, key, 0) ? out : undefined;
}

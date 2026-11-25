import { Buffer, constants } from "node:buffer";
import { types } from "node:util";
import { getHeapStatistics } from "node:v8";

const CIRCULAR = '"[Circular]"';
const REDACTED = '"[REDACTED]"';
/**
 * How many projections of one original member value under one member key may be open on the active path at once (see
 * `serializeJsonMember`). toJSON receives only the value and its key, so a projection of the same value for the same
 * key that is already open on the path is the recurrence that makes JSON.stringify recurse until its stack overflows
 * (a toJSON returning fresh objects that lead back to that value under that key). The next such projection past the
 * limit is marked "[Circular]" in place; finite chains up to this depth print exactly as JSON.stringify prints them.
 * The count depends only on the active path, so a sibling projected for another key (one that terminates) prints in
 * full at any depth and in any member order. A toJSON that branches back to itself under several keys is bounded by
 * the text budget (or, under a redacted key, the work budget) and MAX_NESTING_DEPTH instead: its document fails with a
 * RangeError rather than printing.
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
 * The share of the text budget, in keys, that the key lists of the objects open on the active path may hold together
 * once a nested object is listed, but never fewer than MIN_OPEN_KEYS. Each list is a snapshot the walk keeps until it
 * leaves that object (about 8 bytes a key, besides the keys themselves), and a Proxy can return the same list at every
 * level for constant memory of its own, so the lists are bounded together, not one at a time. Every key of an object
 * whose members all print costs at least 5 characters (`"":0` and a separator), so a document that fits never reaches
 * a quarter of its text budget in open keys; only objects with more members that print nothing (dropped or under a
 * redacted key) can. Every listed key is also charged to the work budget (see `enumerableKeys`), so the lists a walk
 * takes in total are bounded by the work allowance, and this bound only limits how many are live at once.
 */
const OPEN_KEYS_SHARE = 4;
/**
 * The open keys always allowed together, however small the text budget (about 1.5 MiB of lists at most): below it, the
 * work allowance alone bounds the lists, so a redacted subtree within that allowance prints its placeholder.
 */
export const MIN_OPEN_KEYS = 65_536;
/**
 * The work units an index of a typed array costs before its keys are listed, printed or not: `Object.keys` creates each
 * index key as a new string (about 32 bytes with its slot) although the array stores its elements outside the heap, so
 * the units bound that allocation. Reading and printing each member is charged as for any other object.
 */
export const TYPED_ARRAY_INDEX_UNITS = 32;

/** Thrown when a value's JSON text, or the work to walk it, cannot fit what is left of a document's budget. */
export class DocumentBudgetExceeded extends RangeError {}

/** How many characters of JSON text one result document may still print. */
export interface DocumentBudget {
  charsLeft: number;
}

/**
 * How much work one result document may still do, in units, separate from its text: each own key of each object
 * listed (when it is listed, before any of its members is read, whether the member then prints, is dropped, is skipped
 * as a symbol or non-enumerable key, or is walked under a redacted key), each array item walked under a redacted key,
 * each code unit scanned in a string found too long to print, TYPED_ARRAY_INDEX_UNITS per typed array index (and per
 * item of an array Node's built-in Buffer toJSON must allocate, see `projectBuffer`), and each character of a segment
 * (details or a diagnostic) that was written and then left out. Each unit is charged once and never given back, also
 * when the value it was charged for fails. Printed text is charged to the text budget; a document that fits lists at
 * most a quarter of its text budget in printed keys, so it prints next to discarded work within this allowance.
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

/**
 * The work budget of a document whose text budget is `limit`: twice as many units as the document has characters, its
 * own allowance next to the text. A segment dropped after it was written costs at most its text, so one dropped
 * segment never spends the whole allowance by itself.
 */
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
const propertyIsEnumerable = Object.prototype.propertyIsEnumerable;
/** Node's built-in `Buffer.prototype.toJSON`, which copies every byte into a new array (see `projectBuffer`). */
const bufferToJSON = Buffer.prototype.toJSON;
/** %Array.prototype%, the prototype of the data array `Buffer.prototype.toJSON` creates. */
const arrayPrototype = Object.getPrototypeOf([]) as object;
const bigintValueOf = BigInt.prototype.valueOf;
/** %TypedArray%.prototype.length: reads the length from the internal slot, for a typed array of any realm. */
const typedArrayLength = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), "length")
  ?.get as () => number;
/** log10(2): the decimal digits each bit of a bigint adds. */
const DIGITS_PER_BIT = Math.log10(2);

interface Walk {
  /** The objects being serialized, as JSON.stringify's stack holds them. */
  readonly nodes: Set<object>;
  /**
   * How many of those objects were produced from each original member value (before its toJSON ran), by the member
   * key it was projected for.
   */
  readonly originals: Map<unknown, Map<string, number>>;
  readonly out: TextSink;
  readonly budget: DocumentBudget;
  readonly work: WorkBudget;
  /** Which object keys print "[REDACTED]" instead of their value, or undefined for none. */
  readonly isSensitive: ((key: string) => boolean) | undefined;
  /**
   * True while a redacted value is walked: no text is written or charged; each array item costs one unit of work and
   * each object member was charged when its key was listed.
   */
  discarding: boolean;
  /** How many keys the key lists of the objects open on the active path hold together (see OPEN_KEYS_SHARE). */
  openKeys: number;
  /** The most keys those lists may hold together when another object on the path is listed. */
  readonly maxOpenKeys: number;
}

function emit(walk: Walk, text: string): void {
  if (walk.discarding) {
    return;
  }
  spendText(walk.budget, text.length);
  walk.out.write(text);
}

function emitString(walk: Walk, text: string): void {
  if (walk.discarding) {
    // A redacted string is neither scanned nor encoded: its one unit was charged when it was read.
    return;
  }
  const encoded = encodeString(text, walk.budget.charsLeft, walk.work);
  if (encoded === undefined) {
    exceeded();
  }
  emit(walk, encoded);
}

function isTracked(value: unknown): value is object {
  return (typeof value === "object" && value !== null) || typeof value === "function";
}

/**
 * The longest string ToNumber is applied to (see `toNumber`). StringToNumber reads the whole string, and the engine
 * flattens a rope first, so a numeric string from user code (an array length, or a Number box's valueOf) is bounded
 * before it is converted. Any finite or infinite Number prints in far fewer characters, padding included.
 */
export const MAX_NUMERIC_STRING_LENGTH = 1024;

/** GetMethod(value, Symbol.toPrimitive): undefined when absent, a TypeError when present but not callable. */
function toPrimitiveMethod(value: object): ((hint: string) => unknown) | undefined {
  const method: unknown = (value as { [Symbol.toPrimitive]?: unknown })[Symbol.toPrimitive];
  if (method === undefined || method === null) {
    return undefined;
  }
  if (typeof method !== "function") {
    throw new TypeError("Cannot convert object to primitive value");
  }
  return method as (hint: string) => unknown;
}

/**
 * ToPrimitive(value, hint), as the engine runs it, in the same order and with the same calls: Symbol.toPrimitive with
 * the hint, otherwise OrdinaryToPrimitive (valueOf then toString for "number", toString then valueOf for "string"). The
 * result is returned unconverted, so the caller bounds a string or bigint before converting it.
 */
function toPrimitive(value: object, hint: "number" | "string"): unknown {
  const exotic = toPrimitiveMethod(value);
  if (exotic !== undefined) {
    const result: unknown = Reflect.apply(exotic, value, [hint]);
    if (isTracked(result)) {
      throw new TypeError("Cannot convert object to primitive value");
    }
    return result;
  }
  for (const name of hint === "number" ? ["valueOf", "toString"] : ["toString", "valueOf"]) {
    const method: unknown = (value as Record<string, unknown>)[name];
    if (typeof method === "function") {
      const result: unknown = Reflect.apply(method, value, []);
      if (!isTracked(result)) {
        return result;
      }
    }
  }
  throw new TypeError("Cannot convert object to primitive value");
}

/**
 * ToNumber with its string operand bounded: an object goes through `toPrimitive` once; a string longer than
 * MAX_NUMERIC_STRING_LENGTH throws a DocumentBudgetExceeded before it is read (a shorter one is charged its length to
 * `work`, when given); a bigint or symbol throws a TypeError, as ToNumber does. The result equals the engine's.
 */
function toNumber(value: unknown, work: WorkBudget | undefined): number {
  const primitive = isTracked(value) ? toPrimitive(value, "number") : value;
  if (typeof primitive === "string") {
    if (primitive.length > MAX_NUMERIC_STRING_LENGTH) {
      exceeded();
    }
    if (work) {
      spendWork(work, primitive.length);
    }
  } else if (typeof primitive === "bigint" || typeof primitive === "symbol") {
    throw new TypeError("Cannot convert a BigInt or Symbol value to a number");
  }
  return Number(primitive);
}

/**
 * ToLength of a value read once as an array's length, as JSON.stringify and iteration apply it (see `toNumber`). An
 * object length runs its Symbol.toPrimitive, or valueOf then toString, once and in that order; a string longer than
 * MAX_NUMERIC_STRING_LENGTH fails with a DocumentBudgetExceeded before it is read; a bigint or symbol throws a
 * TypeError. Internal: not exported from the package.
 */
export function toLength(value: unknown, work?: WorkBudget): number {
  const number = toNumber(value, work);
  if (Number.isNaN(number) || number <= 0) {
    return 0;
  }
  return Math.min(Math.trunc(number), Number.MAX_SAFE_INTEGER);
}

/**
 * Unwraps a boxed primitive by internal slot, in any realm, as JSON.stringify does, running the same user code in the
 * same order but bounding the result before converting it:
 * - a Number box through ToNumber (`toNumber`: a long numeric string fails before it is read, a bigint throws);
 * - a String box through ToString: ToPrimitive with the string hint, then a string is returned as it is (it is bounded
 *   when written), a bigint is returned as a bigint, whose decimal text JSON would print as this string's text, so it
 *   is bounded by bit length when written and never converted under a redacted key (see `emitBigInt`), a symbol
 *   throws, and any other primitive is converted;
 * - a Boolean box and a BigInt box from their slot.
 * Any other object is returned unchanged.
 */
function unbox(walk: Walk, value: object): unknown {
  if (types.isNumberObject(value)) {
    return toNumber(value, walk.work);
  }
  if (types.isStringObject(value)) {
    const primitive = toPrimitive(value, "string");
    if (typeof primitive === "symbol") {
      throw new TypeError("Cannot convert a Symbol value to a string");
    }
    return typeof primitive === "string" || typeof primitive === "bigint" ? primitive : String(primitive);
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
  const room = walk.budget.charsLeft;
  // A magnitude of at least 2^bits has more than `room` decimal digits, so its text cannot fit. The check needs no
  // copy of the value: asIntN keeps `value` unchanged only when -2^bits <= value < 2^bits, for either sign, and its
  // result is at most `bits` bits long.
  const bits = Math.max(1, Math.ceil(room / DIGITS_PER_BIT) + 1);
  if (BigInt.asIntN(bits + 1, value) !== value) {
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

/**
 * Looks `name` up along the prototype chain of `start` without running any code: an own data or accessor descriptor
 * where it is found, `{}` when the chain has no such property, and undefined when a Proxy on the chain would observe
 * the lookup.
 */
function quietLookup(start: object, name: PropertyKey): { descriptor?: PropertyDescriptor } | undefined {
  for (let current: object | null = start; current !== null; current = Reflect.getPrototypeOf(current)) {
    if (types.isProxy(current)) {
      return undefined;
    }
    const descriptor = Reflect.getOwnPropertyDescriptor(current, name);
    if (descriptor !== undefined) {
      return { descriptor };
    }
  }
  return {};
}

/**
 * Stands in for the data array that Node's built-in `Buffer.prototype.toJSON` would build: the bytes are read in place,
 * index by index, when the array is serialized, so nothing proportional to the buffer's length is allocated.
 */
class BufferBytes {
  constructor(
    readonly bytes: object,
    readonly length: number
  ) {}
}
// No toJSON can be found on a stand-in, as none is found on the data array it replaces (see `projectBuffer`).
Object.setPrototypeOf(BufferBytes.prototype, null);
/**
 * The stand-ins created by `projectBuffer`. A node is recognized by membership, which observes nothing of the node:
 * `instanceof` would run the getPrototypeOf trap of every proxied object or array, which JSON.stringify never calls.
 */
const bufferStandIns = new WeakSet<object>();

/**
 * Projects a value whose toJSON is Node's built-in `Buffer.prototype.toJSON`, which copies each of `this.length`
 * items of `this` into a new array and returns `{ type: "Buffer", data }`. Before anything is allocated:
 * - the length it would read must be the internal length of a typed array: `this` is a typed array (not a Proxy) and
 *   its `length` resolves, through a chain without a Proxy, to the built-in getter. Any other receiver (a Proxy, an
 *   object that is not a typed array, a shadowed `length`) cannot be bounded without reading its length a second
 *   time, so it fails with a RangeError;
 * - when the data array would find no `toJSON` (checked on %Array.prototype% and its chain, without running code)
 *   and holds numbers, the projection is an object with the same members whose `data` is a stand-in read from the
 *   buffer in place: it prints exactly what the native array prints, is bounded like any array before its first item
 *   (2n + 1 characters printed, n units of work under a redacted key, decided once the member's key is matched), and
 *   allocates nothing in proportion to n. Reading a typed array's items runs no code, so the output and every
 *   observable step are those of the native call;
 * - otherwise (a bigint typed array, or an inherited `toJSON` that would receive the array) the native toJSON runs,
 *   after its array is charged at TYPED_ARRAY_INDEX_UNITS of work per item, printed or not.
 * Returns undefined when the native toJSON is to run.
 */
function projectBuffer(walk: Walk, value: object): object | undefined {
  const length = types.isTypedArray(value) ? quietLookup(value, "length") : undefined;
  if (length?.descriptor?.get !== typedArrayLength) {
    exceeded();
  }
  const count = Reflect.apply(typedArrayLength, value, []);
  const dataToJSON = quietLookup(arrayPrototype, "toJSON");
  if (dataToJSON !== undefined && dataToJSON.descriptor === undefined && !isBigIntArray(value)) {
    const projection = Object.create(null) as Record<string, unknown>;
    projection.type = "Buffer";
    const bytes = new BufferBytes(value, count);
    bufferStandIns.add(bytes);
    projection.data = bytes;
    return projection;
  }
  if (count * TYPED_ARRAY_INDEX_UNITS > walk.work.unitsLeft) {
    exceeded();
  }
  spendWork(walk.work, count * TYPED_ARRAY_INDEX_UNITS);
  return undefined;
}

function isBigIntArray(value: object): boolean {
  return types.isBigInt64Array(value) || types.isBigUint64Array(value);
}

/** The first steps of SerializeJSONProperty: reads `holder[key]` once, applies its toJSON and unboxes the result. */
function project(walk: Walk, holder: object, key: string): { original: unknown; value: unknown } {
  const original: unknown = Reflect.get(holder, key);
  let value = original;
  if (isTracked(value) || typeof value === "bigint") {
    const toJSON: unknown = (value as { toJSON?: unknown }).toJSON;
    if (typeof toJSON === "function") {
      const standIn = toJSON === bufferToJSON && isTracked(value) ? projectBuffer(walk, value) : undefined;
      value = standIn ?? Reflect.apply(toJSON, value, [key]);
    }
  }
  return { original, value: typeof value === "object" && value !== null ? unbox(walk, value) : value };
}

/** True when JSON drops a projected value: undefined, a function or a symbol. */
function isDropped(value: unknown): boolean {
  return value === undefined || typeof value === "function" || typeof value === "symbol";
}

/** Writes a projected value that JSON prints: an object or array through `serializeNode`, a primitive directly. */
function writeValue(walk: Walk, value: unknown, original: unknown, key: string, depth: number): void {
  if (typeof value === "object" && value !== null) {
    serializeNode(walk, value, original, key, depth);
  } else {
    writePrimitive(walk, value);
  }
}

/**
 * SerializeJSONProperty: reads and projects `holder[key]` once, then, when JSON prints it, calls `writeKey` (which
 * writes an object member's key and says whether its value is redacted) and writes the value. A redacted value prints
 * "[REDACTED]" and is still walked in order, so its getters and toJSON run as in JSON.stringify, but no text is built
 * for it: it costs one unit of work, and so does every value in it (each object member when its key is listed, each
 * array item when it is read). Returns false when JSON drops the member; the key is then neither written nor matched.
 */
function serializeProperty(
  walk: Walk,
  holder: object,
  key: string,
  depth: number,
  writeKey?: () => boolean
): boolean {
  const { original, value } = project(walk, holder, key);
  if (isDropped(value)) {
    return false;
  }
  if (writeKey?.() !== true) {
    writeValue(walk, value, original, key, depth);
    return true;
  }
  emit(walk, REDACTED);
  walk.discarding = true;
  try {
    // The member itself was charged when its key was listed.
    writeValue(walk, value, original, key, depth);
  } finally {
    walk.discarding = false;
  }
  return true;
}

/**
 * Serializes an object or array with `node` on the active path, in one pass. A node already on the path is
 * "[Circular]" (where JSON.stringify throws a TypeError). A node projected from an original value for a member key
 * under which that value already has PROJECTION_REPEAT_LIMIT projections open on the path is "[Circular]" in place:
 * the same value and key recur, so its toJSON would recur without end. Nothing outlives the path, so the output of a
 * member never depends on its siblings or their order.
 */
function serializeNode(walk: Walk, node: object, original: unknown, key: string, depth: number): void {
  let byKey = walk.originals.get(original);
  const open = byKey?.get(key) ?? 0;
  if (walk.nodes.has(node) || open >= PROJECTION_REPEAT_LIMIT) {
    emit(walk, CIRCULAR);
    return;
  }
  if (depth >= MAX_NESTING_DEPTH) {
    exceeded();
  }
  if (byKey === undefined) {
    byKey = new Map();
    walk.originals.set(original, byKey);
  }
  walk.nodes.add(node);
  byKey.set(key, open + 1);
  try {
    if (bufferStandIns.has(node)) {
      const bytes = node as BufferBytes;
      serializeArray(walk, bytes.bytes, depth + 1, bytes.length);
    } else if (Array.isArray(node)) {
      serializeArray(walk, node, depth + 1);
    } else {
      serializeObject(walk, node, depth + 1);
    }
  } finally {
    walk.nodes.delete(node);
    if (open > 0) {
      byKey.set(key, open);
    } else {
      byKey.delete(key);
      if (byKey.size === 0) {
        walk.originals.delete(original);
      }
    }
  }
}

/**
 * SerializeJSONArray: the length is converted once. Every index prints at least one character and a separator, so an
 * array whose brackets, separators and one character per item (2n + 1) cannot fit the text budget, or, under a
 * redacted key, whose items (one unit each) cannot fit the work budget, throws before any index is read. Each index is
 * read once; a dropped item prints null. A Buffer's stand-in passes its `length`, which is then not read.
 */
function serializeArray(walk: Walk, array: object, depth: number, knownLength?: number): void {
  const length = knownLength ?? toLength(Reflect.get(array, "length"), walk.work);
  if (walk.discarding ? length > walk.work.unitsLeft : (length === 0 ? 2 : 2 * length + 1) > walk.budget.charsLeft) {
    exceeded();
  }
  emit(walk, "[");
  for (let index = 0; index < length; index += 1) {
    if (index > 0) {
      emit(walk, ",");
    }
    if (walk.discarding) {
      spendWork(walk.work, 1);
    }
    if (!serializeProperty(walk, array, String(index), depth)) {
      emit(walk, "null");
    }
  }
  emit(walk, "]");
}

/**
 * Bounds a typed array by its internal length before its keys are listed: each index costs TYPED_ARRAY_INDEX_UNITS of
 * work, printed or not, and outside a redacted key an array of numbers whose members (`"0":0` and a separator, 6n + 1
 * characters) cannot fit the text budget throws. A rejected array is charged nothing. Other objects hold their own
 * keys, so listing them is bounded by the memory the value already takes.
 */
function boundTypedArray(walk: Walk, record: object): void {
  if (!types.isTypedArray(record)) {
    return;
  }
  const length = Reflect.apply(typedArrayLength, record, []);
  // A bigint member can be dropped by a toJSON, so only arrays of numbers are known to print every index.
  const numbers = !types.isBigInt64Array(record) && !types.isBigUint64Array(record);
  if (
    length * TYPED_ARRAY_INDEX_UNITS > walk.work.unitsLeft ||
    (!walk.discarding && numbers && length > 0 && 6 * length + 1 > walk.budget.charsLeft)
  ) {
    exceeded();
  }
  spendWork(walk.work, length * TYPED_ARRAY_INDEX_UNITS);
}

/**
 * EnumerableOwnProperties: [[OwnPropertyKeys]] once, then [[GetOwnProperty]] for each string key, as JSON.stringify
 * runs them. Every key listed costs one unit of work at once, never given back, before any descriptor is read: a list
 * longer than the work left throws, and listing the same object again and again stops once the allowance is spent,
 * also when its members then fail. That unit also pays for the member it lists, printed, dropped, skipped (a symbol, a
 * non-enumerable or vanished key) or walked under a redacted key. Only one list of the object's keys is held: for an
 * object that is not a Proxy, which runs no code to report its descriptors, the enumerable string keys are kept in
 * place in the list [[OwnPropertyKeys]] returned. When the lists the objects open on the path hold together already
 * pass the bound of OPEN_KEYS_SHARE, it throws before [[OwnPropertyKeys]] runs.
 */
function enumerableKeys(walk: Walk, record: object): string[] {
  if (walk.openKeys > walk.maxOpenKeys) {
    // The lists its ancestors hold already pass the bound: no further list is taken, not even by a Proxy's trap.
    exceeded();
  }
  const keys = Reflect.ownKeys(record);
  spendWork(walk.work, keys.length);
  const proxy = types.isProxy(record);
  let count = 0;
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    if (
      typeof key === "string" &&
      (proxy
        ? Reflect.getOwnPropertyDescriptor(record, key)?.enumerable === true
        : Reflect.apply(propertyIsEnumerable, record, [key]) === true)
    ) {
      keys[count] = key;
      count += 1;
    }
  }
  keys.length = count;
  return keys as string[];
}

/**
 * SerializeJSONObject: own enumerable string keys in order (see `enumerableKeys`, which charges each listed key one
 * unit of work), each read once; dropped members are left out. A member that prints is charged as text (its key is
 * written before it is matched against `isSensitive`, so the match never scans more than was printed); a member JSON
 * drops prints nothing, its key neither written nor matched. A typed array is bounded by its length before its keys are listed. A sensitive
 * member that JSON prints is written as "[REDACTED]".
 */
function serializeObject(walk: Walk, record: object, depth: number): void {
  boundTypedArray(walk, record);
  const names = enumerableKeys(walk, record);
  walk.openKeys += names.length;
  try {
    serializeMembers(walk, record, names, depth);
  } finally {
    walk.openKeys -= names.length;
  }
}

function serializeMembers(walk: Walk, record: object, names: readonly string[], depth: number): void {
  emit(walk, "{");
  let members = 0;
  for (const name of names) {
    serializeProperty(walk, record, name, depth, () => {
      if (walk.discarding) {
        return false;
      }
      if (members > 0) {
        emit(walk, ",");
      }
      emitString(walk, name);
      emit(walk, ":");
      members += 1;
      return walk.isSensitive?.(name) === true;
    });
  }
  emit(walk, "}");
}

export interface SerializeJsonMemberOptions {
  /** The text budget, charged as text is written. Defaults to a fresh `createDocumentBudget()`. */
  budget?: DocumentBudget;
  /** The work budget for what prints nothing, never given back. Defaults to a fresh `createWorkBudget()`. */
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
 * - a toJSON that keeps returning fresh objects leading back to the same original value under the same member key
 *   prints PROJECTION_REPEAT_LIMIT (64) nested projections for that key and then "[Circular]" in place; a finite
 *   chain deeper than 64 projections of one value for one key is cut the same way. Projections for other keys, such
 *   as a sibling that terminates, print as JSON.stringify prints them, at any depth and in any member order; one
 *   that keeps branching back to the value under new keys fails on the text budget (the work budget under a
 *   redacted key) or the nesting limit;
 * - nesting deeper than MAX_NESTING_DEPTH (512) objects and arrays throws a RangeError before the next level is read;
 * - text that cannot fit what is left of `budget`, or work that cannot fit what is left of `work`, throws a
 *   RangeError. Printed text is charged to `budget` only; `work` pays for each own key listed, each array item under
 *   a redacted key and each scan of a string too long to print (see `WorkBudget`). An array checks 2n + 1 characters
 *   (n units of work under a redacted key) before its index 0 is read, a typed array checks its internal length
 *   before its keys are listed, a Buffer projected by Node's built-in toJSON is read in place and bounded like an
 *   array by its internal length once its key's redaction is known (a receiver whose length cannot be bounded that
 *   way fails, see `projectBuffer`), an object with more own keys than the work left fails before any descriptor or
 *   value is read, and the key lists of the objects open on the path may hold a quarter of the text budget (in keys,
 *   at least MIN_OPEN_KEYS) together, so a nested object below lists that hold more fails before its own keys are
 *   listed (see OPEN_KEYS_SHARE); so oversized sparse, proxy, typed, Buffer, hidden-key or generated values fail at
 *   once, and an object listed again and again stops once its keys have spent the work allowance; a bigint is
 *   checked by bit length before its decimal text is built, and not converted under a redacted key. The engine
 *   builds an object's own key list before it can be counted (a Proxy's from what its ownKeys trap returns, or from
 *   its target when it has no such trap), as JSON.stringify does; only that one list is held.
 *
 * With `isSensitive`, every object key below the member that it matches prints "[REDACTED]" when JSON prints the
 * member at all; the key is matched after the holder's toJSON ran, so keys a projection creates are covered too, and
 * only once the member is known to print (a dropped member's key is never scanned). Its value is still walked in
 * order, so its getters and toJSON run as in JSON.stringify, but no text is built for it: it charges `budget` only
 * for its key and the placeholder, and its walk is charged to `work`, one unit per value (see `WorkBudget`).
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
    out,
    budget,
    work,
    isSensitive,
    discarding: false,
    openKeys: 0,
    maxOpenKeys: Math.max(MIN_OPEN_KEYS, Math.floor(Math.max(0, budget.charsLeft) / OPEN_KEYS_SHARE)),
  };
  return serializeProperty(walk, holder, key, 0) ? out : undefined;
}

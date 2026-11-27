/**
 * Canonical JSON for request fingerprints.
 *
 * It encodes plain JSON data only, as `apifn/contracts` canonical JSON does:
 * strings, finite numbers, booleans, null, plain arrays without holes,
 * undefined items or extra properties, and plain objects (keys sorted by
 * UTF-16 code unit; undefined properties omitted). Anything a JSON serializer
 * would change, collapse or convert (sparse arrays, undefined array items,
 * array subclasses, getters, symbol-keyed or non-enumerable members, Dates,
 * Buffers, Maps, class instances, any object with `toJSON`, non-finite
 * numbers, bigint, functions, symbols, cycles) is rejected, so two different request bodies can never share a
 * fingerprint. Hosts pass the validated, parsed JSON body.
 *
 * Error messages name the depth and array indexes only, never object member
 * names, because a body's keys can themselves be sensitive.
 */

const MAX_DEPTH = 256;

/** Encodes plain JSON data canonically; throws a TypeError for anything else. */
export function canonicalJson(value: unknown): string {
  return encode(value, 0, new Set());
}

function where(depth: number, index?: number): string {
  return index === undefined ? `at depth ${depth}` : `at array index ${index} (depth ${depth})`;
}

function encode(value: unknown, depth: number, ancestors: Set<object>): string {
  if (depth > MAX_DEPTH) throw new TypeError(`canonicalJson: value is nested deeper than ${MAX_DEPTH} levels`);
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) throw new TypeError(`canonicalJson: non-finite number ${where(depth)}`);
      return JSON.stringify(value);
    case "object":
      return encodeObject(value, depth, ancestors);
    default:
      throw new TypeError(`canonicalJson: ${typeof value} ${where(depth)} is not JSON data`);
  }
}

/** Reads an own data property; a getter or setter is not plain data. */
function dataValue(target: object, key: string, location: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(target, key);
  if (!descriptor || !("value" in descriptor)) throw new TypeError(`canonicalJson: accessor property ${location} is not plain JSON data`);
  return descriptor.value;
}

/**
 * Whether `toJSON` is a function or an accessor anywhere on the prototype
 * chain. Descriptors are read, so a getter is never invoked.
 */
function hasToJsonHook(value: object): boolean {
  for (let target: object | null = value; target !== null; target = Object.getPrototypeOf(target) as object | null) {
    const descriptor = Object.getOwnPropertyDescriptor(target, "toJSON");
    if (descriptor) return !("value" in descriptor) || typeof descriptor.value === "function";
  }
  return false;
}

function encodeArray(value: unknown[], depth: number, ancestors: Set<object>): string {
  if (Object.getPrototypeOf(value) !== Array.prototype) throw new TypeError(`canonicalJson: array subclass ${where(depth)} is not plain JSON data`);
  // The length is read once, so nothing can extend the walk.
  const length = value.length;
  // Own keys other than the indexes and length (named members, symbols) would be lost by a serializer.
  if (Reflect.ownKeys(value).length !== length + 1) {
    throw new TypeError(`canonicalJson: sparse array or array with extra properties ${where(depth)}`);
  }
  const items: string[] = [];
  for (let index = 0; index < length; index += 1) {
    if (!Object.hasOwn(value, index)) throw new TypeError(`canonicalJson: sparse array hole ${where(depth + 1, index)}`);
    const item = dataValue(value, String(index), where(depth + 1, index));
    if (item === undefined) throw new TypeError(`canonicalJson: undefined array item ${where(depth + 1, index)}`);
    items.push(encode(item, depth + 1, ancestors));
  }
  return `[${items.join(",")}]`;
}

function encodeObject(value: object, depth: number, ancestors: Set<object>): string {
  if (ancestors.has(value)) throw new TypeError(`canonicalJson: cycle ${where(depth)}`);
  // A toJSON hook would let two different values share one encoding (Date and its ISO string).
  if (hasToJsonHook(value)) {
    throw new TypeError(`canonicalJson: object with toJSON ${where(depth)} is not plain JSON data`);
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) return encodeArray(value, depth, ancestors);
    const prototype: unknown = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError(`canonicalJson: non-plain object ${where(depth)}`);
    }
    // Every own key is read, so a symbol or non-enumerable member a serializer would skip is rejected, not lost.
    const keys: string[] = [];
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key === "symbol") throw new TypeError(`canonicalJson: symbol-keyed property ${where(depth + 1)} is not plain JSON data`);
      if (!Object.getOwnPropertyDescriptor(value, key)?.enumerable) {
        throw new TypeError(`canonicalJson: non-enumerable property ${where(depth + 1)} is not plain JSON data`);
      }
      keys.push(key);
    }
    const entries: string[] = [];
    for (const key of keys.sort(compareCodeUnits)) {
      const item = dataValue(value, key, where(depth + 1));
      if (item !== undefined) entries.push(`${JSON.stringify(key)}:${encode(item, depth + 1, ancestors)}`);
    }
    return `{${entries.join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}

function compareCodeUnits(left: string, right: string): number {
  if (left < right) return -1;
  return left > right ? 1 : 0;
}

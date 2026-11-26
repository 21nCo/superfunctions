/**
 * Canonical JSON for request fingerprints.
 *
 * Two values that JSON-serialize to the same document produce the same string,
 * independent of object key order. It follows `JSON.stringify` semantics for
 * `toJSON` (called per value with its key), omitted object properties and
 * array holes (encoded as `null`). Values that JSON would silently change or
 * collapse (non-finite numbers, bigint, functions, symbols, Map/Set and other
 * class instances, cycles) are rejected, so two different request bodies can
 * never share a fingerprint because one of them lost information.
 */

const MAX_DEPTH = 256;

/** Encodes a JSON value canonically. A top-level `undefined` encodes as `null`. */
export function canonicalJson(value: unknown): string {
  return encode(value, "", 0, new Set()) ?? "null";
}

/** Returns undefined when JSON would omit the value (an object property) or write `null` (an array item). */
function encode(input: unknown, key: string, depth: number, ancestors: Set<object>): string | undefined {
  if (depth > MAX_DEPTH) throw new TypeError(`canonicalJson: value is nested deeper than ${MAX_DEPTH} levels`);
  let value = input;
  if (typeof value === "object" && value !== null) {
    const toJSON = (value as { toJSON?: unknown }).toJSON;
    if (typeof toJSON === "function") {
      value = toJSON.call(value, key);
      if (value === input) throw new TypeError("canonicalJson: toJSON returned its own object");
    }
  }
  if (value === undefined) return undefined;
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) throw new TypeError("canonicalJson: numbers must be finite");
      return JSON.stringify(value);
    case "object":
      return encodeObject(value, depth, ancestors);
    default:
      throw new TypeError(`canonicalJson: ${typeof value} values are not JSON`);
  }
}

function encodeObject(value: object, depth: number, ancestors: Set<object>): string {
  if (ancestors.has(value)) throw new TypeError("canonicalJson: value contains a cycle");
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const items: string[] = [];
      // An index loop visits holes, which JSON writes as null.
      for (let index = 0; index < value.length; index += 1) {
        items.push(encode(value[index], String(index), depth + 1, ancestors) ?? "null");
      }
      return `[${items.join(",")}]`;
    }
    const prototype: unknown = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("canonicalJson: only plain objects, arrays and JSON primitives are supported");
    }
    const entries: string[] = [];
    for (const key of Object.keys(value).sort(compareCodeUnits)) {
      const item = encode((value as Record<string, unknown>)[key], key, depth + 1, ancestors);
      if (item !== undefined) entries.push(`${JSON.stringify(key)}:${item}`);
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

/**
 * Canonical JSON for request fingerprints.
 *
 * Two values that JSON-serialize to the same document produce the same string,
 * independent of object key order. Values that JSON would silently change or
 * collapse (non-finite numbers, bigint, functions, symbols, Map/Set and other
 * class instances, cycles) are rejected, so two different request bodies can
 * never share a fingerprint because one of them lost information.
 */

const MAX_DEPTH = 256;

export function canonicalJson(value: unknown): string {
  return encode(value === undefined ? null : value, 0, new Set());
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
  const toJSON = (value as { toJSON?: unknown }).toJSON;
  if (typeof toJSON === "function") {
    const replaced: unknown = toJSON.call(value);
    if (replaced === value) throw new TypeError("canonicalJson: toJSON returned its own object");
    return encode(replaced === undefined ? null : replaced, depth + 1, ancestors);
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const items = value.map((item: unknown) =>
        item === undefined ? "null" : encode(item, depth + 1, ancestors),
      );
      return `[${items.join(",")}]`;
    }
    const prototype: unknown = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("canonicalJson: only plain objects, arrays and JSON primitives are supported");
    }
    const entries: string[] = [];
    for (const key of Object.keys(value).sort(compareCodeUnits)) {
      const item = (value as Record<string, unknown>)[key];
      if (item === undefined) continue;
      entries.push(`${JSON.stringify(key)}:${encode(item, depth + 1, ancestors)}`);
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

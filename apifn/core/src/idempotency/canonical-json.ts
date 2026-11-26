/**
 * Canonical JSON for request fingerprints.
 *
 * It encodes plain JSON data only, as `apifn/contracts` canonical JSON does:
 * strings, finite numbers, booleans, null, arrays without holes or undefined
 * items, and plain objects (keys sorted by UTF-16 code unit; undefined
 * properties omitted). Anything a JSON serializer would change, collapse or
 * convert (sparse arrays, undefined array items, Dates, Buffers, Maps, class
 * instances, any object with `toJSON`, non-finite numbers, bigint, functions,
 * symbols, cycles) is rejected, so two different request bodies can never
 * share a fingerprint. Hosts pass the validated, parsed JSON body.
 */

const MAX_DEPTH = 256;

/** Encodes plain JSON data canonically; throws a TypeError for anything else. */
export function canonicalJson(value: unknown): string {
  return encode(value, "", 0, new Set());
}

function encode(value: unknown, path: string, depth: number, ancestors: Set<object>): string {
  if (depth > MAX_DEPTH) throw new TypeError(`canonicalJson: value is nested deeper than ${MAX_DEPTH} levels`);
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) throw new TypeError(`canonicalJson: non-finite number at ${path || "/"}`);
      return JSON.stringify(value);
    case "object":
      return encodeObject(value, path, depth, ancestors);
    default:
      throw new TypeError(`canonicalJson: ${typeof value} at ${path || "/"} is not JSON data`);
  }
}

function encodeObject(value: object, path: string, depth: number, ancestors: Set<object>): string {
  if (ancestors.has(value)) throw new TypeError(`canonicalJson: cycle at ${path || "/"}`);
  // A toJSON hook would let two different values share one encoding (Date and its ISO string).
  if (typeof (value as { toJSON?: unknown }).toJSON === "function") throw new TypeError(`canonicalJson: object with toJSON at ${path || "/"} is not plain JSON data`);
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const items: string[] = [];
      // The length is read once, so a getter that grows the array cannot extend the walk.
      const length = value.length;
      for (let index = 0; index < length; index += 1) {
        if (!Object.hasOwn(value, index)) throw new TypeError(`canonicalJson: sparse array hole at ${path}/${index}`);
        const item: unknown = value[index];
        if (item === undefined) throw new TypeError(`canonicalJson: undefined array item at ${path}/${index}`);
        items.push(encode(item, `${path}/${index}`, depth + 1, ancestors));
      }
      return `[${items.join(",")}]`;
    }
    const prototype: unknown = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError(`canonicalJson: non-plain object at ${path || "/"}`);
    }
    const record = value as Record<string, unknown>;
    const entries: string[] = [];
    for (const key of Object.keys(record).sort(compareCodeUnits)) {
      const item = record[key];
      if (item !== undefined) entries.push(`${JSON.stringify(key)}:${encode(item, `${path}/${key}`, depth + 1, ancestors)}`);
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

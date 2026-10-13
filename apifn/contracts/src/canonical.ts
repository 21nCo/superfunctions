// Canonical JSON and SHA-256 digests. Pure JavaScript so the same bytes and
// digests are produced in Node, browsers and edge runtimes without node:crypto.

/** Compares strings by UTF-16 code unit, independent of the host locale. */
export function compareCodeUnits(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

/** A UTF-16 surrogate without its pair: ill-formed Unicode, which has no UTF-8 encoding (RFC 8785 rejects it). */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

function serializeString(value: string, path: string, what: string): string {
  // The message names where, never the string itself, so it stays well-formed.
  if (LONE_SURROGATE.test(value)) throw new TypeError(`Cannot canonicalize ill-formed Unicode (a lone surrogate) in ${what} at ${path || "/"}`);
  return JSON.stringify(value);
}

function serialize(value: unknown, path: string): string {
  if (typeof value === "string") return serializeString(value, path, "a string");
  if (value === null || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError(`Cannot canonicalize non-finite number at ${path}`);
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    // Every index, holes included: map would skip a hole and emit "[1,,3]", or "[]" for new Array(1).
    // The length is read once, so an element getter that grows the array cannot extend the walk.
    const items: string[] = [];
    const length = value.length;
    for (let index = 0; index < length; index += 1) {
      if (!Object.hasOwn(value, index)) throw new TypeError(`Cannot canonicalize a sparse array hole at ${path}/${index}`);
      items.push(serialize(value[index], `${path}/${index}`));
    }
    return `[${items.join(",")}]`;
  }
  if (typeof value === "object") {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
      throw new TypeError(`Cannot canonicalize non-plain object at ${path}`);
    }
    // Serialized by hand: JSON.stringify would emit integer-like keys first
    // and an object literal would turn an own "__proto__" key into a prototype.
    const record = value as Record<string, unknown>;
    const members: string[] = [];
    for (const key of Object.keys(record).sort(compareCodeUnits)) {
      if (record[key] !== undefined) {
        members.push(`${serializeString(key, path, "a member name")}:${serialize(record[key], `${path}/${key}`)}`);
      }
    }
    return `{${members.join(",")}}`;
  }
  throw new TypeError(`Cannot canonicalize ${typeof value} at ${path}`);
}

/**
 * Serializes plain JSON data with object keys sorted by UTF-16 code unit (as
 * in RFC 8785) and no insignificant whitespace. Undefined object members are
 * omitted.
 */
export function canonicalJson(value: unknown): string {
  return serialize(value, "");
}

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function rotr(value: number, bits: number): number {
  return (value >>> bits) | (value << (32 - bits));
}

/** Returns the lowercase hex SHA-256 of the UTF-8 encoding of `input`. */
export function sha256Hex(input: string): string {
  const bytes = new TextEncoder().encode(input);
  const bitLength = bytes.length * 8;
  const padded = new Uint8Array((((bytes.length + 9 + 63) >> 6) << 6));
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor(bitLength / 0x100000000));
  view.setUint32(padded.length - 4, bitLength >>> 0);

  const hash = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const w = new Uint32Array(64);
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let i = 0; i < 16; i += 1) w[i] = view.getUint32(offset + i * 4);
    for (let i = 16; i < 64; i += 1) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = hash;
    for (let i = 0; i < 64; i += 1) {
      const t1 = (h + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + w[i]) >>> 0;
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    hash[0] += a;
    hash[1] += b;
    hash[2] += c;
    hash[3] += d;
    hash[4] += e;
    hash[5] += f;
    hash[6] += g;
    hash[7] += h;
  }
  return Array.from(hash, (word) => word.toString(16).padStart(8, "0")).join("");
}

/** `sha256:<hex>` digest of the canonical JSON form of `value`. */
export function canonicalDigest(value: unknown): string {
  return `sha256:${sha256Hex(canonicalJson(value))}`;
}

/** One reason a value is not plain, bounded JSON data, at a JSON pointer. */
export interface SnapshotProblem {
  pointer: string;
  reason: string;
  /** True when a size limit was exceeded (reported at the root); reading stopped there. */
  limit?: boolean;
}

export interface PlainSnapshot {
  value: unknown;
  /** Where the input is not plain JSON data: Maps, Dates, class instances, functions, cycles, or past the limits. */
  problems: SnapshotProblem[];
}

/**
 * Nesting limit for every input the contracts read. The catalog builder
 * accepts documents a few levels shallower (see buildOperationCatalog), so
 * every catalog it builds is also accepted as release input.
 */
export const MAX_JSON_DEPTH = 256;
/** Upper bound on values copied from one input, so shared references cannot expand without limit. */
export const MAX_JSON_VALUES = 1_000_000;
/** Reading stops after this many problems, so a report stays small however malformed the input is. */
export const MAX_SNAPSHOT_PROBLEMS = 32;

/** Thrown inside snapshotPlainData to stop reading once a budget is spent. */
class StopReading {}

/**
 * Copies plain JSON-like data, reading each own enumerable property exactly
 * once, so a validator checks and returns the same values even when the input
 * has getters or proxies. Arrays and plain objects are copied; anything else
 * that is not JSON data is reported in `problems` and left out. A reference
 * back to an enclosing object is a cycle; other shared references are copied
 * per path. Cost is bounded before any other check runs: reading stops at
 * {@link MAX_JSON_VALUES} values (an array's length is checked before it is
 * read, so sparse arrays cost nothing), at `maxBytes` (a lower bound on the
 * UTF-8 size of the canonical JSON, counted as keys and strings are read) and
 * after {@link MAX_SNAPSHOT_PROBLEMS} problems. Throws only when reading the
 * input throws.
 */
export function snapshotPlainData(input: unknown, options: { maxDepth?: number; maxBytes?: number } = {}): PlainSnapshot {
  const maxDepth = options.maxDepth ?? MAX_JSON_DEPTH;
  const maxBytes = options.maxBytes ?? Number.POSITIVE_INFINITY;
  const problems: SnapshotProblem[] = [];
  const ancestors = new Set<object>();
  let values = 0;
  let bytes = 0;
  const problem = (pointer: string, reason: string): undefined => {
    problems.push({ pointer, reason });
    if (problems.length >= MAX_SNAPSHOT_PROBLEMS) throw new StopReading();
    return undefined;
  };
  const limit = (reason: string): never => {
    problems.push({ pointer: "", reason, limit: true });
    throw new StopReading();
  };
  // Every serialized byte counted here is also in the canonical JSON: UTF-16 units never outnumber UTF-8 bytes.
  const spend = (count: number, size: number) => {
    values += count;
    bytes += size;
    if (bytes > maxBytes) limit(`exceeds ${maxBytes} bytes when serialized`);
    if (values > MAX_JSON_VALUES) limit(`exceeds ${MAX_JSON_VALUES} values`);
  };
  const copy = (value: unknown, pointer: string, depth: number): unknown => {
    if (typeof value === "function" || typeof value === "symbol" || typeof value === "bigint") {
      return problem(pointer, `is a ${typeof value}, not JSON data`);
    }
    if (typeof value === "string") spend(1, value.length + 2);
    else if (typeof value === "number") spend(1, String(value).length);
    else if (typeof value === "boolean" || value === null) spend(1, 4);
    if (typeof value !== "object" || value === null) return value;
    if (ancestors.has(value)) return problem(pointer, "refers back to an enclosing object (a cycle)");
    if (depth >= maxDepth) return problem(pointer, `nests deeper than ${maxDepth} levels`);
    const array = Array.isArray(value);
    const proto = Object.getPrototypeOf(value);
    if (!array && proto !== Object.prototype && proto !== null) {
      return problem(pointer, "must be plain JSON data, not a Map, Date or class instance");
    }
    ancestors.add(value);
    let output: unknown;
    if (array) {
      const length = value.length;
      // Each item is at least one value and one byte (its comma or bracket).
      spend(1 + length, 1 + length);
      const items: unknown[] = [];
      for (let index = 0; index < length; index += 1) items.push(copy(value[index], `${pointer}/${index}`, depth + 1));
      output = items;
    } else {
      spend(1, 2);
      const record: Record<string, unknown> = {};
      for (const key of Object.keys(value)) {
        const raw = (value as Record<string, unknown>)[key];
        // A member is counted before its key is used, so an oversize key stops reading here; undefined members are not serialized.
        if (raw !== undefined) spend(0, key.length + 3);
        const child = copy(raw, `${pointer}/${key.replace(/~/g, "~0").replace(/\//g, "~1")}`, depth + 1);
        // defineProperty keeps an own "__proto__" key as data.
        if (child !== undefined) Object.defineProperty(record, key, { value: child, enumerable: true, writable: true, configurable: true });
      }
      output = record;
    }
    ancestors.delete(value);
    return output;
  };
  try {
    return { value: copy(input, "", 0), problems };
  } catch (error) {
    if (error instanceof StopReading) return { value: undefined, problems };
    throw error;
  }
}

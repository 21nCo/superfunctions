// Canonical JSON and SHA-256 digests. Pure JavaScript so the same bytes and
// digests are produced in Node, browsers and edge runtimes without node:crypto.

/** Compares strings by UTF-16 code unit, independent of the host locale. */
export function compareCodeUnits(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function serialize(value: unknown, path: string): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError(`Cannot canonicalize non-finite number at ${path}`);
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item, index) => serialize(item, `${path}/${index}`)).join(",")}]`;
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
        members.push(`${JSON.stringify(key)}:${serialize(record[key], `${path}/${key}`)}`);
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

export interface PlainSnapshot {
  value: unknown;
  /** JSON pointers of values that are not plain data (Maps, Dates, class instances, cycles). */
  nonPlain: string[];
}

const MAX_SNAPSHOT_DEPTH = 32;

/**
 * Copies plain JSON-like data, reading each own enumerable property exactly
 * once, so a validator checks and returns the same values even when the input
 * has getters or proxies. Arrays and plain objects are copied; other objects
 * are reported in `nonPlain` and left out; primitives are kept as they are.
 * Throws only when reading the input throws.
 */
export function snapshotPlainData(input: unknown): PlainSnapshot {
  const nonPlain: string[] = [];
  const copy = (value: unknown, path: string, depth: number): unknown => {
    if (typeof value !== "object" || value === null) return value;
    if (depth > MAX_SNAPSHOT_DEPTH) {
      nonPlain.push(path);
      return undefined;
    }
    if (Array.isArray(value)) {
      const length = value.length;
      const items: unknown[] = [];
      for (let index = 0; index < length; index += 1) items.push(copy(value[index], `${path}/${index}`, depth + 1));
      return items;
    }
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
      nonPlain.push(path);
      return undefined;
    }
    const output: Record<string, unknown> = {};
    for (const key of Object.keys(value)) {
      const child = copy((value as Record<string, unknown>)[key], `${path}/${key.replace(/~/g, "~0").replace(/\//g, "~1")}`, depth + 1);
      // defineProperty keeps an own "__proto__" key as data.
      Object.defineProperty(output, key, { value: child, enumerable: true, writable: true, configurable: true });
    }
    return output;
  };
  return { value: copy(input, "", 0), nonPlain };
}

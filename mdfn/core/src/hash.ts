const OFFSET = 0xcbf29ce484222325n;
const PRIME = 0x100000001b3n;
const MASK = 0xffffffffffffffffn;

export function hashString(value: string): string {
  let hash = OFFSET;
  const bytes = new TextEncoder().encode(value);
  for (const byte of bytes) {
    hash ^= BigInt(byte);
    hash = (hash * PRIME) & MASK;
  }
  return `fnv1a64:${hash.toString(16).padStart(16, "0")}`;
}

function stableValue(value: unknown, seen: WeakSet<object>): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "bigint") return String(value);
  if (typeof value === "undefined" || typeof value === "function" || typeof value === "symbol") return null;
  if (Array.isArray(value)) return value.map((entry) => stableValue(entry, seen));
  if (typeof value !== "object") return String(value);
  if (seen.has(value)) throw new TypeError("Cannot hash a cyclic value");
  seen.add(value);
  const output = Object.fromEntries(
    Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => [key, stableValue((value as Record<string, unknown>)[key], seen)]),
  );
  seen.delete(value);
  return output;
}

export function hashValue(value: unknown): string {
  return hashString(JSON.stringify(stableValue(value, new WeakSet())));
}

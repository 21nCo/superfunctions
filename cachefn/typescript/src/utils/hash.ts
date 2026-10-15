/**
 * Fast hash function for key generation
 */

/**
 * Simple hash function (FNV-1a)
 */
export function hash(str: string): string {
  let hash = 2166136261;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash +=
      (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
  }
  return (hash >>> 0).toString(36);
}

/**
 * Hash function arguments for memoization
 */
export function hashArgs(args: any[]): string {
  const active = new Set<object>();
  const encode = (value: unknown): unknown => {
    if (value === null) return ["null"];
    switch (typeof value) {
      case "undefined": return ["undefined"];
      case "boolean": return ["boolean", value];
      case "string": return ["string", value];
      case "bigint": return ["bigint", String(value)];
      case "number": return ["number", Object.is(value, -0) ? "-0" : String(value)];
      case "object": {
        if (active.has(value)) throw new TypeError("Cyclic arguments require a custom keyGenerator");
        active.add(value);
        try {
          if (value instanceof Date) return ["date", value.toISOString()];
          if (Array.isArray(value)) {
            return ["array", Array.from({length: value.length}, (_, i) =>
              i in value ? encode(value[i]) : ["hole"])];
          }
          if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
            throw new TypeError("Non-plain objects require a custom keyGenerator");
          }
          if (Object.getOwnPropertySymbols(value).length) {
            throw new TypeError("Symbol keys require a custom keyGenerator");
          }
          return ["object", Object.keys(value).sort().map(key => [key, encode((value as Record<string, unknown>)[key])])];
        } finally { active.delete(value); }
      }
      default: throw new TypeError("Functions and symbols require a custom keyGenerator");
    }
  };
  // Keep the canonical representation: a short non-cryptographic hash can
  // collide and return a result computed for different arguments.
  return JSON.stringify(encode(args));
}

/**
 * Generate a cache key from arguments
 */
export function generateKey(prefix: string, args: any[]): string {
  if (args.length === 0) {
    return prefix;
  }
  return `${prefix}:${hashArgs(args)}`;
}

/** JSON-safe snapshots without losing repeated (non-cyclic) references. */
export function safeSerialize(value: any, maxDepth = 10): any {
  if (!Number.isInteger(maxDepth) || maxDepth < 0) throw new RangeError("maxDepth must be a nonnegative integer");
  const ancestors = new WeakSet<object>();
  function serialize(item: any, depth: number): any {
    if (depth > maxDepth) return "[Max Depth Reached]";
    if (item === null || item === undefined) return item;
    if (typeof item === "string" || typeof item === "boolean") return item;
    if (typeof item === "number") return Number.isFinite(item) ? item : null;
    if (typeof item === "bigint" || typeof item === "symbol") return String(item);
    if (typeof item === "function") return "[Function]";
    if (item instanceof Date) return Number.isFinite(item.getTime()) ? item.toISOString() : null;
    if (item instanceof RegExp) return String(item);
    if (ancestors.has(item)) return "[Circular Reference]";
    ancestors.add(item);
    try {
      if (Array.isArray(item)) return item.map((entry) => serialize(entry, depth + 1));
      const result: Record<string, any> = {};
      const keys = item instanceof Error ? [...new Set(["name", "message", "stack", ...Object.getOwnPropertyNames(item)])] : Object.keys(item);
      for (const key of keys) {
        let entry: any;
        try { entry = serialize(item[key], depth + 1); } catch { entry = "[Unserializable]"; }
        Object.defineProperty(result, key, { value: entry, enumerable: true, writable: true, configurable: true });
      }
      return result;
    } finally { ancestors.delete(item); }
  }
  return serialize(value, 0);
}

export function serializeError(error: Error): Record<string, any> {
  return safeSerialize(error);
}

/** Count actual UTF-8 bytes; an unserializable value must never look empty. */
export function estimateSize(value: any): number {
  const json = JSON.stringify(safeSerialize(value));
  return new TextEncoder().encode(json ?? "null").byteLength;
}

export function truncateString(value: string, maxLength: number): string {
  if (!Number.isInteger(maxLength) || maxLength < 0) throw new RangeError("maxLength must be nonnegative");
  if (value.length <= maxLength) return value;
  return maxLength <= 3 ? value.slice(0, maxLength) : value.slice(0, maxLength - 3) + "...";
}

export function trimArray<T>(values: T[], maxSize: number): T[] {
  if (!Number.isInteger(maxSize) || maxSize < 0) throw new RangeError("maxSize must be nonnegative");
  return maxSize === 0 ? [] : values.slice(-maxSize);
}

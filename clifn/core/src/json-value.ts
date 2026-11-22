/** Turns a value into one `JSON.stringify` accepts: bigints become strings and cycles become "[Circular]". */
export function normalizeJsonValue(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === "bigint") {
    return value.toString();
  }

  if (Array.isArray(value)) {
    if (seen.has(value)) {
      return "[Circular]";
    }

    seen.add(value);
    try {
      return value.map((item) => normalizeJsonValue(item, seen));
    } finally {
      seen.delete(value);
    }
  }

  if (value && typeof value === "object") {
    if (seen.has(value)) {
      return "[Circular]";
    }

    seen.add(value);
    try {
      if (typeof (value as { toJSON?: () => unknown }).toJSON === "function") {
        return normalizeJsonValue((value as { toJSON: () => unknown }).toJSON(), seen);
      }

      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([key, nested]) => [
          key,
          normalizeJsonValue(nested, seen),
        ])
      );
    } finally {
      seen.delete(value);
    }
  }

  return value;
}

/**
 * Resolves a value to the plain JSON value that `JSON.stringify` writes for it as the member `key` of an object:
 * it is normalized first, any `toJSON` left (on a function or an array subclass) is called with that key, and the
 * result is parsed back, so it holds only JSON values and serializing it again calls no user code. Returns
 * undefined when JSON drops the member (undefined, a function, a symbol). Throws when the value cannot be serialized.
 */
export function resolveJsonMember(key: string, value: unknown): unknown {
  const text = JSON.stringify({ [key]: normalizeJsonValue(value) });
  const parsed = JSON.parse(text) as Record<string, unknown>;
  return Object.prototype.hasOwnProperty.call(parsed, key) ? parsed[key] : undefined;
}

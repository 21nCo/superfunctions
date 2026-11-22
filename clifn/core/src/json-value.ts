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

function resolveProperty(key: string, value: unknown, seen: WeakSet<object>): unknown {
  let current = value;

  // As JSON.stringify does: an object, function or bigint with a callable toJSON is replaced by its result for this
  // member key or array index, and boxed primitives are unwrapped.
  if ((typeof current === "object" && current !== null) || typeof current === "function" || typeof current === "bigint") {
    const toJSON = (current as { toJSON?: unknown }).toJSON;
    if (typeof toJSON === "function") {
      current = toJSON.call(current, key);
    }
  }
  if (current instanceof Number) {
    current = Number(current);
  } else if (current instanceof String) {
    current = String(current);
  } else if (current instanceof Boolean || current instanceof BigInt) {
    current = current.valueOf();
  }

  if (current === null || typeof current === "boolean" || typeof current === "string") {
    return current;
  }
  if (typeof current === "number") {
    return Number.isFinite(current) ? current : null;
  }
  if (typeof current === "bigint") {
    return current.toString();
  }
  if (typeof current !== "object") {
    // undefined, a function or a symbol: JSON drops the member.
    return undefined;
  }

  if (seen.has(current)) {
    return "[Circular]";
  }
  seen.add(current);
  try {
    if (Array.isArray(current)) {
      const items: unknown[] = [];
      for (let index = 0; index < current.length; index += 1) {
        const item = resolveProperty(String(index), current[index], seen);
        items.push(item === undefined ? null : item);
      }
      return items;
    }

    const record = current as Record<string, unknown>;
    const entries: Array<[string, unknown]> = [];
    for (const name of Object.keys(record)) {
      const nested = resolveProperty(name, record[name], seen);
      if (nested !== undefined) {
        entries.push([name, nested]);
      }
    }
    return Object.fromEntries(entries);
  } finally {
    seen.delete(current);
  }
}

/**
 * Resolves a value to the plain JSON value that `JSON.stringify` writes for it as the member `key` of an object.
 * It walks the original value as `JSON.stringify` does, so every `toJSON` (on an object, function, array or bigint,
 * at any depth) runs once with its real member key or array index; bigints become strings and cycles become
 * "[Circular]", as in `normalizeJsonValue`. The result is built from fresh plain objects and arrays, so redacting it
 * and serializing it again calls no user code. Returns undefined when JSON drops the member (undefined, a function,
 * a symbol, or a `toJSON` that returns one). Throws when a getter or `toJSON` throws.
 */
export function resolveJsonMember(key: string, value: unknown): unknown {
  return resolveProperty(key, value, new WeakSet<object>());
}

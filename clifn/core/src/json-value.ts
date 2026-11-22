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

const CIRCULAR = "[Circular]";
const numberValueOf = Number.prototype.valueOf;
const stringValueOf = String.prototype.valueOf;
const booleanValueOf = Boolean.prototype.valueOf;
const bigintValueOf = BigInt.prototype.valueOf;

type ActivePath = WeakSet<object>;

function isTracked(value: unknown): value is object {
  return (typeof value === "object" && value !== null) || typeof value === "function";
}

/** As JSON.stringify does: an object, function or bigint with a callable toJSON is replaced by its result for `key`. */
function applyToJSON(key: string, value: unknown): unknown {
  if (isTracked(value) || typeof value === "bigint") {
    const toJSON = (value as { toJSON?: unknown }).toJSON;
    if (typeof toJSON === "function") {
      return Reflect.apply(toJSON, value, [key]);
    }
  }
  return value;
}

/** True when `value` has the internal slot that `valueOf` brand-checks, in any realm. */
function hasPrimitiveSlot(valueOf: () => unknown, value: object): boolean {
  try {
    Reflect.apply(valueOf, value, []);
    return true;
  } catch {
    return false;
  }
}

/**
 * Unwraps a boxed primitive as JSON.stringify does, by internal slot rather than prototype: a Number or String box is
 * coerced (honouring its own valueOf or toString), a Boolean box gives its slot value and a BigInt box its bigint.
 */
function unbox(value: object): unknown {
  if (hasPrimitiveSlot(numberValueOf, value)) {
    return Number(value);
  }
  if (hasPrimitiveSlot(stringValueOf, value)) {
    return String(value);
  }
  if (hasPrimitiveSlot(booleanValueOf, value)) {
    return Reflect.apply(booleanValueOf, value, []);
  }
  if (hasPrimitiveSlot(bigintValueOf, value)) {
    return Reflect.apply(bigintValueOf, value, []);
  }
  return value;
}

/** A non-object value as JSON writes it; undefined when JSON drops the member (undefined, a function, a symbol). */
function resolveScalar(value: unknown): unknown {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return value;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  return undefined;
}

function resolveArray(array: readonly unknown[], path: ActivePath): unknown[] {
  // The length is read once, as JSON.stringify does, so a getter or toJSON that resizes the array cannot change it.
  const length = array.length;
  const items: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const item = resolveProperty(String(index), array[index], path);
    items.push(item === undefined ? null : item);
  }
  return items;
}

function resolveRecord(record: Record<string, unknown>, path: ActivePath): Record<string, unknown> {
  const entries: Array<[string, unknown]> = [];
  for (const name of Object.keys(record)) {
    const nested = resolveProperty(name, record[name], path);
    if (nested !== undefined) {
      entries.push([name, nested]);
    }
  }
  return Object.fromEntries(entries);
}

function resolveProperty(key: string, value: unknown, path: ActivePath): unknown {
  // Both the original value and its toJSON projection stay on the active path while their members resolve, so a
  // node whose toJSON returns a fresh copy of itself still ends in "[Circular]"; leaving the path on exit keeps
  // repeated acyclic references intact.
  if (isTracked(value) && path.has(value)) {
    return CIRCULAR;
  }
  let current = applyToJSON(key, value);
  if (typeof current === "object" && current !== null) {
    current = unbox(current);
  }
  if (typeof current !== "object" || current === null) {
    return resolveScalar(current);
  }
  if (path.has(current)) {
    return CIRCULAR;
  }

  const added = [value, current].filter((item): item is object => isTracked(item) && !path.has(item));
  for (const item of added) {
    path.add(item);
  }
  try {
    return Array.isArray(current)
      ? resolveArray(current, path)
      : resolveRecord(current as Record<string, unknown>, path);
  } finally {
    for (const item of added) {
      path.delete(item);
    }
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

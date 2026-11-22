import { types } from "node:util";

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
const bigintValueOf = BigInt.prototype.valueOf;

/** An object JSON.stringify is serializing, with the original member value and key it came from. */
interface Frame {
  readonly node: object;
  readonly original: unknown;
  readonly key: string;
}

/** The member value as stored, read without running a getter; undefined when it cannot be read that way. */
function storedValue(holder: object, key: string): unknown {
  try {
    const descriptor = Reflect.getOwnPropertyDescriptor(holder, key);
    return descriptor && "value" in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A JSON.stringify replacer that keeps the active path of the objects being serialized. It runs after the native
 * toJSON call, so it sees each projection with its real key; bigints and BigInt boxes become strings. An object is
 * "[Circular]" when it is already being serialized higher up (where JSON.stringify throws a TypeError), or when the
 * same original value is reached again under the same member key (a toJSON that keeps returning fresh copies, which
 * JSON.stringify would follow until its stack overflows).
 */
function createReplacer(): (this: object, key: string, value: unknown) => unknown {
  const path: Frame[] = [];
  return function replacer(this: object, key: string, value: unknown): unknown {
    while (path.length > 0 && path[path.length - 1].node !== this) {
      path.pop();
    }
    if (typeof value === "bigint") {
      return value.toString();
    }
    if (typeof value !== "object" || value === null) {
      return value;
    }
    if (types.isBigIntObject(value)) {
      return (Reflect.apply(bigintValueOf, value, []) as bigint).toString();
    }
    const original = storedValue(this, key);
    const repeated = path.some(
      (frame) => frame.node === value || (frame.key === key && frame.original === original && original !== undefined)
    );
    if (repeated) {
      return CIRCULAR;
    }
    path.push({ node: value, original, key });
    return value;
  };
}

/**
 * Resolves a value to the plain JSON value that `JSON.stringify` writes for it as the member `key` of an object.
 * The walk is native `JSON.stringify` itself (toJSON calls with their real key or index, array lengths, boxed
 * primitives, dropped members), with two extensions: bigints (and BigInt boxes) become strings, and cycles become
 * "[Circular]", as in `normalizeJsonValue`. The result is parsed back into fresh plain objects and arrays, so
 * redacting it and serializing it again calls no user code. Returns undefined when JSON drops the member
 * (undefined, a function, a symbol, or a `toJSON` that returns one). Throws whatever `JSON.stringify` throws for the
 * value, such as a throwing getter or `toJSON`, or a boxed number whose `valueOf` returns a bigint.
 */
export function resolveJsonMember(key: string, value: unknown): unknown {
  const holder = Object.create(null) as Record<string, unknown>;
  holder[key] = value;
  const text = JSON.stringify(holder, createReplacer());
  return (JSON.parse(text) as Record<string, unknown>)[key];
}

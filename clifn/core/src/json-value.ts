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
/** How often one original value may recur on the active path before the first pass stops (see `resolveJsonMember`). */
const REPEAT_LIMIT = 64;
const booleanValueOf = Boolean.prototype.valueOf;
const bigintValueOf = BigInt.prototype.valueOf;

/** Thrown inside the first pass when a value keeps coming back through fresh toJSON projections. */
class UnboundedProjection extends Error {}

interface Walk {
  /** The objects being serialized, as JSON.stringify's stack holds them. */
  readonly nodes: Set<object>;
  /** How many of those objects were produced from each original member value (before its toJSON ran). */
  readonly originals: Map<unknown, number>;
  /** The first pass allows REPEAT_LIMIT recurrences and then stops; the second pass marks the first one. */
  readonly repeatLimit: number;
}

function isTracked(value: unknown): value is object {
  return (typeof value === "object" && value !== null) || typeof value === "function";
}

/** ToLength, as JSON.stringify applies it to an array's length; unary plus is ToNumber, so a bigint throws. */
function toLength(value: unknown): number {
  const number = +(value as number);
  if (Number.isNaN(number) || number <= 0) {
    return 0;
  }
  return Math.min(Math.trunc(number), Number.MAX_SAFE_INTEGER);
}

/**
 * Unwraps a boxed primitive by internal slot, in any realm, as JSON.stringify does: a Number box through ToNumber
 * (unary plus, which throws when its valueOf returns a bigint), a String box through ToString, a Boolean box and a
 * BigInt box from their slot. Any other object is returned unchanged.
 */
function unbox(value: object): unknown {
  if (types.isNumberObject(value)) {
    return +value;
  }
  if (types.isStringObject(value)) {
    return String(value);
  }
  if (types.isBooleanObject(value)) {
    return Reflect.apply(booleanValueOf, value, []);
  }
  if (types.isBigIntObject(value)) {
    return Reflect.apply(bigintValueOf, value, []);
  }
  return value;
}

/** SerializeJSONProperty: the JSON value of `holder[key]`, or undefined when JSON drops the member. */
function serializeProperty(walk: Walk, holder: object, key: string): unknown {
  const original: unknown = Reflect.get(holder, key);
  let value = original;
  if (isTracked(value) || typeof value === "bigint") {
    const toJSON: unknown = (value as { toJSON?: unknown }).toJSON;
    if (typeof toJSON === "function") {
      value = Reflect.apply(toJSON, value, [key]);
    }
  }
  if (typeof value === "object" && value !== null) {
    value = unbox(value);
  }
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return value;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (typeof value !== "object") {
    return undefined;
  }
  return serializeNode(walk, value, original);
}

/**
 * Serializes an object or array with `node` on the active path. A node already on the path is "[Circular]" (where
 * JSON.stringify throws a TypeError). A node produced again from an original value that is already on the path
 * comes from a toJSON that returns fresh objects: the first pass lets it recur as JSON.stringify would, and the
 * second pass marks it "[Circular]".
 */
function serializeNode(walk: Walk, node: object, original: unknown): unknown {
  if (walk.nodes.has(node)) {
    return CIRCULAR;
  }
  const repeats = walk.originals.get(original) ?? 0;
  if (repeats >= walk.repeatLimit) {
    if (walk.repeatLimit === 1) {
      return CIRCULAR;
    }
    throw new UnboundedProjection();
  }
  walk.nodes.add(node);
  walk.originals.set(original, repeats + 1);
  try {
    return Array.isArray(node) ? serializeArray(walk, node) : serializeObject(walk, node);
  } finally {
    walk.nodes.delete(node);
    if (repeats === 0) {
      walk.originals.delete(original);
    } else {
      walk.originals.set(original, repeats);
    }
  }
}

/** SerializeJSONArray: the length is converted once; each index is read once and a dropped item becomes null. */
function serializeArray(walk: Walk, array: object): unknown[] {
  const length = toLength(Reflect.get(array, "length"));
  const items: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const item = serializeProperty(walk, array, String(index));
    items.push(item === undefined ? null : item);
  }
  return items;
}

/** SerializeJSONObject: own enumerable string keys in order, each read once; dropped members are left out. */
function serializeObject(walk: Walk, record: object): Record<string, unknown> {
  const entries: Array<[string, unknown]> = [];
  for (const name of Object.keys(record)) {
    const member = serializeProperty(walk, record, name);
    if (member !== undefined) {
      entries.push([name, member]);
    }
  }
  return Object.fromEntries(entries);
}

function resolveWith(repeatLimit: number, key: string, value: unknown): unknown {
  const holder = Object.create(null) as Record<string, unknown>;
  holder[key] = value;
  return serializeProperty(createWalk(repeatLimit), holder, key);
}

function createWalk(repeatLimit: number): Walk {
  return { nodes: new Set(), originals: new Map(), repeatLimit };
}

/**
 * Resolves a value to the plain JSON value that `JSON.stringify` writes for it as the member `key` of an object,
 * following its algorithm step by step: each member is read once, toJSON (on an object, function or bigint) runs
 * with its real key or array index, an array length is converted once, boxed primitives are unwrapped by internal
 * slot, and dropped members are left out or become null in arrays. Two extensions keep every value printable:
 * bigints become strings, and cycles become "[Circular]", as in `normalizeJsonValue`. When a toJSON keeps returning
 * fresh objects that lead back to the same original value (where JSON.stringify would recurse until its stack
 * overflows), the walk stops and runs once more, marking the first recurrence "[Circular]"; only then do getters
 * and toJSON methods run a second time. The result is built from fresh plain objects and arrays, so redacting it
 * and serializing it again calls no user code. Returns undefined when JSON drops the member (undefined, a function,
 * a symbol, or a `toJSON` that returns one). Throws what JSON.stringify throws, such as a throwing getter or
 * `toJSON`, or a Number box whose `valueOf` returns a bigint.
 */
export function resolveJsonMember(key: string, value: unknown): unknown {
  try {
    return resolveWith(REPEAT_LIMIT, key, value);
  } catch (error) {
    if (!(error instanceof UnboundedProjection)) {
      throw error;
    }
  }
  return resolveWith(1, key, value);
}

/**
 * Bounded, JSON-safe snapshots of captured values.
 *
 * The closed set of forms:
 * - JSON primitives (strings, finite numbers, booleans, null) are kept;
 * - `Error` becomes `{ name, message, stack, ...own properties }`;
 * - plain objects and arrays are copied, at most {@link MAX_DEPTH} container
 *   levels deep (deeper containers become `"[Max Depth]"`) and with at most
 *   {@link MAX_KEYS} keys or items each;
 * - a container that refers back to one of its ancestors becomes `"[Circular]"`;
 * - DOM nodes become `"<tag#id.class>"`;
 * - everything else (undefined, NaN, bigint, symbol, functions, Date, Map,
 *   class instances, ...) becomes `String(value)`.
 *
 * One entry never exceeds {@link MAX_ENTRY_BYTES} bytes of UTF-8 JSON: strings
 * are cut, and containers stop adding keys or items once the next one would
 * not fit and record the cut with a `"[Truncated]"` marker.
 */

export type SerializedValue =
  | string
  | number
  | boolean
  | null
  | SerializedValue[]
  | { [key: string]: SerializedValue };

export const MAX_DEPTH = 5;
export const MAX_KEYS = 200;
export const MAX_ENTRY_BYTES = 10 * 1024;

export const CIRCULAR = "[Circular]";
export const MAX_DEPTH_MARKER = "[Max Depth]";
export const TRUNCATED = "[Truncated]";
export const UNSERIALIZABLE = "[Unserializable]";

// Room kept at each open container for its truncation marker, so a cut never
// pushes the entry past the byte limit. The longest marker is the object form
// `,"[Truncated]":"200 more"`, well under this.
const MARKER_RESERVE = 32;
const STRING_SUFFIX = "…" + TRUNCATED;

const encoder = new TextEncoder();

export function utf8Length(text: string): number {
  return encoder.encode(text).byteLength;
}

function jsonBytes(value: string | number | boolean | null): number {
  return utf8Length(JSON.stringify(value));
}

/**
 * Cut `value` so that its JSON string form fits in `maxBytes`, without
 * splitting a surrogate pair. Returns undefined when not even the cut marker
 * fits.
 */
export function truncateToBytes(value: string, maxBytes: number): string | undefined {
  // UTF-8 never uses fewer bytes than UTF-16 units, so skip encoding a string
  // that cannot fit anyway.
  if (value.length + 2 <= maxBytes && jsonBytes(value) <= maxBytes) return value;
  if (jsonBytes(STRING_SUFFIX) > maxBytes) return undefined;
  // Every character costs at least one byte, so no longer prefix can fit.
  let low = 0;
  let high = Math.min(value.length, maxBytes);
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (jsonBytes(cut(value, mid) + STRING_SUFFIX) <= maxBytes) low = mid;
    else high = mid - 1;
  }
  return cut(value, low) + STRING_SUFFIX;
}

function cut(value: string, length: number): string {
  const code = value.charCodeAt(length - 1);
  // Never end on the first half of a surrogate pair.
  return code >= 0xd800 && code <= 0xdbff ? value.slice(0, length - 1) : value.slice(0, length);
}

function safeString(value: unknown): string {
  try {
    return String(value);
  } catch {
    return UNSERIALIZABLE;
  }
}

interface DomNodeLike {
  nodeType: number;
  nodeName: string;
  id?: unknown;
  getAttribute?: unknown;
}

function isDomNode(value: object): value is DomNodeLike {
  const node = value as Partial<DomNodeLike>;
  return typeof node.nodeType === "number" && typeof node.nodeName === "string";
}

/** `<tag#id.class>` for elements, `<#text>`-style names for other nodes. */
export function describeDomNode(node: DomNodeLike): string {
  const ELEMENT_NODE = 1;
  if (node.nodeType !== ELEMENT_NODE) return `<${node.nodeName.toLowerCase()}>`;
  let text = node.nodeName.toLowerCase();
  if (typeof node.id === "string" && node.id) text += `#${node.id}`;
  const classes = typeof node.getAttribute === "function" ? (node.getAttribute as (name: string) => unknown).call(node, "class") : undefined;
  if (typeof classes === "string") {
    for (const name of classes.split(/\s+/)) if (name) text += `.${name}`;
  }
  return `<${text}>`;
}

function isPlainObject(value: object): boolean {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

interface Sized {
  value: SerializedValue;
  bytes: number;
}

function leaf(value: string | number | boolean | null, budget: number): Sized | undefined {
  if (typeof value === "string") {
    const text = truncateToBytes(value, budget);
    return text === undefined ? undefined : { value: text, bytes: jsonBytes(text) };
  }
  const bytes = jsonBytes(value);
  return bytes <= budget ? { value, bytes } : undefined;
}

function defineEntry(target: Record<string, SerializedValue>, key: string, value: SerializedValue): void {
  // A captured own `__proto__` key must stay data, never become a prototype.
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
}

function errorKeys(error: Error): string[] {
  return [...new Set(["name", "message", "stack", ...Object.getOwnPropertyNames(error)])];
}

function readProperty(source: object, key: string): unknown {
  try {
    return (source as Record<string, unknown>)[key];
  } catch {
    return UNSERIALIZABLE;
  }
}

/**
 * Serialize one entry under the closed set and the per-entry caps.
 *
 * `rootDepth` is the container level the value itself occupies; collectors
 * pass 0 for an argument list so that each argument keeps all five levels.
 */
export function serializeEntry(value: unknown, rootDepth = 1): SerializedValue {
  const ancestors = new Set<object>();

  function visit(item: unknown, depth: number, budget: number): Sized | undefined {
    if (item === null) return leaf(null, budget);
    switch (typeof item) {
      case "string":
      case "boolean":
        return leaf(item, budget);
      case "number":
        return leaf(Number.isFinite(item) ? item : String(item), budget);
      case "object":
        return visitObject(item, depth, budget);
      default:
        return leaf(safeString(item), budget);
    }
  }

  function visitObject(item: object, depth: number, budget: number): Sized | undefined {
    let kind: "array" | "error" | "object" | "dom" | "other";
    try {
      kind = Array.isArray(item)
        ? "array"
        : item instanceof Error
          ? "error"
          : isPlainObject(item)
            ? "object"
            : isDomNode(item)
              ? "dom"
              : "other";
    } catch {
      return leaf(UNSERIALIZABLE, budget);
    }
    if (kind === "dom") {
      try {
        return leaf(describeDomNode(item as DomNodeLike), budget);
      } catch {
        return leaf(UNSERIALIZABLE, budget);
      }
    }
    if (kind === "other") return leaf(safeString(item), budget);
    if (ancestors.has(item)) return leaf(CIRCULAR, budget);
    if (depth > MAX_DEPTH) return leaf(MAX_DEPTH_MARKER, budget);
    if (budget < 2 + MARKER_RESERVE) return undefined;
    ancestors.add(item);
    try {
      return kind === "array" ? visitArray(item as unknown[], depth, budget) : visitRecord(item, kind === "error", depth, budget);
    } finally {
      ancestors.delete(item);
    }
  }

  function visitArray(items: unknown[], depth: number, budget: number): Sized {
    const result: SerializedValue[] = [];
    let bytes = 2;
    let length: number;
    try {
      length = items.length;
    } catch {
      length = 0;
    }
    const limit = Math.min(length, MAX_KEYS);
    let truncated = length > limit;
    for (let index = 0; index < limit; index += 1) {
      const separator = index > 0 ? 1 : 0;
      const child = visit(readProperty(items, String(index)), depth + 1, budget - bytes - separator - MARKER_RESERVE);
      if (!child) {
        truncated = true;
        break;
      }
      result.push(child.value);
      bytes += separator + child.bytes;
    }
    if (truncated) {
      bytes += (result.length > 0 ? 1 : 0) + jsonBytes(TRUNCATED);
      result.push(TRUNCATED);
    }
    return { value: result, bytes };
  }

  function visitRecord(source: object, isError: boolean, depth: number, budget: number): Sized {
    const result: Record<string, SerializedValue> = {};
    let bytes = 2;
    let keys: string[];
    try {
      keys = isError ? errorKeys(source as Error) : Object.keys(source);
    } catch {
      keys = [];
    }
    const limit = Math.min(keys.length, MAX_KEYS);
    let written = 0;
    for (let index = 0; index < limit; index += 1) {
      const key = keys[index] as string;
      const keyBytes = (written > 0 ? 1 : 0) + jsonBytes(key) + 1;
      const child = visit(readProperty(source, key), depth + 1, budget - bytes - keyBytes - MARKER_RESERVE);
      if (!child) break;
      defineEntry(result, key, child.value);
      bytes += keyBytes + child.bytes;
      written += 1;
    }
    const omitted = keys.length - written;
    if (omitted > 0) {
      const marker = `${omitted} more`;
      bytes += (written > 0 ? 1 : 0) + jsonBytes(TRUNCATED) + 1 + jsonBytes(marker);
      defineEntry(result, TRUNCATED, marker);
    }
    return { value: result, bytes };
  }

  const sized = visit(value, rootDepth, MAX_ENTRY_BYTES);
  return sized ? sized.value : TRUNCATED;
}

/** Serialize a value under the closed set. Alias of {@link serializeEntry}. */
export function safeSerialize(value: unknown): SerializedValue {
  return serializeEntry(value);
}

/** Cut a string to at most `maxLength` UTF-16 units, ending in "..." when cut. */
export function truncateString(value: string, maxLength: number): string {
  if (!Number.isInteger(maxLength) || maxLength < 0) throw new RangeError("maxLength must be a nonnegative integer");
  if (value.length <= maxLength) return value;
  return maxLength <= 3 ? value.slice(0, maxLength) : value.slice(0, maxLength - 3) + "...";
}

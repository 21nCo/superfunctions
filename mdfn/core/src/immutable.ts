import type { MdfnDocument } from "./types";

// Only values detached recursively by this module may be reused safely.
const immutableValues = new WeakSet<object>();

function detachAndDeepFreeze<T>(value: T, seen: WeakMap<object, unknown>): T {
  if (value === null || typeof value !== "object") return value;
  if (immutableValues.has(value)) return value;
  const existing = seen.get(value);
  if (existing) return existing as T;

  if (Array.isArray(value)) {
    const detached: unknown[] = [];
    seen.set(value, detached);
    for (const entry of value) detached.push(detachAndDeepFreeze(entry, seen));
    immutableValues.add(detached);
    return Object.freeze(detached) as T;
  }

  const detached: Record<string, unknown> = {};
  seen.set(value, detached);
  for (const [key, entry] of Object.entries(value)) {
    Object.defineProperty(detached, key, { value: detachAndDeepFreeze(entry, seen), enumerable: true, writable: true, configurable: true });
  }
  immutableValues.add(detached);
  return Object.freeze(detached) as T;
}

export function immutableValue<T>(value: T): T {
  return detachAndDeepFreeze(value, new WeakMap<object, unknown>());
}

export function immutableDocument(document: MdfnDocument): MdfnDocument {
  return immutableValue(document);
}

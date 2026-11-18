/**
 * Platform getters and methods, captured so that observation reads the
 * application's events and values without running a getter or method the page
 * patches later. Used by the error and WebSocket collectors.
 */

export type Intrinsic = (...values: unknown[]) => unknown;

/** Marks a value observation may not read without running application code. */
export const UNREADABLE: unique symbol = Symbol("unreadable");

export const { apply } = Reflect;
export const platform = globalThis as Record<string, unknown>;

export function prototypeOf(constructor: unknown): object | undefined {
  return typeof constructor === "function" ? (constructor.prototype as object) : undefined;
}

/** A prototype's own getter (or, with "value", method). */
export function intrinsic(prototype: object | undefined, key: PropertyKey, kind: "get" | "value" = "get"): Intrinsic | undefined {
  const found: unknown = prototype && Object.getOwnPropertyDescriptor(prototype, key)?.[kind];
  return typeof found === "function" ? (found as Intrinsic) : undefined;
}

/**
 * Reads a platform attribute through its captured getter, whose brand check
 * also rejects anything that is not that platform object: unreadable then.
 */
export function platformRead(get: Intrinsic | undefined, target: unknown): unknown {
  if (!get || typeof target !== "object" || target === null) return UNREADABLE;
  try {
    return apply(get, target, []);
  } catch {
    return UNREADABLE;
  }
}

/** An own data property's value; a getter or an absent key is unreadable. */
export function dataValue(target: object, key: PropertyKey): unknown {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(target, key);
    return descriptor && "value" in descriptor ? descriptor.value : UNREADABLE;
  } catch {
    return UNREADABLE; // A throwing Proxy trap.
  }
}

/**
 * A platform attribute through its captured getter. Only where the platform
 * has no such getter (a runtime without the class) is it read from an own
 * data property of that name; an object the getter rejects is unreadable.
 */
export function attribute(get: Intrinsic | undefined, target: unknown, key: string): unknown {
  if (get) return platformRead(get, target);
  if (typeof target !== "object" || target === null) return UNREADABLE;
  return dataValue(target, key);
}

const EVENT_TARGET_PROTOTYPE = prototypeOf(platform.EventTarget);
export const ADD_LISTENER = intrinsic(EVENT_TARGET_PROTOTYPE, "addEventListener", "value");
export const REMOVE_LISTENER = intrinsic(EVENT_TARGET_PROTOTYPE, "removeEventListener", "value");

/** Adds a listener through the captured `addEventListener`; false when `target` is not an event target. */
export function listen(target: unknown, type: string, listener: (event: unknown) => void): boolean {
  if (!ADD_LISTENER) return false;
  try {
    apply(ADD_LISTENER, target, [type, listener]);
    return true;
  } catch {
    return false;
  }
}

/** Removes a listener added with {@link listen}. */
export function unlisten(target: unknown, type: string, listener: (event: unknown) => void): void {
  if (!REMOVE_LISTENER) return;
  try {
    apply(REMOVE_LISTENER, target, [type, listener]);
  } catch {
    /* Nothing more to undo. */
  }
}

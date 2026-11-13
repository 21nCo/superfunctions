import { EVIDENCE_SCHEMA_VERSION, freezeEvent, takeSeq, type NetworkEvidenceEvent, type NetworkTransport } from "../events.js";
import { redactHeaders, redactUrl } from "../utils/redaction.js";
import { RingBuffer, assertCapacity, type CollectWindow } from "../utils/ring-buffer.js";
import { MAX_ENTRY_BYTES, serializeEntry, truncateToBytes } from "../utils/serialization.js";

export type IgnorePattern = string | RegExp;

export interface NetworkCollectorOptions {
  /** Record only requests whose redacted URL matches one of these. */
  allowUrls?: IgnorePattern[];
  /** Never record requests whose redacted URL matches one of these. */
  blockUrls?: IgnorePattern[];
  /** Keep only these headers (case-insensitive). */
  allowedHeaders?: string[];
  /** Drop these headers (case-insensitive). */
  blockedHeaders?: string[];
}

/** What a wrapper observed, already redacted and bounded. */
interface Observation {
  transport: NetworkTransport;
  method: string;
  url: string;
  timestamp: number;
  status?: number;
  statusText?: string;
  duration?: number;
  requestHeaders?: Record<string, string>;
  responseHeaders?: Record<string, string>;
}

type Listener = (observation: Observation) => void;

/** The method and URL of an XMLHttpRequest's current open(). */
interface XhrRecord {
  method: string;
  url: string;
}

let listeners = new Set<Listener>();
let restore: (() => void) | undefined;

/** Recorded for a request URL that is not a string, `URL` or `Request`. */
export const UNREAD_URL = "[UNREAD_URL]";
/** Recorded for a request method that is not a string data value. */
export const UNREAD_METHOD = "[UNREAD_METHOD]";
const MAX_HEADER_PAIRS = 200;

/** Marks a value observation may not read without running application code. */
const UNREADABLE: unique symbol = Symbol("unreadable");
/** A read value, or {@link UNREADABLE}. */
type Field = unknown;

// The intrinsics a plain array uses when the platform iterates it.
const ARRAY_ITERATOR = Array.prototype[Symbol.iterator];
const ARRAY_ITERATOR_NEXT = Object.getPrototypeOf([][Symbol.iterator]()).next as unknown;

function text(value: string): string {
  return truncateToBytes(value, MAX_ENTRY_BYTES) ?? "";
}

function captureUrl(url: string): string {
  return url === UNREAD_URL ? url : text(redactUrl(url));
}

/** An own data property's value; a getter, a hole or an absent key is unreadable. */
function dataValue(target: object, key: PropertyKey): Field {
  const descriptor = Object.getOwnPropertyDescriptor(target, key);
  return descriptor && "value" in descriptor ? descriptor.value : UNREADABLE;
}

/**
 * A `RequestInit` member as the platform would see it, read without running a
 * getter: undefined when absent, unreadable when it is an accessor or is
 * inherited (the platform would read the inherited value, observation does not).
 */
function optionField(target: object, key: string): Field {
  const descriptor = Object.getOwnPropertyDescriptor(target, key);
  if (descriptor) return "value" in descriptor ? descriptor.value : UNREADABLE;
  return key in target ? UNREADABLE : undefined;
}

function isInstance(value: unknown, constructor: unknown): value is object {
  return typeof constructor === "function" && typeof value === "object" && value !== null && value instanceof constructor;
}

/** Reads a platform attribute through the platform's own getter, never an override. */
function platformRead(constructor: unknown, key: string, target: object): Field {
  if (typeof constructor !== "function") return UNREADABLE;
  const get = Object.getOwnPropertyDescriptor(constructor.prototype, key)?.get;
  return get ? get.call(target) : UNREADABLE;
}

/** An array the platform iterates with the built-in array iterator. */
function isPlainArray(value: unknown): value is unknown[] {
  return (
    Array.isArray(value) &&
    Object.getPrototypeOf(value) === Array.prototype &&
    Object.getOwnPropertyDescriptor(value, Symbol.iterator) === undefined &&
    Array.prototype[Symbol.iterator] === ARRAY_ITERATOR &&
    Object.getPrototypeOf([][Symbol.iterator]()).next === ARRAY_ITERATOR_NEXT
  );
}

/** Pairs of a platform `Headers` that is not a subclass, read through the platform's `forEach`. */
function platformHeaderPairs(value: Headers): Array<[string, string]> | undefined {
  // A subclass or an own iterator may make the platform send other pairs.
  if (Object.getPrototypeOf(value) !== Headers.prototype || Object.getOwnPropertyDescriptor(value, Symbol.iterator)) return undefined;
  const pairs: Array<[string, string]> = [];
  Headers.prototype.forEach.call(value, (entry: string, name: string) => {
    if (pairs.length <= MAX_HEADER_PAIRS) pairs.push([name, entry]);
  });
  return pairs.length > MAX_HEADER_PAIRS ? undefined : pairs;
}

/** Pairs of a plain array of `[name, value]` string pairs, read by index from own data properties. */
function arrayHeaderPairs(value: unknown[]): Array<[string, string]> | undefined {
  const length = dataValue(value, "length");
  if (typeof length !== "number" || length > MAX_HEADER_PAIRS) return undefined;
  const pairs: Array<[string, string]> = [];
  for (let index = 0; index < length; index += 1) {
    const pair = dataValue(value, index);
    if (!isPlainArray(pair) || dataValue(pair, "length") !== 2) return undefined;
    const name = dataValue(pair, 0);
    const entry = dataValue(pair, 1);
    if (typeof name !== "string" || typeof entry !== "string") return undefined;
    pairs.push([name, entry]);
  }
  return pairs;
}

/** Pairs of a plain record whose enumerable own properties are string data values. */
function recordHeaderPairs(value: object): Array<[string, string]> | undefined {
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== null && (prototype !== Object.prototype || Symbol.iterator in Object.prototype)) return undefined;
  const keys = Reflect.ownKeys(value);
  if (keys.length > MAX_HEADER_PAIRS) return undefined;
  const pairs: Array<[string, string]> = [];
  for (const key of keys) {
    if (typeof key !== "string") return undefined; // The platform rejects a symbol key.
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable) continue; // The platform skips it too.
    if (!("value" in descriptor) || typeof descriptor.value !== "string") return undefined;
    pairs.push([key, descriptor.value]);
  }
  return pairs;
}

/**
 * Copies header pairs out of a `HeadersInit` without invoking any application
 * iterator, getter or conversion: a platform `Headers` object, a plain array
 * of string pairs or a plain record of strings, each capped at
 * {@link MAX_HEADER_PAIRS}. Anything else (a generator, `Map.entries()`, an
 * accessor, a non-string value, ...) is left unread and yields undefined.
 */
function readHeaderPairs(value: Field): Array<[string, string]> | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  if (typeof Headers === "function" && isInstance(value, Headers)) return platformHeaderPairs(value as Headers);
  if (isPlainArray(value)) return arrayHeaderPairs(value);
  return recordHeaderPairs(value);
}

function captureHeaders(value: Field): Record<string, string> | undefined {
  if (typeof Headers !== "function") return undefined;
  try {
    const pairs = readHeaderPairs(value);
    if (!pairs) return undefined;
    // Headers built from our own copy validates and normalizes the names.
    const result: Record<string, string> = {};
    new Headers(pairs).forEach((entry, name) => {
      Object.defineProperty(result, name, { value: entry, enumerable: true, writable: true, configurable: true });
    });
    // A plain record of strings serializes to a record of (possibly cut) strings.
    return serializeEntry(redactHeaders(result)) as Record<string, string>;
  } catch {
    return undefined; // Unreadable or invalid headers: record the request without them.
  }
}

/**
 * The address of a platform `URL`, through the platform's `href` getter. Its
 * brand check runs no application code, not even a Proxy trap; anything that
 * is not a platform `URL` is unread.
 */
function platformHref(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || typeof URL !== "function") return undefined;
  try {
    const href = Object.getOwnPropertyDescriptor(URL.prototype, "href")?.get?.call(value);
    return typeof href === "string" ? href : undefined;
  } catch {
    return undefined; // Not a platform URL.
  }
}

/**
 * A URL string, a platform `URL` or, for fetch, a platform `Request`;
 * anything else is recorded as {@link UNREAD_URL}.
 */
function inputUrl(input: unknown, allowRequest = true): string {
  if (typeof input === "string") return input;
  const href = platformHref(input);
  if (href !== undefined) return href;
  if (!allowRequest) return UNREAD_URL;
  try {
    const url = typeof Request === "function" && isInstance(input, Request) ? platformRead(Request, "url", input) : UNREADABLE;
    return typeof url === "string" ? url : UNREAD_URL;
  } catch {
    return UNREAD_URL;
  }
}

/** Method and headers of a platform `Request` input, through the platform's getters. */
function requestDefaults(input: unknown): { method: Field; headers: Field } {
  if (typeof Request !== "function" || !isInstance(input, Request)) return { method: "GET", headers: UNREADABLE };
  try {
    return { method: platformRead(Request, "method", input), headers: platformRead(Request, "headers", input) };
  } catch {
    return { method: UNREADABLE, headers: UNREADABLE };
  }
}

/**
 * What a `fetch(input, init)` call sent, read without running application
 * getters, iterators or conversions. Called only after the page's fetch has
 * returned: a native fetch, and a wrapper that calls one synchronously, has
 * read its arguments by then. A Proxy's traps can still run here (no script
 * can tell a Proxy apart), which a wrapper that defers the native call, or a
 * later call that reuses a stateful Proxy, could observe.
 */
function readFetchRequest(input: unknown, init: unknown, url: string | undefined): Pick<Observation, "method" | "url" | "requestHeaders"> {
  let { method, headers } = requestDefaults(input);
  if (typeof init === "object" || typeof init === "function") {
    if (init !== null) {
      const initMethod = optionField(init, "method");
      if (initMethod !== undefined) method = initMethod;
      const initHeaders = optionField(init, "headers");
      if (initHeaders !== undefined) headers = initHeaders;
    }
  } else if (init !== undefined) {
    headers = UNREADABLE; // The platform rejects it; there is nothing to read.
  }
  return {
    method: typeof method === "string" ? text(method) : UNREAD_METHOD,
    url: captureUrl(url ?? inputUrl(input)),
    requestHeaders: captureHeaders(headers),
  };
}

/**
 * Hands back `pending` chained through `onSettle`, so the caller's promise
 * settles exactly as the page's does: same value, same reason, and an
 * unhandled rejection stays unhandled. A value that is not a thenable, or
 * whose `then` cannot be read or called, is handed back as is.
 */
function chainSettlement<T>(pending: T, onSettle: (response?: unknown) => void): T {
  const candidate: unknown = pending;
  if ((typeof candidate !== "object" || candidate === null) && typeof candidate !== "function") return pending;
  let then: unknown;
  try {
    then = (candidate as { then?: unknown }).then;
  } catch {
    return pending;
  }
  if (typeof then !== "function") return pending;
  const onFulfilled = (response: unknown) => {
    onSettle(response);
    return response;
  };
  const onRejected = (reason: unknown) => {
    onSettle();
    throw reason;
  };
  let chained: unknown = pending;
  try {
    chained = Reflect.apply(then, candidate, [onFulfilled, onRejected]);
  } catch {
    chained = pending; // An unusual thenable: hand it back as is.
  }
  return chained as T;
}

function duration(since: number): number {
  return Math.max(0, Date.now() - since);
}

function subscribe(listener: Listener): () => void {
  if (listeners.size === 0) {
    listeners = new Set();
    const current = listeners;
    const emit = (observation: Observation) => {
      for (const receive of current) {
        try {
          receive(observation);
        } catch {
          /* Capture must not change application requests. */
        }
      }
    };
    const cleanups: Array<() => void> = [];

    // Every wrapper first checks `current`: once its collectors have all
    // stopped it reads nothing and only passes the call through, so a wrapper
    // another library keeps in its chain after stop() is inert.
    if (typeof globalThis.fetch === "function") {
      const original = globalThis.fetch;
      const wrapper = function (this: unknown, ...args: Parameters<typeof fetch>): Promise<Response> {
        if (current.size === 0) return original.apply(this ?? globalThis, args);
        const timestamp = Date.now();
        // The page's fetch runs first, with the application's own arguments
        // and receiver, before observation reads anything from them.
        // See readFetchRequest for what that ordering does and does not cover.
        // A string or platform URL input is read first, as sent: that runs no
        // application code, and the conversion inside the call cannot alter it.
        const url = typeof args[0] === "string" ? args[0] : platformHref(args[0]);
        const pending = original.apply(this ?? globalThis, args);
        let observed: Observation;
        try {
          observed = { transport: "fetch", timestamp, ...readFetchRequest(args[0], args[1], url) };
        } catch {
          return pending; // Unreadable input: the application's call is already made.
        }
        return chainSettlement(pending, (response) => {
          try {
            const settled: Observation = { ...observed, duration: duration(timestamp) };
            // Only a platform Response is read, and only through its own getters.
            if (typeof Response === "function" && isInstance(response, Response)) {
              const status = platformRead(Response, "status", response);
              if (Number.isSafeInteger(status) && (status as number) >= 0) {
                settled.status = status as number;
                const statusText = platformRead(Response, "statusText", response);
                if (typeof statusText === "string") settled.statusText = text(statusText);
              }
              settled.responseHeaders = captureHeaders(platformRead(Response, "headers", response));
            }
            emit(settled);
          } catch {
            /* Observation never raises into, or alongside, the application's promise. */
          }
        });
      };
      globalThis.fetch = wrapper as typeof fetch;
      cleanups.push(() => {
        if (globalThis.fetch === wrapper) globalThis.fetch = original;
      });
    }

    if (typeof XMLHttpRequest !== "undefined") {
      const prototype = XMLHttpRequest.prototype;
      const originalOpen = prototype.open as (...values: unknown[]) => unknown;
      const originalSend = prototype.send as (...values: unknown[]) => unknown;
      const records = new WeakMap<object, XhrRecord>();
      const target = typeof EventTarget === "function" ? EventTarget.prototype : undefined;
      // A platform attribute is read through the platform getter; a stand-in
      // without one is read only from an own data property.
      const field = (xhr: object, key: string): Field => {
        const get = Object.getOwnPropertyDescriptor(prototype, key)?.get;
        return get ? get.call(xhr) : dataValue(xhr, key);
      };
      const open = function (this: XMLHttpRequest, ...args: unknown[]) {
        if (current.size === 0) return originalOpen.apply(this, args);
        const [method, url] = args;
        // Read before the call, which runs no application code: a string, or
        // a platform URL through its brand-checked getter. The record is in
        // place before the call, so a send() made from open()'s own
        // readystatechange belongs to this request (or to a nested open()).
        const record: XhrRecord = { method: typeof method === "string" ? text(method) : UNREAD_METHOD, url: captureUrl(inputUrl(url, false)) };
        let previous: XhrRecord | undefined;
        let tracked = false;
        try {
          previous = records.get(this);
          records.set(this, record);
          tracked = true;
        } catch {
          tracked = false; // Not an object: there is nothing to record.
        }
        let result: unknown;
        try {
          result = originalOpen.apply(this, args);
        } catch (error) {
          // A rejected open() leaves the earlier request, and its record, in place.
          if (tracked && records.get(this) === record) {
            if (previous) records.set(this, previous);
            else records.delete(this);
          }
          throw error;
        }
        return result;
      } as typeof prototype.open;
      const send = function (this: XMLHttpRequest, ...args: unknown[]) {
        if (current.size === 0) return originalSend.apply(this, args);
        let record: XhrRecord | undefined;
        try {
          record = records.get(this);
        } catch {
          record = undefined;
        }
        if (!record || !target) return originalSend.apply(this, args);
        // send() reads nothing from its arguments. The loadend listener goes
        // on first because a synchronous request completes inside send().
        const observed = record;
        const xhr = this;
        const timestamp = Date.now();
        const complete = () => {
          try {
            const settled: Observation = { transport: "xhr", ...observed, timestamp, duration: duration(timestamp) };
            const status = field(xhr, "status");
            if (Number.isSafeInteger(status) && (status as number) >= 0) settled.status = status as number;
            const statusText = field(xhr, "statusText");
            if (typeof statusText === "string") settled.statusText = text(statusText);
            emit(settled);
          } catch {
            /* Observation never raises into the application's event dispatch. */
          }
        };
        let listening = false;
        try {
          target.addEventListener.call(xhr, "loadend", complete, { once: true });
          listening = true;
        } catch {
          listening = false; // Not an event target: send without observing.
        }
        try {
          return originalSend.apply(xhr, args);
        } catch (error) {
          if (listening) {
            try {
              target.removeEventListener.call(xhr, "loadend", complete);
            } catch {
              /* Nothing more to undo. */
            }
          }
          throw error;
        }
      } as typeof prototype.send;
      prototype.open = open;
      prototype.send = send;
      cleanups.push(() => {
        if (prototype.open === open) prototype.open = originalOpen as typeof prototype.open;
        if (prototype.send === send) prototype.send = originalSend as typeof prototype.send;
      });
    }

    // Restore only what we replaced and still own; a wrapper another library
    // installed over ours keeps ours in its chain, inert once `current` empties.
    restore = () => {
      for (const cleanup of cleanups) cleanup();
    };
  }
  const current = listeners;
  current.add(listener);
  return () => {
    current.delete(listener);
    if (current === listeners && current.size === 0) {
      restore?.();
      restore = undefined;
    }
  };
}

function matches(url: string, pattern: IgnorePattern): boolean {
  if (typeof pattern === "string") return url.includes(pattern);
  pattern.lastIndex = 0;
  return pattern.test(url);
}

/**
 * Records `fetch` and `XMLHttpRequest` calls as network evidence events in a
 * bounded buffer. URLs and headers are redacted before they are stored; the
 * application's requests are never modified. Runs on its own, without a
 * reporter or server.
 */
export class NetworkCollector {
  private readonly events: RingBuffer<NetworkEvidenceEvent>;
  private unsubscribe?: () => void;

  constructor(maxSize = 20, private readonly options: NetworkCollectorOptions = {}) {
    assertCapacity(maxSize);
    this.events = new RingBuffer(maxSize);
  }

  start(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = subscribe((observation) => {
      if (this.events.capacity === 0) return;
      const { allowUrls, blockUrls } = this.options;
      if (blockUrls?.some((pattern) => matches(observation.url, pattern))) return;
      if (allowUrls?.length && !allowUrls.some((pattern) => matches(observation.url, pattern))) return;
      const event: NetworkEvidenceEvent = {
        schemaVersion: EVIDENCE_SCHEMA_VERSION,
        kind: "network",
        seq: takeSeq(),
        timestamp: observation.timestamp,
        transport: observation.transport,
        method: observation.method,
        url: observation.url,
      };
      // Optional fields are omitted, never present as undefined.
      if (observation.status !== undefined) event.status = observation.status;
      if (observation.statusText !== undefined) event.statusText = observation.statusText;
      if (observation.duration !== undefined) event.duration = observation.duration;
      const requestHeaders = this.filterHeaders(observation.requestHeaders);
      const responseHeaders = this.filterHeaders(observation.responseHeaders);
      if (requestHeaders) event.requestHeaders = requestHeaders;
      if (responseHeaders) event.responseHeaders = responseHeaders;
      this.events.push(freezeEvent(event));
    });
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }

  /** Captured events, oldest first, optionally limited to a time window. */
  collect(window?: CollectWindow): NetworkEvidenceEvent[] {
    return this.events.query(window);
  }

  clear(): void {
    this.events.clear();
  }

  size(): number {
    return this.events.size;
  }

  private filterHeaders(headers?: Record<string, string>): Record<string, string> | undefined {
    if (!headers) return undefined;
    const { allowedHeaders, blockedHeaders } = this.options;
    const allowed = allowedHeaders?.map((header) => header.toLowerCase());
    const blocked = blockedHeaders?.map((header) => header.toLowerCase());
    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(headers)) {
      const name = key.toLowerCase();
      if (blocked?.includes(name) || (allowed && !allowed.includes(name))) continue;
      Object.defineProperty(result, key, { value, enumerable: true, writable: true, configurable: true });
    }
    return result;
  }
}

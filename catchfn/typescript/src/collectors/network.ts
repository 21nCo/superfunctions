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

let listeners = new Set<Listener>();
let restore: (() => void) | undefined;

/** Recorded for a request URL that is not a string, `URL` or `Request`. */
export const UNREAD_URL = "[UNREAD_URL]";
/** Recorded for a request method that is not a string data value. */
export const UNREAD_METHOD = "[UNREAD_METHOD]";
const MAX_HEADER_PAIRS = 200;

/** Marks a value observation may not read without running application code. */
const UNREADABLE: unique symbol = Symbol("unreadable");
type Field = unknown | typeof UNREADABLE;

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

/**
 * Copies header pairs out of a `HeadersInit` without invoking any application
 * iterator, getter or conversion: a platform `Headers` object that is not a
 * subclass (read through the platform's `forEach`), a plain array of `[name, value]` string pairs or a
 * plain record whose enumerable properties are string data values. Anything
 * else (a generator, `Map.entries()`, an accessor, a non-string value, ...) is
 * left unread and yields undefined.
 */
function readHeaderPairs(value: Field): Array<[string, string]> | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  if (typeof Headers === "function" && isInstance(value, Headers)) {
    // A subclass or an own iterator may make the platform send other pairs.
    if (Object.getPrototypeOf(value) !== Headers.prototype || Object.getOwnPropertyDescriptor(value, Symbol.iterator)) return undefined;
    const pairs: Array<[string, string]> = [];
    Headers.prototype.forEach.call(value, (entry: string, name: string) => {
      pairs.push([name, entry]);
    });
    return pairs;
  }
  if (isPlainArray(value)) {
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

/** A URL string, a platform `URL` or a platform `Request`; anything else is not read. */
function inputUrl(input: unknown): string {
  if (typeof input === "string") return input;
  try {
    let url: Field = UNREADABLE;
    if (typeof URL === "function" && isInstance(input, URL)) url = platformRead(URL, "href", input);
    else if (typeof Request === "function" && isInstance(input, Request)) url = platformRead(Request, "url", input);
    return typeof url === "string" ? url : UNREAD_URL;
  } catch {
    return UNREAD_URL;
  }
}

/** What a `fetch(input, init)` call sends, read without running application code. */
function readFetchRequest(input: unknown, init: unknown): Pick<Observation, "method" | "url" | "requestHeaders"> {
  let method: Field = "GET";
  let headers: Field = UNREADABLE;
  if (typeof Request === "function" && isInstance(input, Request)) {
    try {
      method = platformRead(Request, "method", input);
      headers = platformRead(Request, "headers", input);
    } catch {
      method = UNREADABLE;
    }
  }
  if (init !== undefined && init !== null) {
    if (typeof init === "object" || typeof init === "function") {
      const initMethod = optionField(init, "method");
      if (initMethod !== undefined) method = initMethod;
      const initHeaders = optionField(init, "headers");
      if (initHeaders !== undefined) headers = initHeaders;
    } else {
      headers = UNREADABLE; // The platform rejects it; there is nothing to read.
    }
  }
  return {
    method: typeof method === "string" ? text(method) : UNREAD_METHOD,
    url: captureUrl(inputUrl(input)),
    requestHeaders: captureHeaders(headers),
  };
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
        let base: Observation | undefined;
        try {
          base = { transport: "fetch", timestamp, ...readFetchRequest(args[0], args[1]) };
        } catch {
          base = undefined; // Unreadable input: still make the application's call.
        }
        // The application's own arguments and receiver pass through untouched.
        const pending = original.apply(this ?? globalThis, args);
        if (!base) return pending;
        const observed = base;
        const observe = (response?: unknown) => {
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
        };
        // The caller receives a promise derived from the page's that settles
        // the same way with the same value or reason. Chaining, rather than a
        // side branch, keeps an unhandled rejection unhandled: the caller's
        // promise rejects with the original reason exactly when the page's would.
        try {
          if (!pending || typeof pending.then !== "function") return pending;
          return pending.then(
            (response) => {
              observe(response);
              return response;
            },
            (reason: unknown) => {
              observe();
              throw reason;
            }
          );
        } catch {
          return pending; // An unusual thenable: hand it back as is.
        }
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
      const records = new WeakMap<object, { method: string; url: string }>();
      const target = typeof EventTarget === "function" ? EventTarget.prototype : undefined;
      // A platform attribute is read through the platform getter; a stand-in
      // without one is read only from an own data property.
      const field = (xhr: object, key: string): Field => {
        const get = Object.getOwnPropertyDescriptor(prototype, key)?.get;
        return get ? get.call(xhr) : dataValue(xhr, key);
      };
      const open = function (this: XMLHttpRequest, ...args: unknown[]) {
        if (current.size === 0) return originalOpen.apply(this, args);
        try {
          const [method, url] = args;
          let address = UNREAD_URL;
          if (typeof url === "string") address = url;
          else if (typeof URL === "function" && isInstance(url, URL)) {
            const href = platformRead(URL, "href", url);
            if (typeof href === "string") address = href;
          }
          records.set(this, { method: typeof method === "string" ? text(method) : UNREAD_METHOD, url: captureUrl(address) });
        } catch {
          try {
            records.delete(this);
          } catch {
            /* Not an object: there is no record to drop. */
          }
        }
        return originalOpen.apply(this, args);
      } as typeof prototype.open;
      const send = function (this: XMLHttpRequest, ...args: unknown[]) {
        if (current.size === 0) return originalSend.apply(this, args);
        let record: { method: string; url: string } | undefined;
        try {
          record = records.get(this);
        } catch {
          record = undefined;
        }
        if (!record || !target) return originalSend.apply(this, args);
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

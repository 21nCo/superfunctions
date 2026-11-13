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

/** The method and URL (as sent, not yet redacted) of an XMLHttpRequest's current open(). */
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

type Intrinsic = (...values: unknown[]) => unknown;
const { apply } = Reflect;
const platform = globalThis as Record<string, unknown>;

function prototypeOf(constructor: unknown): object | undefined {
  return typeof constructor === "function" ? (constructor.prototype as object) : undefined;
}

/** A prototype's own getter (or, with "value", method). */
function intrinsic(prototype: object | undefined, key: PropertyKey, kind: "get" | "value" = "get"): Intrinsic | undefined {
  const found: unknown = prototype && Object.getOwnPropertyDescriptor(prototype, key)?.[kind];
  return typeof found === "function" ? (found as Intrinsic) : undefined;
}

// The platform getters and methods observation reads through, captured once
// when this module loads: a getter or method the page patches later never runs.
const URL_PROTOTYPE = prototypeOf(platform.URL);
const URL_HREF = intrinsic(URL_PROTOTYPE, "href");
const REQUEST_PROTOTYPE = prototypeOf(platform.Request);
const REQUEST_URL = intrinsic(REQUEST_PROTOTYPE, "url");
const REQUEST_METHOD = intrinsic(REQUEST_PROTOTYPE, "method");
const REQUEST_HEADERS = intrinsic(REQUEST_PROTOTYPE, "headers");
const RESPONSE_PROTOTYPE = prototypeOf(platform.Response);
const RESPONSE_STATUS = intrinsic(RESPONSE_PROTOTYPE, "status");
const RESPONSE_STATUS_TEXT = intrinsic(RESPONSE_PROTOTYPE, "statusText");
const RESPONSE_HEADERS = intrinsic(RESPONSE_PROTOTYPE, "headers");
const HEADERS = typeof platform.Headers === "function" ? (platform.Headers as typeof Headers) : undefined;
const HEADERS_PROTOTYPE = prototypeOf(HEADERS);
const HEADERS_FOR_EACH = intrinsic(HEADERS_PROTOTYPE, "forEach", "value");
const HEADERS_ITERATOR = intrinsic(HEADERS_PROTOTYPE, Symbol.iterator, "value");
const EVENT_TARGET_PROTOTYPE = prototypeOf(platform.EventTarget);
const ADD_LISTENER = intrinsic(EVENT_TARGET_PROTOTYPE, "addEventListener", "value");
const REMOVE_LISTENER = intrinsic(EVENT_TARGET_PROTOTYPE, "removeEventListener", "value");
const XHR_PROTOTYPE = prototypeOf(platform.XMLHttpRequest);
const XHR_STATUS = intrinsic(XHR_PROTOTYPE, "status");
const XHR_STATUS_TEXT = intrinsic(XHR_PROTOTYPE, "statusText");
const PROMISE = typeof platform.Promise === "function" ? (platform.Promise as PromiseConstructor) : undefined;
const PROMISE_PROTOTYPE = prototypeOf(PROMISE);
const PROMISE_THEN = intrinsic(PROMISE_PROTOTYPE, "then", "value");
const PROMISE_SPECIES = intrinsic(PROMISE, Symbol.species);

/**
 * Whether the captured `href` getter's brand check runs no Proxy trap on this
 * runtime, probed once at load with Proxies whose every trap lookup is
 * recorded. Browsers and current Node check an internal slot; Node 18.17's
 * getter calls hasOwnProperty, which runs a trap, so there it is not used
 * before the page's call.
 */
const URL_HREF_TRAP_FREE = ((): boolean => {
  if (!URL_HREF || typeof Proxy !== "function" || typeof platform.URL !== "function") return false;
  let trapped = false;
  const handler = new Proxy({}, { get: () => void (trapped = true) });
  for (const target of [new (platform.URL as typeof URL)("http://localhost/"), {}]) {
    try {
      apply(URL_HREF, new Proxy(target, handler), []);
    } catch {
      /* Not a platform URL, as expected. */
    }
  }
  return !trapped;
})();

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

/**
 * Reads a platform attribute through its captured getter, whose brand check
 * also rejects anything that is not that platform object: unreadable then.
 */
function platformRead(get: Intrinsic | undefined, target: unknown): Field {
  if (!get || typeof target !== "object" || target === null) return UNREADABLE;
  try {
    return apply(get, target, []);
  } catch {
    return UNREADABLE;
  }
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

/** Pairs of a platform `Headers` that is not a subclass, read through the captured `forEach`. */
function platformHeaderPairs(value: object): Array<[string, string]> | undefined {
  // An own or replaced iterator may make the platform send other pairs.
  if (!HEADERS_FOR_EACH || Object.getOwnPropertyDescriptor(value, Symbol.iterator)) return undefined;
  if (intrinsic(HEADERS_PROTOTYPE, Symbol.iterator, "value") !== HEADERS_ITERATOR) return undefined;
  const pairs: Array<[string, string]> = [];
  apply(HEADERS_FOR_EACH, value, [
    (entry: string, name: string) => {
      if (pairs.length <= MAX_HEADER_PAIRS) pairs.push([name, entry]);
    },
  ]);
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
  // A subclass of Headers is neither of the other forms either, so it is unread.
  if (HEADERS_PROTOTYPE && Object.getPrototypeOf(value) === HEADERS_PROTOTYPE) return platformHeaderPairs(value);
  if (isPlainArray(value)) return arrayHeaderPairs(value);
  return recordHeaderPairs(value);
}

function captureHeaders(value: Field): Record<string, string> | undefined {
  if (!HEADERS || !HEADERS_FOR_EACH) return undefined;
  try {
    const pairs = readHeaderPairs(value);
    if (!pairs) return undefined;
    // Headers built from our own copy validates and normalizes the names.
    const result: Record<string, string> = {};
    apply(HEADERS_FOR_EACH, new HEADERS(pairs), [
      (entry: string, name: string) => {
        Object.defineProperty(result, name, { value: entry, enumerable: true, writable: true, configurable: true });
      },
    ]);
    // A plain record of strings serializes to a record of (possibly cut) strings.
    return serializeEntry(redactHeaders(result)) as Record<string, string>;
  } catch {
    return undefined; // Unreadable or invalid headers: record the request without them.
  }
}

/**
 * The URL as sent, read before the page's call: a string, or a platform `URL`
 * through the captured `href` getter when its brand check runs no Proxy trap.
 * Undefined for anything else.
 */
function sentUrl(input: unknown): string | undefined {
  if (typeof input === "string") return input;
  if (!URL_HREF_TRAP_FREE) return undefined;
  const href = platformRead(URL_HREF, input);
  return typeof href === "string" ? href : undefined;
}

/**
 * The URL of a fetch input that {@link sentUrl} did not read, read after the
 * page's call: a platform `Request`, whose URL cannot change, through the
 * captured `url` getter. Anything else, including a `URL` that could have
 * changed since it was sent, is recorded as {@link UNREAD_URL}.
 */
function requestUrl(input: unknown): string {
  const url = platformRead(REQUEST_URL, input);
  return typeof url === "string" ? url : UNREAD_URL;
}

/** Method and headers of a platform `Request` input, through the captured getters. */
function requestDefaults(input: unknown): { method: Field; headers: Field } {
  if (platformRead(REQUEST_URL, input) === UNREADABLE) return { method: "GET", headers: UNREADABLE };
  return { method: platformRead(REQUEST_METHOD, input), headers: platformRead(REQUEST_HEADERS, input) };
}

/**
 * What a `fetch(input, init)` call sent, read without running application
 * getters, iterators or conversions. Called only after the page's fetch has
 * returned: a native fetch, and a wrapper that calls one synchronously, has
 * read its arguments by then. Known limit, deferred to SFNS-60 by the owner
 * (SFNS-56 scope amendment 2026-11-13): a Proxy's traps still run here (no
 * script can tell a Proxy apart), so a stateful Proxy can observe these reads,
 * and what is recorded can differ from what was sent when a wrapper installed
 * before start() defers the native call, or the init or Request is reused,
 * including values an earlier wrapper changed.
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
    url: captureUrl(url ?? requestUrl(input)),
    requestHeaders: captureHeaders(headers),
  };
}

/**
 * Whether the captured `then` on `value` runs no application code: a
 * platform Promise that is not a subclass, with no own `constructor`, while
 * Promise's `constructor` and species are still the platform's.
 */
function isPlainPromise(value: unknown): boolean {
  if (!PROMISE || !PROMISE_THEN || typeof value !== "object" || value === null) return false;
  return (
    Object.getPrototypeOf(value) === PROMISE_PROTOTYPE &&
    !Object.getOwnPropertyDescriptor(value, "constructor") &&
    Object.getOwnPropertyDescriptor(PROMISE_PROTOTYPE, "constructor")?.value === PROMISE &&
    intrinsic(PROMISE, Symbol.species) === PROMISE_SPECIES
  );
}

/**
 * Observes how the page's `pending` settles, on a side chain that never
 * raises, and only for a plain platform Promise through the captured `then`:
 * any other value's own `then` runs only when the application calls it.
 * Returns whether it observes. The caller gets `pending` itself, unchanged
 * (SFNS-56 owner amendment 2026-11-13). Observing a promise marks it handled,
 * so a rejection the application leaves unhandled is not reported as
 * unhandled while a collector runs.
 */
function observeSettlement(pending: unknown, onSettle: (response?: unknown) => void): boolean {
  if (!isPlainPromise(pending)) return false;
  try {
    apply(PROMISE_THEN as Intrinsic, pending, [(response: unknown) => onSettle(response), () => onSettle()]);
    return true;
  } catch {
    return false; // Not a platform Promise after all.
  }
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
        if (current.size === 0) return apply(original, this ?? globalThis, args) as Promise<Response>;
        const timestamp = Date.now();
        // The page's fetch runs first, with the application's own arguments
        // and receiver. Before it, observation reads only the URL as sent (see
        // sentUrl); every other argument is read after it returns.
        // See readFetchRequest for what that ordering does and does not cover.
        const url = sentUrl(args[0]);
        const pending = apply(original, this ?? globalThis, args) as Promise<Response>;
        let observed: Observation;
        try {
          observed = { transport: "fetch", timestamp, ...readFetchRequest(args[0], args[1], url) };
        } catch {
          return pending; // Unreadable input: the application's call is already made.
        }
        const observing = observeSettlement(pending, (response) => {
          try {
            const settled: Observation = { ...observed, duration: duration(timestamp) };
            // Only a platform Response is read, and only through the captured getters.
            const status = platformRead(RESPONSE_STATUS, response);
            if (status !== UNREADABLE) {
              if (Number.isSafeInteger(status) && (status as number) >= 0) {
                settled.status = status as number;
                const statusText = platformRead(RESPONSE_STATUS_TEXT, response);
                if (typeof statusText === "string") settled.statusText = text(statusText);
              }
              settled.responseHeaders = captureHeaders(platformRead(RESPONSE_HEADERS, response));
            }
            emit(settled);
          } catch {
            /* Observation never raises into, or alongside, the application's promise. */
          }
        });
        // Any other result is recorded as called, without its settlement.
        if (!observing) emit(observed);
        return pending;
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
      // The getters captured when this module loaded, or, for an
      // XMLHttpRequest defined later, when the wrappers are installed.
      const loaded = prototype === XHR_PROTOTYPE;
      const getters: Record<string, Intrinsic | undefined> = {
        status: loaded ? XHR_STATUS : intrinsic(prototype, "status"),
        statusText: loaded ? XHR_STATUS_TEXT : intrinsic(prototype, "statusText"),
      };
      // A platform attribute is read through the platform getter; a stand-in
      // without one is read only from an own data property.
      const field = (xhr: object, key: "status" | "statusText"): Field => {
        const get = getters[key];
        return get ? apply(get, xhr, []) : dataValue(xhr, key);
      };
      const open = function (this: XMLHttpRequest, ...args: unknown[]) {
        if (current.size === 0) return apply(originalOpen, this, args);
        const [method, url] = args;
        // Read before the call, which runs no application code: a string, or
        // a platform URL through the captured, trap-free href getter. The
        // record is in place before the call, so a send() made from open()'s
        // own readystatechange belongs to this request (or to a nested open()).
        const record: XhrRecord = { method: typeof method === "string" ? text(method) : UNREAD_METHOD, url: sentUrl(url) ?? UNREAD_URL };
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
          result = apply(originalOpen, this, args);
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
        if (current.size === 0) return apply(originalSend, this, args);
        let record: XhrRecord | undefined;
        try {
          record = records.get(this);
        } catch {
          record = undefined;
        }
        if (!record || !ADD_LISTENER) return apply(originalSend, this, args);
        // send() reads nothing from its arguments. The loadend listener goes
        // on first because a synchronous request completes inside send().
        const observed = record;
        const xhr = this;
        const timestamp = Date.now();
        const complete = () => {
          try {
            const settled: Observation = { transport: "xhr", method: observed.method, url: captureUrl(observed.url), timestamp, duration: duration(timestamp) };
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
          apply(ADD_LISTENER, xhr, ["loadend", complete, { once: true }]);
          listening = true;
        } catch {
          listening = false; // Not an event target: send without observing.
        }
        try {
          return apply(originalSend, xhr, args);
        } catch (error) {
          if (listening && REMOVE_LISTENER) {
            try {
              apply(REMOVE_LISTENER, xhr, ["loadend", complete]);
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

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

function text(value: unknown): string {
  return truncateToBytes(String(value), MAX_ENTRY_BYTES) ?? "";
}

function captureUrl(value: unknown): string {
  return text(redactUrl(String(value)));
}

function captureHeaders(value: unknown): Record<string, string> | undefined {
  if (value === undefined || value === null || typeof Headers === "undefined") return undefined;
  const result: Record<string, string> = {};
  new Headers(value as HeadersInit).forEach((entry, key) => {
    result[key] = entry;
  });
  // A plain record of strings serializes to a record of (possibly cut) strings.
  return serializeEntry(redactHeaders(result)) as Record<string, string>;
}

function requestUrl(input: unknown): string {
  if (typeof input === "string") return input;
  if (typeof URL !== "undefined" && input instanceof URL) return input.href;
  const url = (input as { url?: unknown } | null | undefined)?.url;
  return typeof url === "string" ? url : String(input);
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

    if (typeof globalThis.fetch === "function") {
      const original = globalThis.fetch;
      const wrapper = function (this: unknown, ...args: Parameters<typeof fetch>): Promise<Response> {
        const timestamp = Date.now();
        let base: Observation | undefined;
        try {
          const [input, init] = args;
          const request = input as { method?: unknown; headers?: unknown } | undefined;
          base = {
            transport: "fetch",
            method: text(init?.method ?? (typeof request?.method === "string" ? request.method : "GET")),
            url: captureUrl(requestUrl(input)),
            timestamp,
            requestHeaders: captureHeaders(init?.headers ?? request?.headers),
          };
        } catch {
          base = undefined; // Unreadable input: still make the application's call.
        }
        // The application's own arguments, receiver and promise pass through
        // untouched; capture hangs off the side of the same promise.
        const pending = original.apply(this ?? globalThis, args);
        if (base && pending && typeof pending.then === "function") {
          const observed = base;
          pending.then(
            (response) => {
              let responseHeaders: Record<string, string> | undefined;
              try {
                responseHeaders = captureHeaders(response.headers);
              } catch {
                responseHeaders = undefined;
              }
              emit({ ...observed, status: response.status, statusText: text(response.statusText), duration: duration(timestamp), responseHeaders });
            },
            () => emit({ ...observed, duration: duration(timestamp) })
          );
        }
        return pending;
      };
      globalThis.fetch = wrapper as typeof fetch;
      cleanups.push(() => {
        if (globalThis.fetch === wrapper) globalThis.fetch = original;
      });
    }

    if (typeof XMLHttpRequest !== "undefined") {
      const prototype = XMLHttpRequest.prototype;
      const originalOpen = prototype.open;
      const originalSend = prototype.send;
      const records = new WeakMap<XMLHttpRequest, { method: string; url: string }>();
      const open = function (this: XMLHttpRequest, ...args: unknown[]) {
        try {
          records.set(this, { method: text(args[0]), url: captureUrl(args[1]) });
        } catch {
          records.delete(this);
        }
        return (originalOpen as (...values: unknown[]) => void).apply(this, args);
      } as typeof prototype.open;
      const send = function (this: XMLHttpRequest, body?: Document | XMLHttpRequestBodyInit | null) {
        const record = records.get(this);
        const timestamp = Date.now();
        const complete = () => {
          if (!record) return;
          emit({ transport: "xhr", ...record, timestamp, duration: duration(timestamp), status: this.status, statusText: text(this.statusText) });
        };
        this.addEventListener("loadend", complete, { once: true });
        try {
          return originalSend.call(this, body);
        } catch (error) {
          this.removeEventListener("loadend", complete);
          throw error;
        }
      };
      prototype.open = open;
      prototype.send = send;
      cleanups.push(() => {
        if (prototype.open === open) prototype.open = originalOpen;
        if (prototype.send === send) prototype.send = originalSend;
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

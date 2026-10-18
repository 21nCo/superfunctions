import type { NetworkRequest, ContextCollector, IgnorePattern } from "../core/types.js";
import { redactHeaders, redactUrl } from "../utils/redaction.js";
import { safeSerialize } from "../utils/serialization.js";

export interface NetworkCollectorOptions {
  allowUrls?: IgnorePattern[];
  blockUrls?: IgnorePattern[];
  allowedHeaders?: string[];
  blockedHeaders?: string[];
}
type Listener = (request: NetworkRequest) => void;
let listeners = new Set<Listener>();
let restore: (() => void) | undefined;

function headers(value?: HeadersInit): Record<string, string> | undefined {
  if (!value) return undefined;
  const result: Record<string, string> = {};
  new Headers(value).forEach((entry, key) => { result[key] = entry; });
  return redactHeaders(result);
}

function subscribe(listener: Listener): () => void {
  if (listeners.size === 0) {
    listeners = new Set();
    const current = listeners;
    const emit = (request: NetworkRequest) => {
      for (const receive of current) { try { receive(request); } catch { /* Capture must not change application requests. */ } }
    };
    const cleanups: Array<() => void> = [];
    if (typeof globalThis.fetch === "function") {
      const original = globalThis.fetch;
      const wrapper: typeof fetch = async (input, init) => {
        const request = typeof Request !== "undefined" && input instanceof Request ? input : undefined;
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        const base = { url: redactUrl(url), method: init?.method ?? request?.method ?? "GET", timestamp: Date.now(), requestHeaders: headers(init?.headers ?? request?.headers) };
        try {
          const response = await original.call(globalThis, input, init);
          emit({ ...base, status: response.status, statusText: response.statusText, duration: Date.now() - base.timestamp, responseHeaders: headers(response.headers) });
          return response;
        } catch (error) {
          emit({ ...base, duration: Date.now() - base.timestamp });
          throw error;
        }
      };
      globalThis.fetch = wrapper;
      cleanups.push(() => { if (globalThis.fetch === wrapper) globalThis.fetch = original; });
    }
    if (typeof XMLHttpRequest !== "undefined") {
      const prototype = XMLHttpRequest.prototype;
      const originalOpen = prototype.open;
      const originalSend = prototype.send;
      const records = new WeakMap<XMLHttpRequest, { method: string; url: string }>();
      const open = function(this: XMLHttpRequest, ...args: any[]) {
        records.set(this, { method: String(args[0]), url: redactUrl(String(args[1])) });
        return (originalOpen as any).apply(this, args);
      } as typeof prototype.open;
      const send = function(this: XMLHttpRequest, body?: Document | XMLHttpRequestBodyInit | null) {
        const record = records.get(this);
        const timestamp = Date.now();
        const complete = () => {
          if (!record) return;
          emit({ ...record, timestamp, duration: Date.now() - timestamp, status: this.status, statusText: this.statusText });
        };
        this.addEventListener("loadend", complete, { once: true });
        try { return originalSend.call(this, body); }
        catch (error) { this.removeEventListener("loadend", complete); throw error; }
      };
      prototype.open = open;
      prototype.send = send;
      cleanups.push(() => {
        if (prototype.open === open) prototype.open = originalOpen;
        if (prototype.send === send) prototype.send = originalSend;
      });
    }
    restore = () => { for (const cleanup of cleanups) cleanup(); };
  }
  const current = listeners;
  current.add(listener);
  return () => {
    current.delete(listener);
    if (current === listeners && current.size === 0) { restore?.(); restore = undefined; }
  };
}

function matches(url: string, pattern: IgnorePattern): boolean {
  if (typeof pattern === "string") return url.includes(pattern);
  pattern.lastIndex = 0;
  return pattern.test(url);
}

export class NetworkCollector implements ContextCollector<NetworkRequest[]> {
  private requests: NetworkRequest[] = [];
  private unsubscribe?: () => void;
  constructor(private maxSize = 20, private options: NetworkCollectorOptions = {}) {
    if (!Number.isInteger(maxSize) || maxSize < 0) throw new RangeError("maxSize must be nonnegative");
  }
  start(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = subscribe((request) => {
      if (this.maxSize === 0 || this.options.blockUrls?.some((pattern) => matches(request.url, pattern))) return;
      if (this.options.allowUrls?.length && !this.options.allowUrls.some((pattern) => matches(request.url, pattern))) return;
      const filter = (value?: Record<string, string>) => value && Object.fromEntries(Object.entries(value).filter(([key]) => {
        const name = key.toLowerCase();
        return !this.options.blockedHeaders?.some((header) => header.toLowerCase() === name) && (!this.options.allowedHeaders || this.options.allowedHeaders.some((header) => header.toLowerCase() === name));
      }));
      this.requests.push({ ...safeSerialize(request), requestHeaders: filter(request.requestHeaders), responseHeaders: filter(request.responseHeaders) });
      if (this.requests.length > this.maxSize) this.requests.shift();
    });
  }
  stop(): void { this.unsubscribe?.(); this.unsubscribe = undefined; }
  collect(): NetworkRequest[] { return safeSerialize(this.requests); }
  clear(): void { this.requests = []; }
  size(): number { return this.requests.length; }
}

import { parseBugIssueStatus, type BugIssueReference, type BrowserBugIssueStatus } from "./issue-status";
export { parseBugIssueStatus, type BugIssueReference, type BrowserBugIssueStatus } from "./issue-status";
import { onCLS, onFID, onLCP } from "./vitals";

export interface BrowserConfig {
  endpoint: string;
  /** Override when ingestion does not end in /ingest. Otherwise its mount prefix is retained. */
  issueStatusEndpoint?: string;
  projectId: string;
  sampleRate?: number;
  autoTrack?: boolean;
  apiKey?: string | (() => string);
  headers?: HeadersInit | (() => HeadersInit);
  maxQueueSize?: number;
  batchSize?: number;
  /** Additional attempts after the first request; defaults to two. */
  retries?: number;
  retryDelayMs?: number;
  timeoutMs?: number;
  onError?: (error: Error) => void;
}

export class BrowserDeliveryError extends Error {
  constructor(message: string, readonly status?: number) { super(message); }
}

export class BrowserClient {
  private readonly config: BrowserConfig;
  private readonly queue: string[] = [];
  private pending?: Promise<void>;
  private closed = false;
  private readonly statusReadCancels = new Set<() => void>();
  private readonly disposers: Array<() => void> = [];

  constructor(config: BrowserConfig) {
    this.config = { maxQueueSize: 1000, batchSize: 100, retries: 2, retryDelayMs: 250,
      timeoutMs: 10000, sampleRate: 1, ...config };
    for (const [key, min, max] of [["maxQueueSize", 1, 100000], ["batchSize", 1, 500],
      ["retries", 0, 10], ["retryDelayMs", 0, 60000], ["timeoutMs", 1, 300000]] as const) {
      const value = this.config[key]!;
      if (!Number.isInteger(value) || value < min || value > max) throw new RangeError(`Invalid ${key}`);
    }
    if (!Number.isFinite(this.config.sampleRate) || this.config.sampleRate! < 0 || this.config.sampleRate! > 1) {
      throw new RangeError("Invalid sampleRate");
    }
    if (config.autoTrack !== false) this.initRUM();
  }

  get pendingCount(): number { return this.queue.length; }

  /** One bounded authenticated read; does not enqueue, retry or mutate report delivery. */
  async readBugIssueStatus(reference: BugIssueReference, options: { signal?: AbortSignal } = {}): Promise<BrowserBugIssueStatus | null> {
    if (this.closed) throw new Error("WatchFn browser client is closed");
    if (!reference || typeof reference.app !== "string" || !reference.app.trim() || reference.app.length > 200 || typeof reference.reportId !== "string" || !reference.reportId.trim() || reference.reportId.length > 256) throw new TypeError("Invalid bug reference");
    const endpoint = new URL(this.config.issueStatusEndpoint ?? this.config.endpoint, typeof location === "undefined" ? undefined : location.href);
    if (!this.config.issueStatusEndpoint) {
      if (!endpoint.pathname.endsWith("/ingest") || endpoint.search || endpoint.hash) throw new TypeError("Configure issueStatusEndpoint for a noncanonical ingestion endpoint");
      endpoint.pathname = endpoint.pathname.slice(0, -"/ingest".length) + "/issues/status";
    }
    if (!["https:", "http:"].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.hash) throw new TypeError("Invalid issue status endpoint");
    const controller = new AbortController();
    let rejectAbort!: (reason: unknown) => void;
    const aborted = new Promise<never>((_, reject) => { rejectAbort = reject; });
    const abort = () => { controller.abort(); rejectAbort(new BrowserDeliveryError("Issue status read canceled")); };
    this.statusReadCancels.add(abort);
    options.signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => { controller.abort(); rejectAbort(new BrowserDeliveryError("Issue status read timed out")); }, this.config.timeoutMs);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    if (options.signal?.aborted) abort();
    try {
      return await Promise.race([aborted, (async () => {
        if (controller.signal.aborted) throw new BrowserDeliveryError("Issue status read canceled");
        const headers = new Headers(typeof this.config.headers === "function" ? this.config.headers() : this.config.headers);
        headers.set("Content-Type", "application/json");
        const key = typeof this.config.apiKey === "function" ? this.config.apiKey() : this.config.apiKey;
        if (key) headers.set("Authorization", `Bearer ${key}`);
        const response = await fetch(endpoint.href, { method: "POST", headers, body: JSON.stringify(reference), signal: controller.signal, redirect: "error" });
        if (controller.signal.aborted) { void response.body?.cancel().catch(() => {}); throw new BrowserDeliveryError("Issue status read canceled"); }
        if (response.status === 404) { void response.body?.cancel().catch(() => {}); return null; }
        if (!response.ok) { void response.body?.cancel().catch(() => {}); throw new BrowserDeliveryError(`Issue status returned HTTP ${response.status}`, response.status); }
        if (!response.body || !/^application\/json(?:;|$)/i.test(response.headers.get("content-type") ?? "")) { void response.body?.cancel().catch(() => {}); throw new Error("Invalid issue status response"); }
        reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
        for (;;) {
          const { done, value } = await reader.read(); if (done) break;
          size += value.byteLength; if (size > 16384) throw new Error("Issue status response too large"); chunks.push(value);
        }
        const bytes = new Uint8Array(size); let offset = 0;
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
        return parseBugIssueStatus(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)), reference);
      })()]);
    } finally {
      clearTimeout(timer); this.statusReadCancels.delete(abort); options.signal?.removeEventListener("abort", abort);
      controller.abort(); if (reader) void reader.cancel().catch(() => {});
    }
  }

  private initRUM() {
    const track = (metric: any) => { if (!this.closed) this.collect("web_vital", metric); };
    this.disposers.push(onCLS(track), onFID(track), onLCP(track));
    if (typeof window !== "undefined") {
      this.collect("page_view", { path: window.location.pathname, referrer: document.referrer, title: document.title });
    }
  }

  private collect(name: string, properties: any) {
    try { this.track(name, properties); } catch (error) { this.report(error); }
  }

  private report(error: unknown) {
    try {
      const normalized = error instanceof Error ? error : new Error(String(error));
      if (this.config.onError) this.config.onError(normalized);
      else console.error("WatchFn: Failed to send events", normalized);
    } catch { /* Error reporting must not affect retained delivery state. */ }
  }

  track(name: string, properties: any = {}): void {
    if (this.closed) throw new Error("WatchFn browser client is closed");
    if (typeof window === "undefined") return;
    if (!name.trim()) throw new TypeError("Event name is required");
    if (Math.random() >= this.config.sampleRate!) return;
    this.enqueue({ type: "track", name, properties, timestamp: new Date().toISOString(),
      projectId: this.config.projectId, url: window.location.href, userAgent: navigator.userAgent });
    // The shared promise is also available to callers through flush(). Automatic
    // errors are surfaced without creating an unhandled rejection or retry loop.
    if (!this.pending) void this.flush().catch(error => this.report(error));
  }

  /** Deliver a canonical envelope unchanged, independent of DOM availability and RUM sampling.
   * Rejected deliveries remain queued for an explicit flush/close retry. */
  async capture(event: Record<string, unknown>): Promise<void> {
    const serialized = this.enqueue(event);
    // A capture can arrive as a previous drain is settling. Join that drain,
    // then start another if this snapshot has not yet been acknowledged.
    do { await this.flush(); } while (this.queue.includes(serialized));
  }

  private enqueue(event: Record<string, unknown>): string {
    if (this.closed) throw new Error("WatchFn browser client is closed");
    if (!event || typeof event !== "object" || Array.isArray(event)) throw new TypeError("Event must be an object");
    if (this.queue.length >= this.config.maxQueueSize!) throw new Error("WatchFn event queue is full");
    const serialized = JSON.stringify(event);
    if (typeof serialized !== "string" || !serialized.startsWith("{")) throw new TypeError("Event must serialize to an object");
    if (new TextEncoder().encode(serialized).byteLength > 64 * 1024) throw new RangeError("WatchFn event exceeds 64 KiB");
    this.queue.push(serialized);
    return serialized;
  }

  /** Join the current delivery attempt. Failed events stay queued for a later call. */
  flush(): Promise<void> {
    if (this.pending) return this.pending;
    const operation = Promise.resolve().then(() => this.drain());
    this.pending = operation.finally(() => { this.pending = undefined; });
    return this.pending;
  }

  /** Stop collection and await delivery. After failure, close/flush can be retried. */
  close(): Promise<void> {
    this.closed = true;
    for (const cancel of this.statusReadCancels) cancel();
    for (const dispose of this.disposers.splice(0)) dispose();
    return this.flush();
  }

  private async drain(): Promise<void> {
    while (this.queue.length) {
      // Bound both count and bytes for the ingestion endpoint's 8 MiB limit.
      const batch: string[] = [];
      let bytes = 2;
      for (const event of this.queue.slice(0, this.config.batchSize)) {
        const size = new TextEncoder().encode(event).byteLength + (batch.length ? 1 : 0);
        if (bytes + size > 1024 * 1024) break;
        batch.push(event); bytes += size;
      }
      const body = `[${batch.join(",")}]`;
      await this.deliver(body);
      this.queue.splice(0, batch.length);
    }
  }

  private async deliver(body: string): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      let failure: unknown;
      let retryable = true;
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const headers = new Headers(typeof this.config.headers === "function" ? this.config.headers() : this.config.headers);
        headers.set("Content-Type", "application/json");
        const key = typeof this.config.apiKey === "function" ? this.config.apiKey() : this.config.apiKey;
        if (key) headers.set("Authorization", `Bearer ${key}`);
        const timeout = new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new BrowserDeliveryError("WatchFn delivery timed out"));
          }, this.config.timeoutMs);
        });
        // keepalive is intentionally omitted: browser aggregate keepalive quotas
        // can reject batches above 64 KiB before they reach the endpoint.
        const response = await Promise.race([fetch(this.config.endpoint, {
          method: "POST", headers, body, signal: controller.signal,
        }), timeout]);
        void response.body?.cancel().catch(() => {});
        if (response.ok) return;
        retryable = response.status === 408 || response.status === 429 || response.status >= 500;
        failure = new BrowserDeliveryError(`WatchFn ingestion returned HTTP ${response.status}`, response.status);
      } catch (error) { failure = error; }
      finally { if (timer !== undefined) clearTimeout(timer); }
      if (!retryable || attempt >= this.config.retries!) throw failure;
      await new Promise(resolve => setTimeout(resolve, Math.min(this.config.retryDelayMs! * 2 ** attempt, 60000)));
    }
  }
}

export function init(config: BrowserConfig) { return new BrowserClient(config); }

/**
 * HTTP sink for batched, bounded log transport
 */

import type { LogEvent, PipelineStage, Sink } from "../types.js";
import { redactSecFn, type RedactionOptions } from "../pipeline/redact.js";

/** Request passed to the fetch implementation */
export interface HttpSinkRequest {
  method: "POST";
  headers: Record<string, string>;
  body: string;
  signal?: AbortSignal;
  keepalive?: boolean;
}

/** Minimal fetch contract used by the sink */
export type HttpSinkFetch = (
  url: string,
  init: HttpSinkRequest
) => Promise<{ ok: boolean; status: number; statusText?: string }>;

/** Why events were dropped instead of delivered */
export type HttpSinkDropReason =
  | "queue_full"
  | "delivery_failed"
  | "closed"
  | "redaction_failed";

/**
 * HTTP sink options
 */
export interface HttpSinkOptions {
  /** Target http(s) URL for log ingestion; must not embed credentials */
  url: string;

  /** Events per request; a full batch is sent immediately (default: 50) */
  batch?: number;

  /** Flush interval in milliseconds for partial batches (default: 1000) */
  flushIntervalMs?: number;

  /** Per-attempt request timeout in milliseconds (default: 3000) */
  timeoutMs?: number;

  /** Additional headers */
  headers?: Record<string, string>;

  /**
   * Authentication: the token is sent as `Authorization: Bearer <token>`, or
   * as the value of `secretHeader` when that is set.
   */
  auth?: {
    token?: string;
    secretHeader?: string;
  };

  /** Retry configuration for network errors, timeouts, 408, 429 and 5xx */
  retry?: {
    /** Total attempts per batch (default: 5) */
    attempts?: number;
    /** Base backoff, doubled per attempt (default: 200) */
    backoffMs?: number;
  };

  /** Offline buffer strategy; only in-memory buffering is supported */
  offlineBuffer?: "memory";

  /** Maximum queued events; the oldest are dropped beyond it (default: 5000) */
  maxQueue?: number;

  /**
   * Extra redaction options. Every event is redacted before it is queued;
   * this cannot be disabled.
   */
  redact?: RedactionOptions;

  /** fetch implementation (default: globalThis.fetch, resolved per request) */
  fetch?: HttpSinkFetch;

  /** Receives delivery failures (default: console.error) */
  onError?: (error: Error) => void;

  /** Receives the number of events dropped and why */
  onDrop?: (count: number, reason: HttpSinkDropReason) => void;
}

/** Delivery counters */
export interface HttpSinkStats {
  /** Events waiting in the queue */
  queued: number;
  /** Events in the request being sent */
  inFlight: number;
  /** Events accepted by the collector */
  sent: number;
  /** Events dropped (queue overflow, failed delivery, closed sink, redaction failure) */
  dropped: number;
  /** Batches that failed after all attempts */
  failedBatches: number;
}

/** Sink returned by sinkHttp */
export interface HttpSink extends Sink {
  /** Send everything queued so far; never rejects */
  flush(): Promise<void>;
  /** Stop accepting events, then flush; never rejects */
  close(): Promise<void>;
  /** Snapshot of the delivery counters */
  stats(): HttpSinkStats;
}

type AttemptResult = { kind: "sent" } | { kind: "retry" | "fail"; error: Error };

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < 1) {
    throw new Error(`sinkHttp: ${name} must be a positive integer`);
  }
  return resolved;
}

function nonNegative(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isFinite(resolved) || resolved < 0) {
    throw new Error(`sinkHttp: ${name} must be a non-negative number`);
  }
  return resolved;
}

function validateUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("sinkHttp: url must be an absolute http(s) URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("sinkHttp: url must be an absolute http(s) URL");
  }
  if (parsed.username || parsed.password) {
    throw new Error("sinkHttp: url must not contain credentials; use auth.token");
  }
}

// Timers must not keep a Node process alive just to deliver logs.
function unref(timer: ReturnType<typeof setTimeout>): void {
  (timer as { unref?: () => void }).unref?.();
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => unref(setTimeout(resolve, ms)));
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

/**
 * Create an HTTP sink. Constructing it performs no I/O; events are redacted,
 * queued (bounded by maxQueue) and posted as `{"events": [...]}` in batches.
 * Calling the sink never throws and never waits for the network.
 */
export function sinkHttp(options: HttpSinkOptions): HttpSink {
  const { url, headers = {}, auth } = options;
  validateUrl(url);
  const batchSize = positiveInteger(options.batch, 50, "batch");
  const maxQueue = positiveInteger(options.maxQueue, 5000, "maxQueue");
  const attempts = positiveInteger(options.retry?.attempts, 5, "retry.attempts");
  const backoffMs = nonNegative(options.retry?.backoffMs, 200, "retry.backoffMs");
  const flushIntervalMs = nonNegative(options.flushIntervalMs, 1000, "flushIntervalMs");
  const timeoutMs = nonNegative(options.timeoutMs, 3000, "timeoutMs");
  const redact: PipelineStage = redactSecFn(options.redact);
  const onError =
    options.onError ??
    ((error: Error) => {
      console.error("[logfn http-sink error]", error);
    });

  const requestHeaders: Record<string, string> = {
    "Content-Type": "application/json",
    ...headers,
  };
  if (auth?.token) {
    requestHeaders[auth.secretHeader || "Authorization"] = auth.secretHeader
      ? auth.token
      : `Bearer ${auth.token}`;
  }

  const queue: LogEvent[] = [];
  const counters = { sent: 0, dropped: 0, failedBatches: 0 };
  let inFlight = 0;
  let closed = false;
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  let draining: Promise<void> | null = null;

  function safely(callback: () => void): void {
    try {
      callback();
    } catch {
      // Callbacks supplied by the caller must not break delivery.
    }
  }

  function drop(count: number, reason: HttpSinkDropReason): void {
    if (count <= 0) return;
    counters.dropped += count;
    if (options.onDrop) safely(() => options.onDrop?.(count, reason));
  }

  async function attempt(body: string): Promise<AttemptResult> {
    const fetchImpl: HttpSinkFetch =
      options.fetch ??
      ((target, init) => (globalThis.fetch as unknown as HttpSinkFetch)(target, init));
    if (!options.fetch && typeof globalThis.fetch !== "function") {
      return { kind: "fail", error: new Error("fetch is not available; pass options.fetch") };
    }

    const controller = typeof AbortController === "function" ? new AbortController() : undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller?.abort();
        reject(new Error(`timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      unref(timer);
    });
    const keepalive = typeof window !== "undefined" && body.length <= 60_000;

    try {
      const response = await Promise.race([
        fetchImpl(url, {
          method: "POST",
          headers: requestHeaders,
          body,
          signal: controller?.signal,
          ...(keepalive ? { keepalive } : {}),
        }),
        timeout,
      ]);
      if (response.ok) return { kind: "sent" };
      const error = new Error(
        `HTTP ${response.status}${response.statusText ? `: ${response.statusText}` : ""}`
      );
      return { kind: isRetryableStatus(response.status) ? "retry" : "fail", error };
    } catch (error) {
      return { kind: "retry", error: toError(error) };
    } finally {
      clearTimeout(timer);
    }
  }

  async function deliver(events: LogEvent[]): Promise<void> {
    const body = JSON.stringify({ events });
    let lastError = new Error("not sent");
    for (let index = 0; index < attempts; index++) {
      if (index > 0) {
        // Exponential backoff with jitter
        await delay(backoffMs * Math.pow(2, index - 1) + Math.random() * 100);
      }
      const result = await attempt(body);
      if (result.kind === "sent") return;
      lastError = result.error;
      if (result.kind === "fail") break;
    }
    throw lastError;
  }

  function clearFlushTimer(): void {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
  }

  function scheduleFlush(): void {
    if (flushTimer || draining) {
      return;
    }
    flushTimer = setTimeout(() => {
      flushTimer = null;
      void drain();
    }, flushIntervalMs);
    unref(flushTimer);
  }

  // Sends the events queued when it starts, one batch at a time. Later events
  // are picked up by the next drain so a flush cannot be held open forever.
  function drain(): Promise<void> {
    if (draining) return draining;
    clearFlushTimer();
    draining = (async () => {
      let budget = queue.length;
      while (budget > 0 && queue.length > 0) {
        const events = queue.splice(0, Math.min(batchSize, budget));
        budget -= events.length;
        inFlight = events.length;
        try {
          await deliver(events);
          counters.sent += events.length;
        } catch (error) {
          counters.failedBatches += 1;
          drop(events.length, "delivery_failed");
          safely(() => onError(toError(error)));
        } finally {
          inFlight = 0;
        }
      }
    })().finally(() => {
      draining = null;
      if (queue.length >= batchSize) {
        void drain();
      } else if (queue.length > 0 && !closed) {
        scheduleFlush();
      }
    });
    return draining;
  }

  const sink = function httpSink(batch: LogEvent[]): void {
    try {
      if (!Array.isArray(batch) || batch.length === 0) return;
      if (closed) {
        drop(batch.length, "closed");
        return;
      }
      for (const event of batch) {
        let redacted: LogEvent | null;
        try {
          redacted = redact(event);
        } catch (error) {
          drop(1, "redaction_failed");
          safely(() => onError(toError(error)));
          continue;
        }
        if (redacted) queue.push(redacted);
      }
      if (queue.length > maxQueue) {
        drop(queue.splice(0, queue.length - maxQueue).length, "queue_full");
      }
      if (queue.length >= batchSize) {
        void drain();
      } else if (queue.length > 0) {
        scheduleFlush();
      }
    } catch (error) {
      safely(() => onError(toError(error)));
    }
  } as HttpSink;

  sink.flush = async (): Promise<void> => {
    clearFlushTimer();
    if (draining) await draining;
    if (queue.length > 0) await drain();
    clearFlushTimer();
  };

  sink.close = async (): Promise<void> => {
    closed = true;
    await sink.flush();
  };

  sink.stats = (): HttpSinkStats => ({
    queued: queue.length,
    inFlight,
    sent: counters.sent,
    dropped: counters.dropped,
    failedBatches: counters.failedBatches,
  });

  return sink;
}

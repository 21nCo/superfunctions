/**
 * HTTP sink for batched, bounded log transport
 */

import type { LogEvent, PipelineStage, Sink } from "../types.js";
import { redactSecFn, type RedactionOptions } from "../pipeline/redact.js";
import { sanitizeEvent, validateAndSerialize } from "../validation.js";

/** Request passed to the fetch implementation */
export interface HttpSinkRequest {
  method: "POST";
  headers: Record<string, string>;
  body: string;
  signal?: AbortSignal;
  keepalive?: boolean;
  /** Always "manual": a redirect is a failed delivery, never followed */
  redirect: "manual";
}

/** Response fields used by the sink */
export interface HttpSinkResponse {
  ok: boolean;
  status: number;
  statusText?: string;
  type?: string;
  /** Never read: the sink cancels it so the connection is released */
  body?: { cancel?(): Promise<void> } | null;
}

/** Minimal fetch contract used by the sink */
export type HttpSinkFetch = (url: string, init: HttpSinkRequest) => Promise<HttpSinkResponse>;

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

  /** Per-attempt request timeout in milliseconds, above 0 (default: 3000) */
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

  /**
   * Retry configuration for network errors, timeouts, 408, 429 and 5xx.
   * Redirects are not followed and fail the batch without a retry.
   */
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
   * Extra redaction options. Every event is made JSON-safe, redacted (every
   * field, keys included) and size-bounded before it is queued; this cannot
   * be disabled.
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
  /** Send or drop every event accepted before the call; never rejects */
  flush(): Promise<void>;
  /** Stop accepting events, then send or drop everything accepted; never rejects */
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

function positive(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isFinite(resolved) || resolved <= 0) {
    throw new Error(`sinkHttp: ${name} must be a positive number`);
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

type Timer = ReturnType<typeof setTimeout>;

function unref(timer: Timer): void {
  (timer as { unref?: () => void }).unref?.();
}

function ref(timer: Timer): void {
  (timer as { ref?: () => void }).ref?.();
}

const encoder = new TextEncoder();

// Browsers reject keepalive requests whose body is over 64 KiB.
const KEEPALIVE_MAX_BYTES = 60_000;

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function isRedirect(response: { status: number; type?: string }): boolean {
  return response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400);
}

// Only the status is used. An unread body keeps its connection (and stream)
// open for as long as the collector holds it, so it is cancelled at once.
function release(response: HttpSinkResponse | undefined): void {
  try {
    const cancelled = response?.body?.cancel?.();
    if (cancelled && typeof cancelled.then === "function") cancelled.then(undefined, () => {});
  } catch {
    // A locked or already closed body needs no release.
  }
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
  // A zero timeout would fail every attempt and drop every batch.
  const timeoutMs = positive(options.timeoutMs, 3000, "timeoutMs");
  const redact: PipelineStage = redactSecFn(options.redact);
  // What is sent is exactly what was redacted: JSON-safe values first, so
  // serialization cannot add text (toJSON, bigint), then size-bounded.
  const prepare = (event: LogEvent): LogEvent | null => {
    const redacted = redact(sanitizeEvent(event));
    return redacted ? validateAndSerialize(redacted).event : null;
  };
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
  // Positions in the stream of accepted events: `accepted` events were queued
  // so far, `removed` left the front of the queue (sent, in flight or
  // dropped). Each batch in flight is recorded by its first position, so no
  // drain can hide another's batch from flush().
  let accepted = 0;
  let removed = 0;
  const inFlight = new Set<{ start: number; count: number }>();
  let closed = false;
  let flushTimer: Timer | null = null;
  let draining: Promise<void> | null = null;
  // Background timers never keep a Node process alive, but while a caller
  // awaits flush() or close() the retry backoff and request timeout must.
  const deliveryTimers = new Set<Timer>();
  let holders = 0;

  function startTimer(callback: () => void, ms: number): Timer {
    const timer = setTimeout(() => {
      deliveryTimers.delete(timer);
      callback();
    }, ms);
    deliveryTimers.add(timer);
    if (holders === 0) unref(timer);
    return timer;
  }

  function stopTimer(timer: Timer | undefined): void {
    if (timer === undefined) return;
    clearTimeout(timer);
    deliveryTimers.delete(timer);
  }

  function hold(): () => void {
    holders += 1;
    if (holders === 1) deliveryTimers.forEach(ref);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      holders -= 1;
      if (holders === 0) deliveryTimers.forEach(unref);
    };
  }

  function delay(ms: number): Promise<void> {
    return new Promise((resolve) => startTimer(resolve, ms));
  }

  function safely(callback: () => void): void {
    try {
      callback();
    } catch {
      // Callbacks supplied by the caller must not break delivery.
    }
  }

  // onError and onDrop may log to this sink, which can fail or drop again (a
  // closed sink, a full queue). Such a nested error or drop is counted but
  // not reported to the callback that is running, so a callback is never
  // re-entered and one event cannot start a recursion.
  let reportingError = false;
  let reportingDrop = false;
  // Events accepted while onError or onDrop ran (the callback's own
  // diagnostics). A batch made only of them that fails or is dropped later
  // is counted, and its error goes to console.error, but neither callback is
  // called for it: otherwise a collector that always fails would turn one
  // event into an endless chain of requests and callbacks.
  const feedback = new WeakSet<LogEvent>();

  function onlyFeedback(events: LogEvent[]): boolean {
    return events.length > 0 && events.every((event) => feedback.has(event));
  }

  function report(error: unknown, fromFeedback = false): void {
    if (fromFeedback) {
      safely(() => console.error("[logfn http-sink error]", toError(error)));
      return;
    }
    if (reportingError) return;
    reportingError = true;
    try {
      safely(() => onError(toError(error)));
    } finally {
      reportingError = false;
    }
  }

  function drop(count: number, reason: HttpSinkDropReason, fromFeedback = false): void {
    if (count <= 0) return;
    counters.dropped += count;
    if (!options.onDrop || reportingDrop || fromFeedback) return;
    reportingDrop = true;
    try {
      safely(() => options.onDrop?.(count, reason));
    } finally {
      reportingDrop = false;
    }
  }

  async function attempt(body: string): Promise<AttemptResult> {
    const fetchImpl: HttpSinkFetch =
      options.fetch ??
      ((target, init) => (globalThis.fetch as unknown as HttpSinkFetch)(target, init));
    if (!options.fetch && typeof globalThis.fetch !== "function") {
      return { kind: "fail", error: new Error("fetch is not available; pass options.fetch") };
    }

    const controller = typeof AbortController === "function" ? new AbortController() : undefined;
    let timer: Timer | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = startTimer(() => {
        controller?.abort();
        reject(new Error(`timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    });
    // Checked in UTF-8 bytes: a body of multibyte text is longer than its
    // string length, and an oversized keepalive request always fails.
    const keepalive =
      typeof window !== "undefined" && encoder.encode(body).length <= KEEPALIVE_MAX_BYTES;

    // Every response is released, also one that arrives after the timeout (a
    // fetch that ignores the abort signal). The async wrapper turns a fetch
    // that throws synchronously into a rejection.
    const request = (async () =>
      fetchImpl(url, {
        method: "POST",
        headers: requestHeaders,
        body,
        signal: controller?.signal,
        redirect: "manual",
        ...(keepalive ? { keepalive } : {}),
      }))();
    request.then(release, () => {});

    try {
      const response = await Promise.race([request, timeout]);
      if (isRedirect(response)) {
        // Following could send the body and credentials to another origin.
        return {
          kind: "fail",
          error: new Error(`HTTP ${response.status}: redirects are not followed`),
        };
      }
      if (response.ok) return { kind: "sent" };
      const error = new Error(
        `HTTP ${response.status}${response.statusText ? `: ${response.statusText}` : ""}`
      );
      return { kind: isRetryableStatus(response.status) ? "retry" : "fail", error };
    } catch (error) {
      return { kind: "retry", error: toError(error) };
    } finally {
      stopTimer(timer);
      // Ends whatever the attempt still holds (a timed-out request, a body
      // stream) on every outcome; a settled request is not affected.
      controller?.abort();
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
  // The guard is set before any caller code runs: fetch, onDrop and onError
  // run synchronously inside the drain and may log to this sink or call
  // flush()/close(), which then join this drain instead of starting another.
  function drain(): Promise<void> {
    if (draining) return draining;
    clearFlushTimer();
    let settle!: () => void;
    const current = new Promise<void>((resolve) => {
      settle = resolve;
    });
    draining = current;
    void (async () => {
      try {
        let budget = queue.length;
        while (budget > 0 && queue.length > 0) {
          const events = queue.splice(0, Math.min(batchSize, budget));
          budget -= events.length;
          const batch = { start: removed, count: events.length };
          removed += events.length;
          inFlight.add(batch);
          try {
            await deliver(events);
            counters.sent += events.length;
          } catch (error) {
            const fromFeedback = onlyFeedback(events);
            counters.failedBatches += 1;
            drop(events.length, "delivery_failed", fromFeedback);
            report(error, fromFeedback);
          } finally {
            inFlight.delete(batch);
          }
        }
      } finally {
        draining = null;
        settle();
        if (queue.length >= batchSize) {
          void drain();
        } else if (queue.length > 0 && !closed) {
          scheduleFlush();
        }
      }
    })();
    return current;
  }

  const sink = function httpSink(batch: LogEvent[]): void {
    try {
      if (!Array.isArray(batch) || batch.length === 0) return;
      if (closed) {
        drop(batch.length, "closed");
        return;
      }
      // Only the newest maxQueue events of a batch could stay queued, so the
      // older ones are dropped without being prepared (copied).
      const excess = batch.length - maxQueue;
      if (excess > 0) drop(excess, "queue_full");
      for (const event of excess > 0 ? batch.slice(excess) : batch) {
        let redacted: LogEvent | null;
        try {
          redacted = prepare(event);
        } catch (error) {
          drop(1, "redaction_failed");
          report(error);
          continue;
        }
        // Preparation and onDrop/onError run caller code (toJSON, callbacks)
        // that could close the sink, so each event is checked again: one
        // arriving after close() started is dropped, never queued behind
        // close()'s flush (the Python sink checks under a lock).
        if (closed) {
          drop(1, "closed");
        } else if (redacted) {
          if (reportingError || reportingDrop) feedback.add(redacted);
          queue.push(redacted);
          accepted += 1;
        }
      }
      if (queue.length > maxQueue) {
        const overflow = queue.splice(0, queue.length - maxQueue);
        removed += overflow.length;
        drop(overflow.length, "queue_full", onlyFeedback(overflow));
      }
      if (queue.length >= batchSize) {
        void drain();
      } else if (queue.length > 0) {
        scheduleFlush();
      }
    } catch (error) {
      report(error);
    }
  } as HttpSink;

  // Whether an event accepted before position `target` is still queued or in flight
  function unsettled(target: number): boolean {
    if (removed < target) return true;
    for (const batch of inFlight) if (batch.start < target) return true;
    return false;
  }

  // Waits until every event accepted before the call is sent or dropped, across
  // as many drains as that takes (a drain only sends what was queued when it
  // started). Events logged while this waits are not part of it; drain()
  // leaves them with an interval timer (or a new drain for a full batch).
  sink.flush = async (): Promise<void> => {
    const release = hold();
    const target = accepted;
    try {
      clearFlushTimer();
      while (unsettled(target)) await drain();
    } finally {
      release();
    }
  };

  sink.close = async (): Promise<void> => {
    closed = true;
    await sink.flush();
  };

  sink.stats = (): HttpSinkStats => ({
    queued: queue.length,
    inFlight: [...inFlight].reduce((total, batch) => total + batch.count, 0),
    sent: counters.sent,
    dropped: counters.dropped,
    failedBatches: counters.failedBatches,
  });

  return sink;
}

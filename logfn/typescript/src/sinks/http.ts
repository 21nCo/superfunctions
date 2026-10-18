/**
 * HTTP sink for batched log transport
 */

import type { LogEvent, Sink } from "../types.js";

/**
 * HTTP sink options
 */
export interface HttpSinkOptions {
  /** Target URL for log ingestion */
  url: string;

  /** Batch size before flushing (default: 50) */
  batch?: number;

  /** Flush interval in milliseconds (default: 1000) */
  flushIntervalMs?: number;

  /** Request timeout in milliseconds (default: 3000) */
  timeoutMs?: number;

  /** Additional headers */
  headers?: Record<string, string>;

  /** Authentication */
  auth?: {
    token?: string;
    secretHeader?: string;
  };

  /** Retry configuration */
  retry?: {
    attempts?: number;
    backoffMs?: number;
  };

  /** Offline buffer strategy */
  offlineBuffer?: "memory" | "indexeddb";

  /** Maximum queue size (default: 5000) */
  maxQueue?: number;
}

/**
 * Create an HTTP sink
 */
export interface HttpSink extends Sink {
  /** Drain accepted events and remove owned timers/listeners. Failed close is retryable. */
  close(): Promise<void>;
}

export function sinkHttp(options: HttpSinkOptions): HttpSink {
  const {
    url,
    batch: batchSize = 50,
    flushIntervalMs = 1000,
    timeoutMs = 3000,
    headers = {},
    auth,
    retry = {},
    maxQueue = 5000,
  } = options;

  const { attempts = 5, backoffMs = 200 } = retry;

  let closed = false;
  let closing: Promise<void> | null = null;
  let buffer: LogEvent[] = [];
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  let flushing: Promise<void> | null = null;
  for (const [name, value] of Object.entries({ batchSize, flushIntervalMs, timeoutMs, maxQueue, attempts })) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${name} must be a positive safe integer`);
  }
  if (!Number.isFinite(backoffMs) || backoffMs < 0) throw new RangeError("backoffMs must be finite and nonnegative");

  /**
   * Send events to the HTTP endpoint with retry
   */
  async function sendBatch(events: LogEvent[], keepalive = false): Promise<void> {
    const requestHeaders: Record<string, string> = {
      "Content-Type": "application/json",
      ...headers,
    };

    if (auth?.token) {
      requestHeaders["Authorization"] = `Bearer ${auth.token}`;
    }
    if (auth?.secretHeader) {
      requestHeaders[auth.secretHeader] = auth.token || "";
    }

    let lastError: unknown = new Error("Request failed");
    for (let attempt = 0; attempt < attempts; attempt++) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
      let terminal = false;
      try {
        const response = await fetch(url, {
          method: "POST", headers: requestHeaders,
          body: JSON.stringify({ events }), signal: controller.signal,
          ...(keepalive ? { keepalive: true } : {}),
        });
        if (response.ok) {
          await response.body?.cancel();
          return;
        }
        terminal = response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429;
        lastError = new Error(`HTTP ${response.status}: ${response.statusText}`);
        await response.body?.cancel();
      } catch (error) {
        lastError = error;
      } finally {
        clearTimeout(timeoutId);
      }
      if (terminal) throw lastError;
      if (attempt < attempts - 1) {
        const delay = Math.min(5000, backoffMs * 2 ** Math.min(attempt, 30) + Math.random() * 100);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
    throw lastError;
  }

  /** All callers join the active drain; failed batches remain queued. */
  function flushBuffer(keepalive = false): Promise<void> {
    if (flushing) return flushing;
    if (buffer.length === 0) return Promise.resolve();
    let failed = false;
    const drain = async () => {
      while (buffer.length > 0) {
        const toSend = buffer.splice(0, batchSize);
        try {
          await sendBatch(toSend, keepalive);
        } catch (error) {
          failed = true;
          // Preserve queue order and the documented newest-events overflow policy.
          buffer = [...toSend, ...buffer].slice(-maxQueue);
          throw error;
        }
      }
    };
    flushing = drain().finally(() => {
      flushing = null;
      if (!failed && buffer.length > 0) scheduleFlush();
    });
    return flushing;
  }

  function backgroundFlush(keepalive = false): void {
    if (closed) return;
    void flushBuffer(keepalive).catch(error => console.error("[logfn http-sink error]", error));
  }

  /**
   * Schedule a flush
   */
  function scheduleFlush(): void {
    if (flushTimer || closed || closing) {
      return;
    }

    flushTimer = setTimeout(() => {
      flushTimer = null;
      backgroundFlush();
    }, flushIntervalMs);
  }

  const browserWindow = typeof window === "undefined" ? undefined : window;
  const browserDocument = typeof document === "undefined" ? undefined : document;
  const visibilityHandler = () => {
    if (browserDocument?.visibilityState === "hidden") backgroundFlush();
  };
  const unloadHandler = () => {
    if (closed || buffer.length === 0) return;
    // Beacon cannot carry configured authentication or custom headers. Keep
    // such deliveries on fetch, preserving their request contract.
    if (!auth?.token && !auth?.secretHeader && Object.keys(headers).length === 0 &&
        typeof navigator !== "undefined" && navigator.sendBeacon) {
      const events = buffer.slice(0, batchSize);
      let blob = new Blob([JSON.stringify({ events })], { type: "application/json" });
      while (blob.size > 60000 && events.length > 0) {
        events.pop();
        blob = new Blob([JSON.stringify({ events })], { type: "application/json" });
      }
      try {
        if (events.length > 0 && navigator.sendBeacon(url, blob)) return;
      } catch { /* Fall back to fetch; queue remains retained. */ }
    }
    backgroundFlush(true);
  };
  browserDocument?.addEventListener("visibilitychange", visibilityHandler);
  browserWindow?.addEventListener("beforeunload", unloadHandler);

  const sink: HttpSink = (batch: LogEvent[]) => {
    if (closed || closing) throw new Error("HTTP sink is closed");
    // Add to buffer
    buffer.push(...batch);

    // Drop oldest if over limit
    if (buffer.length > maxQueue) {
      const excess = buffer.length - maxQueue;
      buffer.splice(0, excess);
    }

    // Flush if batch size reached
    if (buffer.length >= batchSize) {
      backgroundFlush();
    } else {
      scheduleFlush();
    }
  };

  sink.flush = async (): Promise<void> => {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    await flushBuffer();
  };

  sink.close = (): Promise<void> => {
    if (closed) return Promise.resolve();
    if (closing) return closing;
    closing = (async () => {
      await sink.flush!();
      closed = true;
      browserDocument?.removeEventListener("visibilitychange", visibilityHandler);
      browserWindow?.removeEventListener("beforeunload", unloadHandler);
    })().finally(() => { closing = null; });
    return closing;
  };

  return sink;
}

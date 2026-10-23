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
export function sinkHttp(options: HttpSinkOptions): Sink {
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

  let buffer: LogEvent[] = [];
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  let flushing = false;

  /**
   * Send events to the HTTP endpoint with retry
   */
  async function sendBatch(events: LogEvent[]): Promise<void> {
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

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    let lastError: Error | null = null;

    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        const response = await fetch(url, {
          method: "POST",
          headers: requestHeaders,
          body: JSON.stringify({ events }),
          signal: controller.signal,
        });

        clearTimeout(timeoutId);

        if (response.ok) {
          return; // Success
        }

        // Don't retry on client errors
        if (response.status >= 400 && response.status < 500) {
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        // Retry on server errors
        lastError = new Error(
          `HTTP ${response.status}: ${response.statusText}`
        );
      } catch (error) {
        clearTimeout(timeoutId);
        lastError = error as Error;

        // Don't retry on abort
        if (lastError.name === "AbortError") {
          throw lastError;
        }
      }

      // Exponential backoff with jitter
      if (attempt < attempts - 1) {
        const delay = backoffMs * Math.pow(2, attempt) + Math.random() * 100;
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }

    throw lastError || new Error("Unknown error");
  }

  /**
   * Flush buffered events
   */
  async function flushBuffer(): Promise<void> {
    if (flushing || buffer.length === 0) {
      return;
    }

    flushing = true;
    const toSend = buffer.splice(0, buffer.length);

    try {
      await sendBatch(toSend);
    } catch (error) {
      // On error, put events back at the front (up to maxQueue)
      const putBack = toSend.slice(0, Math.max(0, maxQueue - buffer.length));
      buffer.unshift(...putBack);

      // Log error internally (without recursion)
      console.error("[logfn http-sink error]", error);
    } finally {
      flushing = false;
    }
  }

  /**
   * Schedule a flush
   */
  function scheduleFlush(): void {
    if (flushTimer) {
      return;
    }

    flushTimer = setTimeout(() => {
      flushTimer = null;
      flushBuffer().catch(() => {
        // Error already handled in flushBuffer
      });
    }, flushIntervalMs);
  }

  /**
   * Add events to browser flush hooks
   */
  if (typeof window !== "undefined") {
    window.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") {
        flushBuffer().catch(() => {});
      }
    });

    window.addEventListener("beforeunload", () => {
      // Synchronous flush attempt (may not complete)
      if (buffer.length > 0) {
        // Use sendBeacon if available
        if (navigator.sendBeacon) {
          const blob = new Blob([JSON.stringify({ events: buffer })], {
            type: "application/json",
          });
          navigator.sendBeacon(url, blob);
        }
      }
    });
  }

  const sink: Sink = (batch: LogEvent[]) => {
    // Add to buffer
    buffer.push(...batch);

    // Drop oldest if over limit
    if (buffer.length > maxQueue) {
      const excess = buffer.length - maxQueue;
      buffer.splice(0, excess);
    }

    // Flush if batch size reached
    if (buffer.length >= batchSize) {
      flushBuffer().catch(() => {});
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

  return sink;
}

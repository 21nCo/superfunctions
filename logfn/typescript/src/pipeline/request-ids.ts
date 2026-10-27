/**
 * Request ID and trace context pipeline stage
 */

import type { LogEvent, PipelineStage } from "../types.js";

/**
 * Request ID options
 */
export interface RequestIdOptions {
  /** Header name containing W3C TraceContext (default: 'traceparent') */
  header?: string;

  /** Custom ID generator function */
  generate?: () => { traceId?: string; spanId?: string; requestId?: string };
}

/**
 * Parse W3C TraceContext traceparent header
 * Format: version-traceId-spanId-flags
 * Example: 00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01
 */
function parseTraceParent(
  traceparent: string
): { traceId: string; spanId: string } | null {
  const parts = traceparent.split("-");
  if (parts.length !== 4) {
    return null;
  }

  const [version, traceId, spanId] = parts;

  // Version must be 00 for now
  if (version !== "00") {
    return null;
  }

  // Validate format: lowercase hex, not all zeros
  if (!/^[0-9a-f]{32}$/.test(traceId) || !/^[0-9a-f]{16}$/.test(spanId)) {
    return null;
  }
  if (/^0+$/.test(traceId) || /^0+$/.test(spanId)) {
    return null;
  }

  return { traceId, spanId };
}

/**
 * Generate a random hex string
 */
function randomHex(bytes: number): string {
  const values = new Uint8Array(bytes);
  const webCrypto = (globalThis as { crypto?: { getRandomValues?(array: Uint8Array): Uint8Array } })
    .crypto;
  if (webCrypto?.getRandomValues) {
    webCrypto.getRandomValues(values);
  } else {
    // Fallback for older environments
    for (let i = 0; i < bytes; i++) {
      values[i] = Math.floor(Math.random() * 256);
    }
  }
  return Array.from(values, (value) => value.toString(16).padStart(2, "0")).join("");
}

/**
 * Default ID generator
 */
function defaultGenerate(): {
  traceId: string;
  spanId: string;
  requestId: string;
} {
  return {
    traceId: randomHex(16), // 32 hex chars
    spanId: randomHex(8), // 16 hex chars
    requestId: randomHex(16),
  };
}

/**
 * Create a request ID pipeline stage
 */
export function withRequestIds(options: RequestIdOptions = {}): PipelineStage {
  const generate = options.generate ?? defaultGenerate;

  return function withRequestIdsStage(event: LogEvent): LogEvent {
    // If event already has IDs, don't override
    if (event.traceId || event.spanId || event.requestId) {
      return event;
    }

    // Try to parse from header if available (in practice this would come from context)
    // For now, just generate new IDs
    const ids = generate();

    return {
      ...event,
      traceId: ids.traceId ?? event.traceId,
      spanId: ids.spanId ?? event.spanId,
      requestId: ids.requestId ?? event.requestId,
    };
  };
}

/**
 * Parse W3C TraceContext from traceparent header value
 * Exported for use in middleware
 */
export function parseW3CTraceContext(
  traceparent: string
): { traceId: string; spanId: string } | null {
  return parseTraceParent(traceparent);
}

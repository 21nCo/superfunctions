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

  // Validate format
  if (traceId.length !== 32 || spanId.length !== 16) {
    return null;
  }

  return { traceId, spanId };
}

/**
 * Generate a random hex string
 */
function randomHex(bytes: number): string {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    // Use crypto.randomUUID and convert to hex
    return crypto
      .randomUUID()
      .replace(/-/g, "")
      .slice(0, bytes * 2);
  }

  // Fallback for older environments
  const hex = "0123456789abcdef";
  let result = "";
  for (let i = 0; i < bytes * 2; i++) {
    result += hex[Math.floor(Math.random() * 16)];
  }
  return result;
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

  return (event: LogEvent): LogEvent => {
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

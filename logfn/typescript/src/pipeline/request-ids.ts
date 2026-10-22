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
  // W3C Trace Context sections3.2.2 and3.2.4: lowercase hexadecimal,
  // nonzero identifiers, exact v00 layout, additive future versions.
  const match = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})(.*)$/.exec(traceparent);
  if (!match || match[0] !== traceparent) return null;
  const [, version, traceId, spanId, , suffix] = match;
  if (version === "ff" || /^0+$/.test(traceId) || /^0+$/.test(spanId)) return null;
  if (version === "00" ? suffix !== "" : suffix !== "" && !suffix.startsWith("-")) return null;

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
    if (event.traceId && event.spanId && event.requestId) {
      return event;
    }

    // Try to parse from header if available (in practice this would come from context)
    // For now, just generate new IDs
    const ids = generate();

    return {
      ...event,
      traceId: event.traceId ?? ids.traceId,
      spanId: event.spanId ?? ids.spanId,
      requestId: event.requestId ?? ids.requestId,
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

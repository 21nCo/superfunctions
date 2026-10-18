/**
 * Core request logger middleware
 */

import type { Logger } from "../core/logger.js";
import { parseW3CTraceContext } from "../pipeline/request-ids.js";

/**
 * Request logger options
 */
export interface RequestLoggerOptions {
  /** Header containing W3C TraceContext (default: 'traceparent') */
  header?: string;

  /** Headers to redact from logs */
  redactHeaders?: string[];

  /** Sampling rate (0-1) or per-level rates */
  sample?: number | Record<string, number>;

  /** Custom logger instance (optional) */
  logger?: Logger;

  /** Capture request/response body (default: false) */
  includeBody?: boolean;

  /** Function to extract user/tenant from request */
  captureUser?: (
    req: any
  ) => { userId?: string; tenantId?: string } | undefined;
}

/**
 * Request metadata for logging
 */
export interface RequestMetadata {
  method: string;
  url: string;
  path: string;
  headers: Record<string, string>;
  query?: Record<string, string>;
  traceId?: string;
  spanId?: string;
  requestId?: string;
  userId?: string;
  tenantId?: string;
  body?: any;
}

/**
 * Response metadata for logging
 */
export interface ResponseMetadata {
  statusCode: number;
  contentLength?: number;
  latencyMs: number;
}

/**
 * Extract correlation IDs from request headers
 */
export function extractCorrelationIds(
  headers: Record<string, string | string[] | undefined>,
  headerName = "traceparent"
): { traceId?: string; spanId?: string; requestId?: string } {
  const traceparent = headers[headerName.toLowerCase()];
  const traceparentValue = Array.isArray(traceparent)
    ? traceparent[0]
    : traceparent;

  if (traceparentValue) {
    const parsed = parseW3CTraceContext(traceparentValue);
    if (parsed) {
      return {
        traceId: parsed.traceId,
        spanId: parsed.spanId,
        requestId: generateRequestId(),
      };
    }
  }

  // Generate new IDs if not present
  return {
    traceId: generateTraceId(),
    spanId: generateSpanId(),
    requestId: generateRequestId(),
  };
}

/**
 * Generate trace ID (32 hex chars)
 */
function generateTraceId(): string {
  return randomHex(16);
}

/**
 * Generate span ID (16 hex chars)
 */
function generateSpanId(): string {
  return randomHex(8);
}

/**
 * Generate request ID
 */
function generateRequestId(): string {
  return randomHex(16);
}

/**
 * Generate random hex string
 */
function randomHex(bytes: number): string {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return crypto
      .randomUUID()
      .replace(/-/g, "")
      .slice(0, bytes * 2);
  }

  const hex = "0123456789abcdef";
  let result = "";
  for (let i = 0; i < bytes * 2; i++) {
    result += hex[Math.floor(Math.random() * 16)];
  }
  return result;
}

/**
 * Redact sensitive headers
 */
export function redactHeaders(
  headers: Record<string, string | string[] | undefined>,
  redactList: string[] = [
    "authorization",
    "cookie",
    "x-api-key",
    "x-auth-token",
  ]
): Record<string, string> {
  const result: Record<string, string> = {};
  const redactSet = new Set(["authorization", "cookie", "x-api-key", "x-auth-token", ...redactList.map((h) => h.toLowerCase())]);

  for (const [key, value] of Object.entries(headers)) {
    if (!value) continue;

    const normalizedKey = key.toLowerCase();
    const stringValue = Array.isArray(value) ? value[0] : value;

    if (redactSet.has(normalizedKey)) {
      result[key] = "[redacted]";
    } else {
      result[key] = stringValue;
    }
  }

  return result;
}

/**
 * Truncate body to max size
 */
export function truncateBody(body: any, maxSize = 8192): any {
  if (!body) return undefined;

  const serialized = typeof body === "string" ? body : JSON.stringify(body);

  if (serialized.length <= maxSize) {
    return body;
  }

  return {
    _truncated: true,
    _size: serialized.length,
    _preview: serialized.slice(0, 200),
  };
}

/** One decision for the automatic info-level request/response pair. */
export function createRequestSampler(sample: RequestLoggerOptions["sample"]): () => boolean {
  const rates = typeof sample === "number" ? [sample] : Object.values(sample ?? {});
  if (rates.some(rate => !Number.isFinite(rate) || rate < 0 || rate > 1)) {
    throw new RangeError("Request sample rates must be finite numbers between zero and one");
  }
  const rate = typeof sample === "number" ? sample : sample?.info ?? 1;
  return () => rate === 1 || (rate > 0 && Math.random() < rate);
}

/**
 * Core request logger middleware
 */

import { sanitizeValue } from "../validation.js";
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

  /** Maximum time spent reading a Fetch request body for logs (default: 100ms). */
  bodyCaptureTimeoutMs?: number;

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
  if (body === null || body === undefined) return undefined;
  if (!Number.isFinite(maxSize) || maxSize < 64) {
    throw new RangeError("Body capture limit must be at least 64 bytes");
  }
  const cleaned = sanitizeValue(body);
  const serialized = JSON.stringify(cleaned);
  const encoder = new TextEncoder();
  const size = encoder.encode(serialized).byteLength;
  if (size <= maxSize) return cleaned;

  const result = { _truncated: true, _size: size, _preview: "" };
  // Bound the complete JSON value, including metadata and escaped characters.
  for (const point of Array.from(typeof cleaned === "string" ? cleaned : serialized).slice(0, 200)) {
    const previous = result._preview;
    result._preview += point;
    if (encoder.encode(JSON.stringify(result)).byteLength > maxSize) {
      result._preview = previous;
      break;
    }
  }
  return result;
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


/** Read only a bounded prefix from a clone; leave the application branch intact. */
export async function captureRequestBody(request: Request, timeoutMs = 100): Promise<unknown> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError("Body capture timeout must be a positive finite number");
  }
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = 8192;
  let bytes = 0;
  let text = "";
  const decoder = new TextDecoder();
  const timeout = Symbol("timeout");
  const deadline = new Promise<typeof timeout>(resolve => {
    timer = setTimeout(() => resolve(timeout), timeoutMs);
  });
  try {
    reader = request.clone().body?.getReader();
    if (!reader) return undefined;
    while (bytes < limit) {
      const result = await Promise.race([reader.read(), deadline]);
      if (result === timeout) return { _omitted: "body_capture_timeout" };
      if (result.done) return truncateBody(text + decoder.decode());
      const chunk = result.value.subarray(0, limit - bytes);
      bytes += chunk.byteLength;
      text += decoder.decode(chunk, { stream: true });
    }
    // Total size is unknown: don't drain the request just to measure it.
    return { _truncated: true, _capturedBytes: bytes, _preview: Array.from(text).slice(0, 200).join("") };
  } catch {
    return { _omitted: "body_unavailable" };
  } finally {
    clearTimeout(timer);
    // A tee branch's cancel promise may wait for the application branch.
    // Awaiting it here would deadlock before the route can consume its body.
    if (reader) void reader.cancel().catch(() => {});
  }
}

/**
 * Validation utilities for log events
 */

import type { LogEvent, SerializationResult } from "./types.js";
import { MAX_EVENT_SIZE, MAX_TAGS } from "./types.js";
import { CIRCULAR, MAX_DEPTH, MAX_REDACTION_DEPTH, UNSERIALIZABLE, isBinary } from "./pipeline/redact.js";

const TRUNCATED_SUFFIX = "...[truncated]";
const encoder = new TextEncoder();

/**
 * Checks if a value is serializable to JSON
 */
export function isSerializable(value: unknown): boolean {
  const type = typeof value;
  return type !== "function" && type !== "symbol" && type !== "bigint";
}

function sanitizeNode(value: unknown, ancestors: Set<object>, depth: number): unknown {
  if (value === undefined || value === null) {
    return value;
  }

  const type = typeof value;
  if (type === "function" || type === "symbol" || type === "bigint") {
    return UNSERIALIZABLE;
  }
  if (type === "number") {
    return Number.isFinite(value) ? value : String(value);
  }
  if (type !== "object") {
    return value;
  }

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? String(value) : value.toISOString();
  }
  const object = value as object;
  // Each byte would become a number that no text rule can redact.
  if (isBinary(object)) {
    return UNSERIALIZABLE;
  }
  if (ancestors.has(object)) {
    return CIRCULAR;
  }
  if (depth >= MAX_REDACTION_DEPTH) {
    return MAX_DEPTH;
  }

  ancestors.add(object);
  try {
    if (Array.isArray(object)) {
      return object.map((item) => {
        const cleaned = sanitizeNode(item, ancestors, depth + 1);
        return cleaned === undefined ? null : cleaned;
      });
    }

    if (object instanceof Error) {
      const error: Record<string, unknown> = {
        name: String(object.name),
        message: String(object.message),
      };
      if (typeof object.stack === "string") {
        error.stack = object.stack;
      }
      const cause = (object as { cause?: unknown }).cause;
      if (cause !== undefined) {
        error.cause = sanitizeNode(cause, ancestors, depth + 1);
      }
      return error;
    }

    const sanitized: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(object)) {
      const cleaned = sanitizeNode(item, ancestors, depth + 1);
      if (cleaned !== undefined) {
        sanitized[key] = cleaned;
      }
    }
    return sanitized;
  } finally {
    ancestors.delete(object);
  }
}

/**
 * Replaces non-serializable values with JSON-safe equivalents: functions,
 * symbols and bigints become "[unserializable]", dates become ISO strings,
 * errors become {name, message, stack, cause} and cycles become "[circular]".
 */
export function sanitizeValue(value: unknown): unknown {
  return sanitizeNode(value, new Set(), 0);
}

/** Longest kept string for a metadata field once an event is over the size limit */
export const MAX_METADATA_CHARS = 256;

const METADATA_FIELDS = [
  "ts",
  "level",
  "name",
  "version",
  "traceId",
  "spanId",
  "requestId",
  "userId",
  "tenantId",
] as const;

function byteLength(event: LogEvent): number {
  return encoder.encode(JSON.stringify(event)).length;
}

function tagText(tag: unknown): string {
  return typeof tag === "string" ? tag : JSON.stringify(sanitizeValue(tag) ?? null);
}

/**
 * Returns a JSON-safe copy of every field of an event: msg becomes a string,
 * tags (at most MAX_TAGS) strings, and every other field is sanitized like
 * ctx. Undefined fields are removed.
 */
export function sanitizeEvent(event: LogEvent): LogEvent {
  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(event)) {
    if (value === undefined) continue;
    if (key === "msg") {
      sanitized.msg = String(value);
    } else if (key === "tags" && Array.isArray(value)) {
      sanitized.tags = value.slice(0, MAX_TAGS).map(tagText);
    } else {
      sanitized[key] = sanitizeValue(value);
    }
  }
  if (sanitized.msg === undefined) sanitized.msg = "";
  return sanitized as unknown as LogEvent;
}

function truncate(text: string, keep: number): string {
  let end = Math.max(0, keep);
  // Never split a surrogate pair: a lone surrogate serializes as six bytes.
  const last = text.charCodeAt(end - 1);
  if (end > 0 && last >= 0xd800 && last <= 0xdbff) end -= 1;
  return text.slice(0, end) + TRUNCATED_SUFFIX;
}

// Schema metadata only, as strings of at most MAX_METADATA_CHARS; fields
// outside the schema and non-string metadata are removed.
function boundMetadata(event: LogEvent): LogEvent {
  const bounded: Record<string, unknown> = { msg: event.msg, ctx: event.ctx };
  if (event.tags !== undefined) bounded.tags = event.tags;
  for (const field of METADATA_FIELDS) {
    const value: unknown = event[field];
    if (typeof value !== "string") continue;
    bounded[field] =
      value.length > MAX_METADATA_CHARS
        ? truncate(value, MAX_METADATA_CHARS - TRUNCATED_SUFFIX.length)
        : value;
  }
  return bounded as unknown as LogEvent;
}

/**
 * Validates and serializes a log event, enforcing size limits: the result is
 * always at most MAX_EVENT_SIZE bytes of UTF-8 JSON. An event over the limit
 * loses its ctx (replaced by a truncation marker). If the fields other than
 * msg still take more than half the limit, metadata is cut to the schema
 * fields of at most MAX_METADATA_CHARS characters each, then the tags are
 * removed. Finally the message is shortened to fit.
 */
export function validateAndSerialize(event: LogEvent): SerializationResult {
  let finalEvent = sanitizeEvent(event);
  const originalSize = byteLength(finalEvent);
  if (originalSize <= MAX_EVENT_SIZE) {
    return { event: finalEvent, truncated: false };
  }

  finalEvent = {
    ...finalEvent,
    ctx: { _truncated: true, _reason: "size_limit", _originalSize: originalSize },
  };
  const withoutMessage = () => byteLength({ ...finalEvent, msg: "" });
  if (withoutMessage() > MAX_EVENT_SIZE / 2) {
    finalEvent = boundMetadata(finalEvent);
    if (withoutMessage() > MAX_EVENT_SIZE / 2) delete finalEvent.tags;
  }
  const overflow = byteLength(finalEvent) - MAX_EVENT_SIZE;
  if (overflow > 0) {
    // Every removed character frees at least one byte, and the other fields
    // take at most half the limit, so this fits.
    finalEvent = {
      ...finalEvent,
      msg: truncate(finalEvent.msg, finalEvent.msg.length - overflow - TRUNCATED_SUFFIX.length),
    };
  }

  return { event: finalEvent, truncated: true };
}

/**
 * Validates a log event schema
 */
export function isValidLogEvent(event: unknown): event is LogEvent {
  if (!event || typeof event !== "object") {
    return false;
  }

  const e = event as Partial<LogEvent>;

  // Required fields
  if (!e.ts || typeof e.ts !== "string") return false;
  if (!e.level || typeof e.level !== "string") return false;
  if (!e.msg || typeof e.msg !== "string") return false;
  if (!e.name || typeof e.name !== "string") return false;
  if (!e.version || typeof e.version !== "string") return false;

  return true;
}

/**
 * Validation utilities for log events
 */

import type { LogEvent, SerializationResult } from "./types.js";
import { MAX_EVENT_SIZE, MAX_TAGS } from "./types.js";
import { CIRCULAR, MAX_DEPTH, MAX_REDACTION_DEPTH } from "./pipeline/redact.js";

const UNSERIALIZABLE = "[unserializable]";
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

function byteLength(event: LogEvent): number {
  return encoder.encode(JSON.stringify(event)).length;
}

/**
 * Validates and serializes a log event, enforcing size limits. An event over
 * MAX_EVENT_SIZE bytes loses its ctx (replaced by a truncation marker) and,
 * if still too large, has its message shortened.
 */
export function validateAndSerialize(event: LogEvent): SerializationResult {
  const sanitized: LogEvent = {
    ...event,
    msg: String(event.msg),
    ctx:
      event.ctx !== undefined
        ? (sanitizeValue(event.ctx) as Record<string, unknown>)
        : undefined,
    tags: Array.isArray(event.tags)
      ? event.tags.slice(0, MAX_TAGS).map((tag) => String(tag))
      : undefined,
  };

  // Remove undefined fields
  const cleaned: Partial<LogEvent> = {};
  for (const [key, value] of Object.entries(sanitized)) {
    if (value !== undefined) {
      cleaned[key as keyof LogEvent] = value as never;
    }
  }

  let finalEvent = cleaned as LogEvent;
  const originalSize = byteLength(finalEvent);
  if (originalSize <= MAX_EVENT_SIZE) {
    return { event: finalEvent, truncated: false };
  }

  finalEvent = {
    ...finalEvent,
    ctx: { _truncated: true, _reason: "size_limit", _originalSize: originalSize },
  };
  const overflow = byteLength(finalEvent) - MAX_EVENT_SIZE;
  if (overflow > 0) {
    // Every removed character frees at least one byte, so this fits unless
    // the remaining fields alone are too large; then the tags go as well.
    const keep = Math.max(0, finalEvent.msg.length - overflow - TRUNCATED_SUFFIX.length);
    finalEvent = { ...finalEvent, msg: finalEvent.msg.slice(0, keep) + TRUNCATED_SUFFIX };
    if (byteLength(finalEvent) > MAX_EVENT_SIZE) {
      delete finalEvent.tags;
    }
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

/**
 * Validation utilities for log events
 */

import type { LogEvent, SerializationResult } from "./types.js";
import { MAX_EVENT_SIZE, MAX_TAGS } from "./types.js";

/**
 * Checks if a value is serializable to JSON
 */
export function isSerializable(value: unknown): boolean {
  if (value === null || value === undefined) {
    return true;
  }

  const type = typeof value;

  if (type === "function" || type === "symbol" || type === "bigint") {
    return false;
  }

  if (type === "object") {
    // Check for circular references would be expensive
    // We'll rely on JSON.stringify catching those
    return true;
  }

  return true;
}

/**
 * Replaces non-serializable values with a placeholder
 */
export function sanitizeValue(value: unknown): unknown {
  if (value === undefined) {
    return undefined; // Will be dropped by Object.entries filter
  }

  if (value === null) {
    return null;
  }

  const type = typeof value;

  if (type === "function" || type === "symbol" || type === "bigint") {
    return "[unserializable]";
  }

  if (type === "object") {
    if (Array.isArray(value)) {
      return value.map(sanitizeValue);
    }

    if (value instanceof Date) {
      return value.toISOString();
    }

    if (value instanceof Error) {
      return {
        name: value.name,
        message: value.message,
        stack: value.stack,
      };
    }

    // Plain object - sanitize recursively
    const sanitized: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
      const cleaned = sanitizeValue(val);
      if (cleaned !== undefined) {
        sanitized[key] = cleaned;
      }
    }
    return sanitized;
  }

  return value;
}

/**
 * Validates and serializes a log event, enforcing size limits
 */
export function validateAndSerialize(event: LogEvent): SerializationResult {
  // Sanitize the event
  const sanitized: LogEvent = {
    ...event,
    ctx: event.ctx
      ? (sanitizeValue(event.ctx) as Record<string, unknown>)
      : undefined,
    tags: event.tags?.slice(0, MAX_TAGS),
  };

  // Remove undefined fields
  const cleaned: Partial<LogEvent> = {};
  for (const [key, value] of Object.entries(sanitized)) {
    if (value !== undefined) {
      cleaned[key as keyof LogEvent] = value as never;
    }
  }

  let finalEvent = cleaned as LogEvent;
  let truncated = false;

  // Check size
  let serialized = JSON.stringify(finalEvent);
  if (serialized.length > MAX_EVENT_SIZE) {
    // Truncate context to fit
    truncated = true;
    const overhead = serialized.length - MAX_EVENT_SIZE;
    const ctxString = JSON.stringify(finalEvent.ctx || {});

    if (ctxString.length > overhead + 100) {
      // Truncate context
      const truncatedCtx = ctxString.slice(
        0,
        Math.max(0, ctxString.length - overhead - 100)
      );
      finalEvent = {
        ...finalEvent,
        ctx: {
          ...finalEvent.ctx,
          _truncated: true,
          _originalSize: ctxString.length,
        },
      };

      // Try to keep some context
      try {
        const parsed = JSON.parse(truncatedCtx + "}");
        finalEvent.ctx = { ...parsed, _truncated: true };
      } catch {
        // If parsing fails, just note truncation
        finalEvent.ctx = { _truncated: true, _reason: "size_limit" };
      }
    } else {
      // Even without context we're over, drop it entirely
      finalEvent.ctx = { _truncated: true, _reason: "size_limit" };
    }
  }

  return { event: finalEvent, truncated };
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

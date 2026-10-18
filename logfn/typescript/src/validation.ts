/**
 * Validation utilities for log events
 */

import type { LogEvent, SerializationResult } from "./types.js";
import { MAX_EVENT_SIZE, MAX_TAGS, LOG_LEVEL_VALUES } from "./types.js";

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
  const ancestors = new WeakSet<object>();
  const visit = (input: unknown, depth: number): unknown => {
    if (input === null || input === undefined) return input;
    if (["function", "symbol", "bigint"].includes(typeof input)) return "[unserializable]";
    if (typeof input !== "object") return input;
    if (ancestors.has(input)) return "[circular]";
    if (depth >= 64) return "[depth_limit]";
    ancestors.add(input);
    try {
      if (input instanceof Date) return Number.isFinite(input.getTime()) ? input.toISOString() : "[unserializable]";
      if (input instanceof Error) return { name: input.name, message: input.message, stack: input.stack };
      if (Array.isArray(input)) return input.map(item => visit(item, depth + 1));
      const output: Record<string, unknown> = {};
      for (const key of Object.keys(input)) {
        let cleaned: unknown;
        try { cleaned = visit((input as Record<string, unknown>)[key], depth + 1); }
        catch { cleaned = "[unserializable]"; }
        if (cleaned !== undefined) {
          Object.defineProperty(output, key, { value: cleaned, enumerable: true, configurable: true, writable: true });
        }
      }
      return output;
    } catch {
      return "[unserializable]";
    } finally {
      ancestors.delete(input);
    }
  };
  return visit(value, 0);
}

const encoder = new TextEncoder();
const jsonSize = (value: unknown): number => encoder.encode(JSON.stringify(value)).byteLength;

/** Sanitize first, then enforce the UTF-8 wire size without slicing JSON. */
export function validateAndSerialize(event: LogEvent): SerializationResult {
  const finalEvent = sanitizeValue(event) as LogEvent;
  if (finalEvent.tags) finalEvent.tags = finalEvent.tags.slice(0, MAX_TAGS);
  if (jsonSize(finalEvent) <= MAX_EVENT_SIZE) return { event: finalEvent, truncated: false };

  const context = finalEvent.ctx;
  finalEvent.ctx = { _truncated: true, _reason: "size_limit" };
  const required = new Set(["ts", "level", "msg", "name", "version", "ctx"]);
  // Preserve the envelope before allocating its remaining budget to context.
  for (const key of Object.keys(finalEvent)) {
    if (jsonSize(finalEvent) <= MAX_EVENT_SIZE) break;
    if (!required.has(key)) delete (finalEvent as unknown as Record<string, unknown>)[key];
  }
  for (const key of ["msg", "name", "version", "ts"] as const) {
    if (jsonSize(finalEvent) <= MAX_EVENT_SIZE) break;
    const points = Array.from(finalEvent[key]);
    let low = 1, high = points.length;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      finalEvent[key] = points.slice(0, mid).join("");
      if (jsonSize(finalEvent) <= MAX_EVENT_SIZE) low = mid;
      else high = mid - 1;
    }
    finalEvent[key] = points.slice(0, low).join("");
  }
  let remaining = MAX_EVENT_SIZE - jsonSize(finalEvent);
  for (const [key, value] of Object.entries(context ?? {})) {
    if (key === "_truncated" || key === "_reason") continue;
    const cost = jsonSize(key) + 1 + jsonSize(value) + 1;
    if (cost <= remaining) {
      Object.defineProperty(finalEvent.ctx, key, { value, enumerable: true, configurable: true, writable: true });
      remaining -= cost;
    }
  }
  return { event: finalEvent, truncated: true };
}

/**
 * Validates a log event schema
 */
export function isValidLogEvent(event: unknown): event is LogEvent {
  if (!event || typeof event !== "object" || Array.isArray(event)) {
    return false;
  }

  const e = event as Partial<LogEvent>;

  // Required fields
  if (!e.ts || typeof e.ts !== "string") return false;
  if (typeof e.level !== "string" || !Object.hasOwn(LOG_LEVEL_VALUES, e.level)) return false;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(e.ts) || !Number.isFinite(Date.parse(e.ts))) return false;
  if (e.ctx !== undefined && (e.ctx === null || typeof e.ctx !== "object" || Array.isArray(e.ctx))) return false;
  if (e.tags !== undefined && (!Array.isArray(e.tags) || e.tags.length > MAX_TAGS || e.tags.some(tag => typeof tag !== "string"))) return false;
  for (const key of ["traceId", "spanId", "requestId", "userId", "tenantId"] as const) {
    if (e[key] !== undefined && typeof e[key] !== "string") return false;
  }
  if (!e.msg || typeof e.msg !== "string") return false;
  if (!e.name || typeof e.name !== "string") return false;
  if (!e.version || typeof e.version !== "string") return false;

  return true;
}

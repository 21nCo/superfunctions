/**
 * Redaction pipeline stage
 */

import type { LogEvent, PipelineStage } from "../types.js";

/**
 * Redaction options
 */
export interface RedactionOptions {
  /** Patterns to redact (default: common secrets) */
  patterns?: RegExp[];

  /** Allowlist of keys to skip redaction */
  allowlist?: string[];
}

/**
 * Default secret patterns
 */
const DEFAULT_PATTERNS = [
  /api[_-]?key[_-]?=?[\w-]+/gi,
  /token[_-]?=?[\w-]+/gi,
  /password[_-]?=?[\w-]+/gi,
  /authorization:\s*\S+/gi,
  /bearer\s+[\w-]+/gi,
  /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g, // Email
];

/**
 * Redact a string value
 */
function redactString(value: string, patterns: RegExp[]): string {
  let result = value;
  for (const pattern of patterns) {
    result = result.replace(pattern, "[redacted]");
  }
  return result;
}

/**
 * Redact object values recursively
 */
function redactValue(
  value: unknown,
  patterns: RegExp[],
  allowlist: Set<string>,
  path = ""
): unknown {
  if (typeof value === "string") {
    return allowlist.has(path) ? value : redactString(value, patterns);
  }

  if (Array.isArray(value)) {
    return value.map((item, i) =>
      redactValue(item, patterns, allowlist, `${path}[${i}]`)
    );
  }

  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
      const newPath = path ? `${path}.${key}` : key;
      result[key] = redactValue(val, patterns, allowlist, newPath);
    }
    return result;
  }

  return value;
}

/**
 * Create a redaction pipeline stage
 */
export function redactSecFn(options: RedactionOptions = {}): PipelineStage {
  const patterns = options.patterns ?? DEFAULT_PATTERNS;
  const allowlist = new Set(options.allowlist ?? []);

  return (event: LogEvent): LogEvent => {
    const redacted: LogEvent = {
      ...event,
      msg: redactString(event.msg, patterns),
    };

    // Redact context
    if (event.ctx) {
      redacted.ctx = redactValue(event.ctx, patterns, allowlist) as Record<
        string,
        unknown
      >;
    }

    // Redact IDs if not allowlisted
    if (event.userId && !allowlist.has("userId")) {
      redacted.userId = redactString(event.userId, patterns);
    }
    if (event.tenantId && !allowlist.has("tenantId")) {
      redacted.tenantId = redactString(event.tenantId, patterns);
    }

    return redacted;
  };
}

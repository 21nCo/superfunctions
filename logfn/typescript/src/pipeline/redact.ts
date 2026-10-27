/**
 * Redaction pipeline stage
 *
 * The rules here are mirrored by the Python package (logfn/python) and both
 * are checked against conformance/redaction-vectors.json. Change them together.
 */

import type { LogEvent, PipelineStage } from "../types.js";

/** Replacement written in place of a redacted value */
export const REDACTED = "[redacted]";

/** Replacement for a reference back to an object that is still being walked */
export const CIRCULAR = "[circular]";

/** Replacement for values nested deeper than MAX_REDACTION_DEPTH */
export const MAX_DEPTH = "[max-depth]";

/** Nesting depth after which values are replaced by MAX_DEPTH */
export const MAX_REDACTION_DEPTH = 32;

/**
 * Redaction options
 */
export interface RedactionOptions {
  /**
   * Extra string patterns to redact (default: email addresses). Supplying
   * patterns replaces the default extras; the built-in credential rules
   * (sensitive keys, URL credentials, key=value pairs, bearer tokens) always run.
   */
  patterns?: RegExp[];

  /**
   * Paths that skip redaction: ctx paths such as `user.email` or `items[0]`,
   * and `userId` or `tenantId`. Only the exact path is exempt.
   */
  allowlist?: string[];

  /** Extra key names to treat as sensitive (compared after normalization) */
  keys?: string[];

  /** Replacement text (default: REDACTED) */
  replacement?: string;
}

// Keys are compared lowercased with every non-alphanumeric character removed,
// so `X-Api-Key`, `api_key` and `apiKey` all normalize to `xapikey`/`apikey`.
const SENSITIVE_EXACT = new Set([
  "auth",
  "pwd",
  "pass",
  "session",
  "sid",
  "sig",
  "csrf",
  "xsrf",
  "otp",
]);
const SENSITIVE_PARTS = [
  "password",
  "passwd",
  "passphrase",
  "secret",
  "apikey",
  "accesskey",
  "privatekey",
  "authorization",
  "cookie",
  "credential",
  "sessionid",
  "bearer",
];
// Suffix-only so counters such as maxTokens or tokenCount are kept.
const SENSITIVE_SUFFIXES = ["token", "jwt", "signature"];
// For these header names a `name: value` match redacts the rest of the line.
const HEADER_LINE_KEYS = new Set([
  "authorization",
  "proxyauthorization",
  "cookie",
  "setcookie",
]);

// Whitespace is spelled out as ASCII so both runtimes agree on Unicode spaces.
const URL_USERINFO = /(?<![A-Za-z0-9+.-])([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^ \t\n\r\f\v/?#@]+@/g;
const KEY_SEPARATOR = /(["']?)(?<![A-Za-z0-9_.-])([A-Za-z0-9_.-]+)\1([ \t]*[:=][ \t]*)/g;
const ASSIGNED_VALUE =
  /(?:(?:bearer|basic|digest|negotiate)[ \t]+)?(?:"[^"\r\n]*"?|'[^'\r\n]*'?|[^ \t\n\r\f\v&;,#"'}\]]+)/iy;
const LINE_VALUE = /[^\r\n]+/y;
const BEARER_TOKEN = /(?<![A-Za-z0-9])(bearer)[ \t]+[A-Za-z0-9\-._~+/]+=*/gi;
const EMAIL = /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}(?![A-Za-z0-9])/g;

/** Default extra patterns applied after the credential rules */
export const DEFAULT_PATTERNS: readonly RegExp[] = [EMAIL];

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Whether a key name denotes a credential, using the built-in rules plus any
 * extra names (normalized the same way).
 */
export function isSensitiveKey(key: string, extraKeys: Iterable<string> = []): boolean {
  const normalized = normalizeKey(key);
  if (normalized === "") return false;
  if (SENSITIVE_EXACT.has(normalized)) return true;
  if (SENSITIVE_PARTS.some((part) => normalized.includes(part))) return true;
  if (SENSITIVE_SUFFIXES.some((suffix) => normalized.endsWith(suffix))) return true;
  for (const extra of extraKeys) {
    if (normalizeKey(extra) === normalized) return true;
  }
  return false;
}

interface CompiledRedactor {
  replacement: string;
  patterns: RegExp[];
  allowlist: Set<string>;
  isSensitive(key: string): boolean;
}

function compile(options: RedactionOptions): CompiledRedactor {
  const extraKeys = new Set((options.keys ?? []).map(normalizeKey));
  extraKeys.delete("");
  return {
    replacement: options.replacement ?? REDACTED,
    patterns: (options.patterns ?? DEFAULT_PATTERNS).map((pattern) =>
      pattern.global ? pattern : new RegExp(pattern.source, `${pattern.flags}g`)
    ),
    allowlist: new Set(options.allowlist ?? []),
    isSensitive: (key) => isSensitiveKey(key) || extraKeys.has(normalizeKey(key)),
  };
}

// Scans `name<sep>value` pairs. A non-sensitive pair consumes only its name and
// separator so a credential inside the value (for example a query string after
// `https:`) is still found.
function redactAssignments(input: string, redactor: CompiledRedactor): string {
  const { replacement } = redactor;
  let output = "";
  let copied = 0;
  KEY_SEPARATOR.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = KEY_SEPARATOR.exec(input)) !== null) {
    const valueStart = match.index + match[0].length;
    if (!redactor.isSensitive(match[2]) || input.startsWith(replacement, valueStart)) {
      continue;
    }
    const next = input[valueStart];
    const toLineEnd =
      match[3].includes(":") &&
      HEADER_LINE_KEYS.has(normalizeKey(match[2])) &&
      next !== '"' &&
      next !== "'";
    const valuePattern = toLineEnd ? LINE_VALUE : ASSIGNED_VALUE;
    valuePattern.lastIndex = valueStart;
    const value = valuePattern.exec(input);
    if (!value) continue;
    const quote = value[0][0] === '"' || value[0][0] === "'" ? value[0][0] : "";
    output += input.slice(copied, valueStart) + quote + replacement + quote;
    copied = valueStart + value[0].length;
    KEY_SEPARATOR.lastIndex = copied;
  }
  return copied === 0 ? input : output + input.slice(copied);
}

function redactText(value: string, redactor: CompiledRedactor): string {
  const { replacement } = redactor;
  let result = value.replace(URL_USERINFO, (_match, scheme: string) => `${scheme}${replacement}@`);
  result = redactAssignments(result, redactor);
  result = result.replace(BEARER_TOKEN, (_match, scheme: string) => `${scheme} ${replacement}`);
  for (const pattern of redactor.patterns) {
    pattern.lastIndex = 0;
    result = result.replace(pattern, replacement);
  }
  return result;
}

function childPath(path: string, key: string): string {
  return path ? `${path}.${key}` : key;
}

function redactNode(
  value: unknown,
  redactor: CompiledRedactor,
  path: string,
  ancestors: Set<object>,
  depth: number
): unknown {
  if (typeof value === "string") {
    return redactor.allowlist.has(path) ? value : redactText(value, redactor);
  }
  if (value === null || typeof value !== "object" || value instanceof Date) {
    return value;
  }
  if (ancestors.has(value)) {
    return CIRCULAR;
  }
  if (depth >= MAX_REDACTION_DEPTH) {
    return MAX_DEPTH;
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item, index) =>
        redactNode(item, redactor, `${path}[${index}]`, ancestors, depth + 1)
      );
    }

    if (value instanceof Error) {
      const error: Record<string, unknown> = {
        name: String(value.name),
        message: redactNode(String(value.message), redactor, childPath(path, "message"), ancestors, depth + 1),
      };
      if (typeof value.stack === "string") {
        error.stack = redactNode(value.stack, redactor, childPath(path, "stack"), ancestors, depth + 1);
      }
      const cause = (value as { cause?: unknown }).cause;
      if (cause !== undefined) {
        error.cause = redactNode(cause, redactor, childPath(path, "cause"), ancestors, depth + 1);
      }
      return error;
    }

    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      const itemPath = childPath(path, key);
      result[key] =
        redactor.isSensitive(key) && !redactor.allowlist.has(itemPath)
          ? redactor.replacement
          : redactNode(item, redactor, itemPath, ancestors, depth + 1);
    }
    return result;
  } finally {
    ancestors.delete(value);
  }
}

function redactWith(event: LogEvent, redactor: CompiledRedactor): LogEvent {
  const redacted: LogEvent = {
    ...event,
    msg: redactText(String(event.msg), redactor),
  };

  if (event.ctx !== undefined) {
    redacted.ctx = redactNode(event.ctx, redactor, "", new Set(), 0) as Record<string, unknown>;
  }
  if (Array.isArray(event.tags)) {
    redacted.tags = event.tags.map((tag) =>
      typeof tag === "string" ? redactText(tag, redactor) : tag
    );
  }
  for (const field of ["userId", "tenantId"] as const) {
    const value = event[field];
    if (typeof value === "string" && !redactor.allowlist.has(field)) {
      redacted[field] = redactText(value, redactor);
    }
  }

  return redacted;
}

/**
 * Redact one event: message, ctx (recursively, including errors and cycles),
 * tags, userId and tenantId. Returns a new event; the input is not modified.
 */
export function redactEvent(event: LogEvent, options: RedactionOptions = {}): LogEvent {
  return redactWith(event, compile(options));
}

/**
 * Create a redaction pipeline stage
 */
export function redactSecFn(options: RedactionOptions = {}): PipelineStage {
  const redactor = compile(options);
  return function redactSecFnStage(event: LogEvent): LogEvent {
    return redactWith(event, redactor);
  };
}

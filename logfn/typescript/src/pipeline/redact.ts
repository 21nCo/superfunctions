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

/**
 * Replacement for values with no JSON form, binary data included: text rules
 * cannot see secrets in bytes, so their content is never kept.
 */
export const UNSERIALIZABLE = "[unserializable]";

/** ArrayBuffer, SharedArrayBuffer and every view on one (typed arrays, DataView, Buffer) */
export function isBinary(value: object): boolean {
  return (
    ArrayBuffer.isView(value) ||
    value instanceof ArrayBuffer ||
    (typeof SharedArrayBuffer === "function" && value instanceof SharedArrayBuffer)
  );
}

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
   * and other event fields by name, such as `userId` or `tenantId`. Only the
   * exact path is exempt.
   */
  allowlist?: string[];

  /** Extra key names to treat as sensitive (compared after normalization) */
  keys?: string[];

  /**
   * Replacement text (default: REDACTED). It must not be empty: an empty
   * marker would make `password= next` read as a password of `next`.
   */
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
// Userinfo runs to the last `@` of the authority, as URL parsers read it, so
// an unencoded `@` in a password (`postgres://u:p@ss@db`) is redacted too.
const URL_USERINFO = /(?<![A-Za-z0-9+.-])([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^ \t\n\r\f\v/?#]+@/g;
// A query or fragment parameter: `?name=`, `&name=` or `#name=`.
const QUERY_PARAM = /[?&#]([^=&#? \t\n\r\f\v"'<>]+)=/g;
// The same parameter inside a percent-encoded URL (a redirect target):
// `%3Fname%3D`, `%26name%3D` or `%23name%3D`.
const ENCODED_QUERY_PARAM = /%(?:3F|26|23)((?:[A-Za-z0-9_.~-]|%(?!3D|3F|26|23)[0-9A-Fa-f]{2})+)%3D/gi;
// A query value ends at the next parameter, whitespace, a double quote or an
// escaped quote (a URL inside escaped JSON); commas and semicolons are kept.
// A backslash run is consumed whole, so matching stays linear.
const QUERY_VALUE = /(?:[^&# \t\n\r\f\v"<>\\]|\\+(?![\\"']))*/y;
// An encoded value also ends at an encoded `&` or `#`.
const ENCODED_QUERY_VALUE = /(?:[^&#% \t\n\r\f\v"<>\\]|%(?!2[36])|\\+(?![\\"']))*/iy;
// The name may be quoted, also with escaped quotes (`\"name\":` in JSON
// that was itself serialized into a string), and may be percent-encoded. Any
// whitespace JSON allows may surround the separator; after it, also escaped
// whitespace (`\n`, `\r\n`, `\t` in serialized pretty-printed JSON). Escapes
// are not accepted before the separator: in `x\n\n\n...` every `n` would
// start a name and rescan the run, which is quadratic. At most seven
// backslashes (three levels of escaping) keep matching linear.
const SPACE_BEFORE_SEPARATOR = String.raw`[ \t\r\n]*`;
const SPACE_AFTER_SEPARATOR = String.raw`(?:[ \t\r\n]|\\{1,7}[nrt])*`;
const KEY_SEPARATOR = new RegExp(
  String.raw`(\\{0,7}["']?)(?<![A-Za-z0-9_.%-])([A-Za-z0-9_.%-]+)\1(${SPACE_BEFORE_SEPARATOR}[:=]${SPACE_AFTER_SEPARATOR})`,
  "g"
);
// A quoted name made of several words, such as `"api key":`.
const SPACED_KEY_SEPARATOR = new RegExp(
  String.raw`(\\{0,7}["'])([A-Za-z0-9_.%-]+(?: [A-Za-z0-9_.%-]+)+)\1(${SPACE_BEFORE_SEPARATOR}:${SPACE_AFTER_SEPARATOR})`,
  "g"
);
const AUTH_SCHEME = /(?:bearer|basic|digest|negotiate)[ \t]+/iy;
// Characters that end an unquoted value
const UNQUOTED_STOP = new Set([" ", "\t", "\n", "\r", "\f", "\v", "&", ";", ",", "#", '"', "'"]);
const LINE_REST = /[^\r\n]*/y;
const BEARER_TOKEN = /(?<![A-Za-z0-9])(bearer)[ \t]+[A-Za-z0-9\-._~+/]+=*/gi;
const EMAIL = /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}(?![A-Za-z0-9])/g;

/** Default extra patterns applied after the credential rules */
export const DEFAULT_PATTERNS: readonly RegExp[] = [EMAIL];

// Percent-escapes are decoded first, so `api%5Fkey` is `api_key`. Only ASCII
// escapes matter: everything else is removed by the normalization anyway.
function normalizeKey(key: string): string {
  return key
    .replace(/%([0-9A-Fa-f]{2})/g, (_escape, hex: string) => {
      const code = parseInt(hex, 16);
      return code < 0x80 ? String.fromCharCode(code) : "";
    })
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
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
  const replacement = options.replacement ?? REDACTED;
  if (typeof replacement !== "string" || replacement === "") {
    throw new Error("redaction replacement must be a non-empty string");
  }
  return {
    replacement,
    patterns: (options.patterns ?? DEFAULT_PATTERNS).map((pattern) =>
      pattern.global ? pattern : new RegExp(pattern.source, `${pattern.flags}g`)
    ),
    allowlist: new Set(options.allowlist ?? []),
    isSensitive: (key) => isSensitiveKey(key) || extraKeys.has(normalizeKey(key)),
  };
}

// End of a quoted value whose opening quote is preceded by `slashes`
// backslashes; `from` is just after the opening quote. Each level of string
// escaping doubles the backslashes, so a quote closes the value when the
// backslash run before it is congruent to `slashes` modulo 2 * (slashes + 1):
// 0 (mod 2) for plain quotes, 1 (mod 4) for once-escaped quotes. An
// unterminated value runs to the end of the line.
function quotedValueEnd(input: string, from: number, slashes: number, quote: string): number {
  let index = from;
  while (index < input.length) {
    const char = input[index];
    if (char === "\r" || char === "\n") return index;
    if (char === "\\" || char === quote) {
      let run = 0;
      while (input[index + run] === "\\") run++;
      if (input[index + run] === quote) {
        if (run % (2 * (slashes + 1)) === slashes) return index + run + 1;
        index += run + 1;
      } else {
        index += run;
      }
      continue;
    }
    index++;
  }
  return index;
}

// End of text glued to the end of a quoted or bracketed value, as in
// `"x"TAIL` or `[x]TAIL`. A backslash also ends it, so the escaped
// whitespace after a value in serialized JSON (`\"x\"\n`) is kept.
function gluedEnd(input: string, from: number): number {
  let index = from;
  while (index < input.length && input[index] !== "\\" && !UNQUOTED_STOP.has(input[index])) {
    const char = input[index];
    if (char === "}" || char === "]") break;
    index++;
  }
  return index;
}

// End of an unquoted value: whitespace, a separator, a quote or a closing
// bracket it did not open (`{token=x}`) ends it. Brackets opened inside it
// are part of it, so `abc[1]TAIL` is one value.
function unquotedValueEnd(input: string, from: number): number {
  let depth = 0;
  let index = from;
  for (; index < input.length; index++) {
    const char = input[index];
    if (UNQUOTED_STOP.has(char)) break;
    if (char === "{" || char === "[") {
      depth++;
    } else if (char === "}" || char === "]") {
      if (depth === 0) break;
      depth--;
    }
  }
  return index;
}

interface ScannedValue {
  end: number;
  /** Quote, with its escaping backslashes, written around the replacement */
  quote: string;
}

// End of the bracketed value opening at `start` (`{` or `[`), across lines;
// quoted strings, also escaped ones, are skipped so brackets inside them do
// not count. An unbalanced value runs to the end of the input.
function bracketedValueEnd(input: string, start: number): number {
  let depth = 0;
  let index = start;
  while (index < input.length) {
    const char = input[index];
    if (char === "{" || char === "[") {
      depth++;
      index++;
    } else if (char === "}" || char === "]") {
      depth--;
      index++;
      if (depth === 0) return index;
    } else if (char === "\\" || char === '"' || char === "'") {
      let slashes = 0;
      while (input[index + slashes] === "\\") slashes++;
      const quote = input[index + slashes];
      if (quote === '"' || quote === "'") {
        index = quotedValueEnd(input, index + slashes + 1, slashes, quote);
      } else {
        index += slashes;
      }
    } else {
      index++;
    }
  }
  return index;
}

// The credential value starting at `start`: a value already replaced by
// `replacement` together with anything appended to it, a bracketed value, or
// an optional auth scheme followed by a complete quoted string (escaped quotes
// included) or an unquoted token. Null when nothing is left to redact.
function scanValue(input: string, start: number, replacement: string): ScannedValue | null {
  if (replacement !== "" && input.startsWith(replacement, start)) {
    const end = unquotedValueEnd(input, start + replacement.length);
    return end > start + replacement.length ? { end, quote: "" } : null;
  }
  if (input[start] === "{" || input[start] === "[") {
    // Text glued to the closing bracket, as in `[x]TAIL`, is part of the value.
    return { end: gluedEnd(input, bracketedValueEnd(input, start)), quote: "" };
  }
  AUTH_SCHEME.lastIndex = start;
  const position = AUTH_SCHEME.exec(input) ? AUTH_SCHEME.lastIndex : start;
  let slashes = 0;
  while (input[position + slashes] === "\\") slashes++;
  const quote = input[position + slashes];
  if (quote === '"' || quote === "'") {
    // Text glued to the closing quote, as in `"x"TAIL`, is part of the value.
    return {
      end: gluedEnd(input, quotedValueEnd(input, position + slashes + 1, slashes, quote)),
      quote: input.slice(position, position + slashes + 1),
    };
  }
  for (const from of position === start ? [start] : [position, start]) {
    const end = unquotedValueEnd(input, from);
    if (end > from) return { end, quote: "" };
  }
  return null;
}

function lineEnd(input: string, start: number): number {
  LINE_REST.lastIndex = start;
  LINE_REST.exec(input);
  return LINE_REST.lastIndex;
}

// Redacts the values of sensitive query and fragment parameters up to the
// next parameter, so `?password=one,two` loses all of `one,two`. A value that
// is exactly the replacement is rewritten to itself, so this is idempotent.
function redactQueryParams(
  input: string,
  redactor: CompiledRedactor,
  param: RegExp,
  value: RegExp
): string {
  let output = "";
  let copied = 0;
  param.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = param.exec(input)) !== null) {
    const valueStart = match.index + match[0].length;
    if (!redactor.isSensitive(match[1])) continue;
    value.lastIndex = valueStart;
    value.exec(input);
    const valueEnd = value.lastIndex;
    if (valueEnd === valueStart) continue;
    output += input.slice(copied, valueStart) + redactor.replacement;
    copied = valueEnd;
    param.lastIndex = valueEnd;
  }
  return copied === 0 ? input : output + input.slice(copied);
}

// Scans `name<sep>value` pairs. A non-sensitive pair consumes only its name and
// separator so a credential inside the value (for example a query string after
// `https:`) is still found.
function redactAssignments(input: string, redactor: CompiledRedactor, separator: RegExp): string {
  const { replacement } = redactor;
  let output = "";
  let copied = 0;
  separator.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = separator.exec(input)) !== null) {
    const valueStart = match.index + match[0].length;
    if (!redactor.isSensitive(match[2])) continue;
    const value = scanValue(input, valueStart, replacement);
    // An unquoted `Authorization:` or `Cookie:` header value is the whole line.
    const headerLine =
      (value === null || value.quote === "") &&
      match[3].includes(":") &&
      HEADER_LINE_KEYS.has(normalizeKey(match[2]));
    const valueEnd = headerLine
      ? Math.max(lineEnd(input, valueStart), value?.end ?? valueStart)
      : (value?.end ?? valueStart);
    if (valueEnd === valueStart) continue;
    const quote = headerLine ? "" : (value?.quote ?? "");
    output += input.slice(copied, valueStart) + quote + replacement + quote;
    copied = valueEnd;
    separator.lastIndex = copied;
  }
  return copied === 0 ? input : output + input.slice(copied);
}

function redactText(value: string, redactor: CompiledRedactor): string {
  const { replacement } = redactor;
  let result = value.replace(URL_USERINFO, (_match, scheme: string) => `${scheme}${replacement}@`);
  result = redactQueryParams(result, redactor, QUERY_PARAM, QUERY_VALUE);
  result = redactQueryParams(result, redactor, ENCODED_QUERY_PARAM, ENCODED_QUERY_VALUE);
  result = redactAssignments(result, redactor, KEY_SEPARATOR);
  result = redactAssignments(result, redactor, SPACED_KEY_SEPARATOR);
  result = result.replace(BEARER_TOKEN, (_match, scheme: string) => `${scheme} ${replacement}`);
  for (const pattern of redactor.patterns) {
    pattern.lastIndex = 0;
    // A function keeps the marker literal: `$&` or `$1` are not expanded.
    result = result.replace(pattern, () => replacement);
  }
  return result;
}

function childPath(path: string, key: string): string {
  return path ? `${path}.${key}` : key;
}

// Distinct keys can redact to the same text (two email keys both become the
// marker). Each later one is kept under the first free "<key>#<n>" (n from 2)
// instead of overwriting the earlier value. `used` holds the next n per key.
function uniqueKey(target: Record<string, unknown>, key: string, used: Map<string, number>): string {
  const has = (candidate: string) => Object.prototype.hasOwnProperty.call(target, candidate);
  if (!has(key)) return key;
  let index = used.get(key) ?? 2;
  while (has(`${key}#${index}`)) index += 1;
  used.set(key, index + 1);
  return `${key}#${index}`;
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
  if (isBinary(value)) {
    return UNSERIALIZABLE;
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
        // The name is caller-controlled text (`error.name = ...`), like the message.
        name: redactNode(String(value.name), redactor, childPath(path, "name"), ancestors, depth + 1),
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
    const used = new Map<string, number>();
    for (const [key, item] of Object.entries(value)) {
      const itemPath = childPath(path, key);
      const allowed = redactor.allowlist.has(itemPath);
      // Keys are text too: a map keyed by URL or email must not leak them.
      const outputKey = uniqueKey(result, allowed ? key : redactText(key, redactor), used);
      result[outputKey] =
        redactor.isSensitive(key) && !allowed
          ? redactor.replacement
          : redactNode(item, redactor, itemPath, ancestors, depth + 1);
    }
    return result;
  } finally {
    ancestors.delete(value);
  }
}

// Every top-level field is redacted, including fields outside the LogEvent
// schema that a caller-added stage may have set. Paths for fields other than
// ctx are their names (`userId`, `tags[0]`); ctx paths start at the ctx root.
function redactWith(event: LogEvent, redactor: CompiledRedactor): LogEvent {
  const redacted: Record<string, unknown> = {};
  const used = new Map<string, number>();
  for (const [key, value] of Object.entries(event)) {
    if (key === "msg") {
      redacted.msg = redactText(String(value), redactor);
    } else if (key === "ctx") {
      redacted.ctx = redactNode(value, redactor, "", new Set(), 0);
    } else if (redactor.allowlist.has(key)) {
      redacted[key] = redactNode(value, redactor, key, new Set(), 0);
    } else {
      // Field names are text too, exactly like nested keys.
      redacted[uniqueKey(redacted, redactText(key, redactor), used)] = redactor.isSensitive(key)
        ? redactor.replacement
        : redactNode(value, redactor, key, new Set(), 0);
    }
  }
  return redacted as unknown as LogEvent;
}

/**
 * Redact one event: message, ctx (recursively, including errors and cycles)
 * and every other field, keys included. Returns a new event; the input is not
 * modified.
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

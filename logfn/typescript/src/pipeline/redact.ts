/**
 * Redaction pipeline stage
 *
 * The rules here are mirrored by the Python package (logfn/python) and both
 * are checked against conformance/redaction-vectors.json. Change them together.
 */

import type { LogEvent, PipelineStage } from "../types.js";
import { OWN_BUDGET, sanitizeEvent } from "../validation.js";

/** Replacement written in place of a redacted value */
export const REDACTED = "[redacted]";

/** Replacement for a reference back to an object that is still being walked */
export const CIRCULAR = "[circular]";

/** Replacement for values nested deeper than MAX_REDACTION_DEPTH */
export const MAX_DEPTH = "[max-depth]";

/** Replacement for values past one walk's MAX_TRAVERSAL budget */
export const MAX_SIZE = "[max-size]";

/**
 * Replacement for values with no JSON form, binary data included: text rules
 * cannot see secrets in bytes, so their content is never kept.
 */
export const UNSERIALIZABLE = "[unserializable]";

// Kind checks work across realms (vm contexts, iframes), unlike instanceof: a tag preselects, a built-in that throws without the internal slot confirms.
function attempt<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}
const tagOf = (value: unknown): string => attempt(() => Object.prototype.toString.call(value), "");
const hasBrand = (check: ((this: unknown) => unknown) | undefined, value: unknown) => check !== undefined && attempt(() => (check.call(value), true), false);
const byteLength = (type?: { prototype: object }) => type && Object.getOwnPropertyDescriptor(type.prototype, "byteLength")?.get;
const BUFFER_BRANDS = new Map([["[object ArrayBuffer]", byteLength(ArrayBuffer)], ["[object SharedArrayBuffer]", byteLength(globalThis.SharedArrayBuffer)]]);

/** ArrayBuffer, SharedArrayBuffer and every view on one (typed arrays, DataView, Buffer) */
export const isBinary = (value: object): boolean => ArrayBuffer.isView(value) || hasBrand(BUFFER_BRANDS.get(tagOf(value)), value);
export const isDateValue = (value: unknown): value is Date =>
  typeof value === "object" && value !== null && (value instanceof Date || tagOf(value) === "[object Date]") && hasBrand(Date.prototype.getTime, value);
export const isErrorValue = (value: unknown): value is Error => (Error as { isError?: (value: unknown) => boolean }).isError?.(value) === true ||
  (typeof value === "object" && value !== null && (value instanceof Error ? tagOf(value) !== "[object Object]" :
    tagOf(value) === "[object Error]" && attempt(() => typeof (value as { [Symbol.toStringTag]?: unknown })[Symbol.toStringTag] !== "string", false)));
export const toError = (error: unknown): Error => isErrorValue(error) ? error : new Error(attempt(() => String(error), UNSERIALIZABLE));

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
   * exact path is exempt. Both kinds share one namespace: `userId` exempts the
   * `userId` field and `ctx.userId`, but not `ctx.user.userId`.
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
// A quoted name made of several words, such as `"api key":` or `'api key' =`.
const SPACED_KEY_SEPARATOR = new RegExp(
  String.raw`(\\{0,7}["'])([A-Za-z0-9_.%-]+(?: [A-Za-z0-9_.%-]+)+)\1(${SPACE_BEFORE_SEPARATOR}[:=]${SPACE_AFTER_SEPARATOR})`,
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
// 0 (mod 2) for plain quotes, 1 (mod 4) for once-escaped quotes. The value
// runs across lines to its closing quote, so a multi-line credential (a PEM
// key) is consumed whole; an unterminated value runs to the end of the input.
// Callers redact through the returned end, so no text is scanned twice.
function quotedValueEnd(input: string, from: number, slashes: number, quote: string): number {
  let index = from;
  while (index < input.length) {
    const char = input[index];
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

// Text being redacted, with the [start, end) spans of the markers written so far.
interface Marked {
  text: string;
  marks: number[];
}

// A span to replace by the marker, with text written just before and after it.
interface Edit {
  start: number;
  end: number;
  before?: string;
  after?: string;
}

// Runs one rule. Its trigger matches caller text only, one stretch between
// markers at a time, so no rule reads a marker as part of a key, an email or a
// pattern. `edit` maps a match (`at` is the stretch offset) to the span to
// replace, or null; a value may run on past markers and takes them in.
function rewrite(marked: Marked, trigger: RegExp, replacement: string, edit: (match: RegExpExecArray, at: number) => Edit | null): Marked {
  const { text, marks } = marked;
  const edits: Edit[] = [];
  let from = 0;
  for (let mark = 0; mark <= marks.length; mark += 2) {
    const at = mark === 0 ? 0 : marks[mark - 1];
    const stretch = text.slice(at, mark < marks.length ? marks[mark] : text.length);
    trigger.lastIndex = Math.max(0, from - at);
    let match: RegExpExecArray | null;
    while (trigger.lastIndex <= stretch.length && (match = trigger.exec(stretch)) !== null) {
      const found = edit(match, at);
      if (found) {
        // A marker that touches another one joins it, so redacting twice gives the same text.
        const prev = edits.at(-1);
        if (!found.before && prev?.end === found.start && !prev.after) {
          edits.pop();
          found.start = prev.start;
          found.before = prev.before;
        } else if (!found.before && mark > 0 && found.start === at && (prev?.end ?? 0) <= marks[mark - 2]) {
          found.start = marks[mark - 2];
        }
        for (let next = mark; next < marks.length && (marks[next] < found.end || (!found.after && marks[next] === found.end)); next += 2) found.end = Math.max(found.end, marks[next + 1]);
        edits.push(found);
        from = found.end;
      }
      // An empty match moves on by one, as String.prototype.replace does.
      trigger.lastIndex = Math.max(from - at, match.index + match[0].length, match.index + 1);
    }
  }
  let output = "";
  const spans: number[] = [];
  let copied = 0;
  let mark = 0;
  const copy = (until: number) => {
    // Markers inside a replaced span are dropped; the others keep their place.
    for (; mark < marks.length && marks[mark] < until; mark += 2) {
      if (marks[mark] >= copied) spans.push(output.length + marks[mark] - copied, output.length + marks[mark + 1] - copied);
    }
    output += text.slice(copied, until);
  };
  for (const { start, end, before = "", after = "" } of edits) {
    copy(start);
    output += before;
    spans.push(output.length, output.length + replacement.length);
    output += replacement + after;
    copied = end;
  }
  copy(text.length);
  return { text: output, marks: spans };
}

// Redacts the values of sensitive query and fragment parameters up to the
// next parameter, so `?password=one,two` loses all of `one,two`. A value that
// is exactly the replacement is rewritten to itself, so this is idempotent.
function redactQueryParams(marked: Marked, redactor: CompiledRedactor, param: RegExp, value: RegExp): Marked {
  return rewrite(marked, param, redactor.replacement, (match, at) => {
    const valueStart = at + match.index + match[0].length;
    if (!redactor.isSensitive(match[1])) return null;
    value.lastIndex = valueStart;
    value.exec(marked.text);
    return value.lastIndex === valueStart ? null : { start: valueStart, end: value.lastIndex };
  });
}

// Scans `name<sep>value` pairs. A non-sensitive pair consumes only its name and
// separator so a credential inside the value (for example a query string after
// `https:`) is still found.
function redactAssignments(marked: Marked, redactor: CompiledRedactor, separator: RegExp): Marked {
  const { replacement } = redactor;
  const input = marked.text;
  return rewrite(marked, separator, replacement, (match, at) => {
    const valueStart = at + match.index + match[0].length;
    if (!redactor.isSensitive(match[2])) return null;
    const value = scanValue(input, valueStart, replacement);
    // An unquoted `Authorization:` or `Cookie:` header value is the whole line.
    const headerLine =
      (value === null || value.quote === "") &&
      match[3].includes(":") &&
      HEADER_LINE_KEYS.has(normalizeKey(match[2]));
    const valueEnd = headerLine
      ? Math.max(lineEnd(input, valueStart), value?.end ?? valueStart)
      : (value?.end ?? valueStart);
    if (valueEnd === valueStart) return null;
    const quote = headerLine ? "" : (value?.quote ?? "");
    return { start: valueStart, end: valueEnd, before: quote, after: quote };
  });
}

function redactText(value: string, redactor: CompiledRedactor): string {
  const { replacement } = redactor;
  // The userinfo between the scheme and the last `@` only.
  let result = rewrite({ text: value, marks: [] }, URL_USERINFO, replacement, (match, at) => ({ start: at + match.index + match[1].length, end: at + match.index + match[0].length - 1 }));
  result = redactQueryParams(result, redactor, QUERY_PARAM, QUERY_VALUE);
  result = redactQueryParams(result, redactor, ENCODED_QUERY_PARAM, ENCODED_QUERY_VALUE);
  result = redactAssignments(result, redactor, KEY_SEPARATOR);
  result = redactAssignments(result, redactor, SPACED_KEY_SEPARATOR);
  result = rewrite(result, BEARER_TOKEN, replacement, (match, at) => ({ start: at + match.index + match[1].length, end: at + match.index + match[0].length, before: " " }));
  for (const pattern of redactor.patterns) {
    result = rewrite(result, pattern, replacement, (match, at) => ({ start: at + match.index, end: at + match.index + match[0].length }));
  }
  return result.text;
}

/** Text of a date by the built-in methods only, so no caller override of getTime or toISOString runs */
export function dateText(value: Date): string {
  return Number.isNaN(Date.prototype.getTime.call(value)) ? "Invalid Date" : Date.prototype.toISOString.call(value);
}

const BOXED_VALUE_OF = new Map<string, () => unknown>([
  ["[object String]", String.prototype.valueOf],
  ["[object Number]", Number.prototype.valueOf],
  ["[object Boolean]", Boolean.prototype.valueOf],
  ["[object BigInt]", BigInt.prototype.valueOf],
  ["[object Symbol]", Symbol.prototype.valueOf],
]);

// The primitive in a wrapper such as `new String(x)`, by built-in valueOf.
export function unboxPrimitive(value: object): unknown {
  if (Array.isArray(value)) return value;
  // Every String wrapper has an own length, whatever its tag; a failed check is slow.
  const checks = [Object.prototype.hasOwnProperty.call(value, "length") ? String.prototype.valueOf : undefined, BOXED_VALUE_OF.get(tagOf(value))];
  for (const valueOf of checks) if (hasBrand(valueOf, value)) return valueOf!.call(value);
  return value;
}

export function tagText(tag: unknown): string {
  const value = tag !== null && typeof tag === "object" ? unboxPrimitive(tag) : tag;
  return typeof value === "string" ? value : typeof value === "number" || typeof value === "boolean" ? String(value) : UNSERIALIZABLE;
}

/** A record read by own keys: not an Error, Date, array, boxed primitive or binary data */
export const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null &&
  !(isErrorValue(value) || isDateValue(value) || Array.isArray(value) || isBinary(value)) && unboxPrimitive(value) === value;

/** Sets an own data property, also `__proto__`, which assignment would drop */
export function setOwn(target: Record<string, unknown>, key: string, value: unknown): void {
  if (key === "__proto__") {
    Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
  } else {
    target[key] = value;
  }
}

function childPath(path: string, key: string): string {
  return path ? `${path}.${key}` : key;
}

// Distinct keys can redact to the same text (two email keys both become the
// marker). Each later one is kept under the first free "<key>#<n>" (n from 2)
// instead of overwriting the earlier value. `used` holds the next n per key;
// `reserved` names are never taken, wherever they come in key order.
function uniqueKey(target: Record<string, unknown>, key: string, used: Map<string, number>, reserved?: ReadonlySet<string>): string {
  const has = (candidate: string) => reserved?.has(candidate) === true || Object.prototype.hasOwnProperty.call(target, candidate);
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
  if (value === null || typeof value !== "object") {
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
      // A fresh plain array by index, as in sanitization.
      const items: unknown[] = [];
      for (let index = 0; index < value.length; index += 1) {
        items[index] = redactNode(value[index], redactor, `${path}[${index}]`, ancestors, depth + 1);
      }
      return items;
    }

    const result: Record<string, unknown> = {};
    const used = new Map<string, number>();
    for (const [key, item] of Object.entries(value)) {
      const itemPath = childPath(path, key);
      const allowed = redactor.allowlist.has(itemPath);
      // Keys are text too: a map keyed by URL or email must not leak them.
      const outputKey = uniqueKey(result, allowed ? key : redactText(key, redactor), used);
      setOwn(
        result,
        outputKey,
        redactor.isSensitive(key) && !allowed
          ? redactor.replacement
          : redactNode(item, redactor, itemPath, ancestors, depth + 1)
      );
    }
    return result;
  } finally {
    ancestors.delete(value);
  }
}

// Every top-level field is redacted, including fields outside the LogEvent
// schema that a caller-added stage may have set. Paths for fields other than
// ctx are their names (`userId`, `tags[0]`); ctx paths start at the ctx root.
// It redacts the JSON-safe copy (one bounded walk), where an error is a record whose fields obey the key rules.
function redactWith(event: LogEvent, redactor: CompiledRedactor): LogEvent {
  const redacted: Record<string, unknown> = {};
  const used = new Map<string, number>();
  for (const [key, value] of Object.entries(sanitizeEvent(event))) {
    if (key === "msg") {
      redacted.msg = redactor.allowlist.has(key) ? String(value) : redactText(String(value), redactor);
    } else if (key === "ctx") {
      redacted.ctx = redactNode(value, redactor, "", new Set(), 0);
    } else if (key === "tags" && Array.isArray(value)) {
      redacted.tags = redactNode(Array.from({ length: value.length }, (_, index) => tagText(value[index])), redactor, key, new Set(), 0);
    } else {
      // Field names are text too, exactly like nested keys; an allowlisted name is kept, and any collision keeps both values.
      // A schema field keeps its name, and no other field takes a schema name.
      const allowed = redactor.allowlist.has(key);
      setOwn(
        redacted,
        OWN_BUDGET.has(key) ? key : uniqueKey(redacted, allowed ? key : redactText(key, redactor), used, OWN_BUDGET),
        !allowed && redactor.isSensitive(key) ? redactor.replacement : redactNode(value, redactor, key, new Set(), 0)
      );
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

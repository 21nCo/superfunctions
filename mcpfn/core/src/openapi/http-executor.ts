import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
// Runtime imports go through the package name so the `@mcpfn/core/openapi`
// bundle shares the root entry's classes (see from-openapi.ts).
import { McpFnValidationError, structuredResult } from "@mcpfn/core";
import { isForbiddenHeader } from "./headers.js";
import type { OpenApiExecuteRequest, OpenApiExecutor, OpenApiOperation, OpenApiOperationParameter } from "./types.js";

/** Headers the operator adds to every request. */
export type HttpExecutorHeaders = Readonly<Record<string, string>>;

/** A record of headers, or a function of the server's trusted context (and the operation) returning one. */
export type HttpExecutorHeaderSource<TContext> =
  | HttpExecutorHeaders
  | ((context: TContext, operation: OpenApiOperation) => HttpExecutorHeaders | Promise<HttpExecutorHeaders>);

export interface HttpExecutorOptions<TContext = unknown> {
  /**
   * Absolute `http:` or `https:` URL every request goes to; the operation's
   * path is appended to its path. It may not carry credentials, a query or a
   * fragment. Tool arguments never change it, and the document's `servers`
   * are ignored.
   */
  baseUrl: string | URL;
  /**
   * Operator headers, such as upstream credentials. Every value is treated
   * as a secret: it never appears in results or errors, it is redacted from
   * error excerpts, and a success body that echoes it is withheld.
   */
  headers?: HttpExecutorHeaderSource<TContext>;
  /** Cancels a call whose response (headers and body) takes longer. Default 30,000 ms. */
  timeoutMs?: number;
  /** A larger response body is cancelled and reported as an error. Default 1 MiB. */
  maxResponseBytes?: number;
  /** The fetch implementation; defaults to the global `fetch`. */
  fetch?: typeof globalThis.fetch;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_TIMEOUT_MS = 2_147_483_647;
const EXCERPT_BYTES = 4096;
const REDACTED = "[REDACTED]";

// Hop-by-hop and framing headers belong to fetch: neither the operator nor a parameter sets them.
const TRANSPORT_HEADERS = new Set([
  "connection",
  "content-length",
  "expect",
  "host",
  "keep-alive",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
// Operator values are ASCII, so an echo decodes to the same characters.
const OPERATOR_VALUE = /^[\t\x20-\x7e]*$/;
const PARAMETER_VALUE = /^[\t\x20-\x7e\x80-\xff]*$/;
// `<scheme> <credential>`, such as `Bearer <token>`: the credential alone is a secret too.
const SCHEME_CREDENTIAL = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+ +(\S.*)$/;
// Reserved characters `allowReserved` sends as they are. `&`, `=`, `+` and `#`
// stay encoded: sent raw they would add parameters or end the query.
const RESERVED_ESCAPES = /%(3A|2F|3F|40|24|2C|3B|5B|5D)/gi;
const DOT_SEGMENT = /^(?:\.|%2e){1,2}$/i;
const BODYLESS_STATUSES = new Set([204, 205]);
const JSON_ESCAPE = /\\(?:u([0-9a-fA-F]{4})|(["\\/bfnrt]))/g;
const JSON_SIMPLE_ESCAPES: Record<string, string> = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };
const PERCENT_RUN = /(?:%[0-9a-fA-F]{2})+/g;
const HTML_REFERENCE = /&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|(amp|lt|gt|quot|apos));/g;
const HTML_NAMED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const NUMBER_LITERAL = /-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/g;

const encoder = new TextEncoder();

/** A call the executor refuses before sending anything; the message never holds operator values. */
class CallRejected extends Error {}

/** An operator header problem; the message names at most a header, never a value. */
class HeaderError extends Error {}

/** The response body stream failed for a reason other than the executor's own abort. */
class BodyReadError extends Error {}

interface OperatorHeaders {
  headers: Map<string, string>;
  /** Every literal form in which an upstream may echo a credential, longest first. */
  secrets: string[];
}

/**
 * An executor for `fromOpenAPI` that sends each validated tool call as one
 * HTTP request to `baseUrl` with the operator's headers, and turns the
 * response into a tool result. Redirects are never followed.
 */
export function httpExecutor<TContext = unknown>(options: HttpExecutorOptions<TContext>): OpenApiExecutor<TContext> {
  if (!options || typeof options !== "object") throw new McpFnValidationError("httpExecutor requires an options object");
  const base = parseBaseUrl(options.baseUrl);
  const timeoutMs = boundedNumber(options.timeoutMs, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS, "timeoutMs");
  const maxResponseBytes = boundedNumber(
    options.maxResponseBytes,
    DEFAULT_MAX_RESPONSE_BYTES,
    Number.MAX_SAFE_INTEGER,
    "maxResponseBytes",
  );
  const fetchImpl = options.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") throw new McpFnValidationError("httpExecutor requires a fetch implementation");
  let source: HttpExecutorHeaderSource<TContext> | undefined;
  try {
    source = options.headers;
    if (source !== undefined && typeof source !== "function") operatorHeaders(source);
  } catch (error) {
    throw new McpFnValidationError(headerFailure(error));
  }

  return {
    unsupported: unsupportedReason,
    outputSchemaRule: "every-success",

    async execute(request: OpenApiExecuteRequest<TContext>): Promise<CallToolResult> {
      const { operation, args } = request;
      const signal = request.signal ?? new AbortController().signal;
      if (signal.aborted) return cancelled();
      let operator: OperatorHeaders;
      try {
        // Settles as soon as the call is cancelled, even while a headers function is still running.
        operator = await untilAborted(resolveHeaders(source, request.context, operation), signal);
      } catch (error) {
        if (signal.aborted) return cancelled();
        throw error;
      }

      let url: string;
      let headers: Headers;
      let body: string | undefined;
      try {
        const refusal = unsupportedReason(operation);
        if (refusal !== undefined) throw new CallRejected(`${refusal[0]!.toUpperCase()}${refusal.slice(1)}.`);
        url = requestUrl(base, operation, args);
        headers = requestHeaders(operation, args.header, operator.headers);
        if (operation.requestBody && args.body !== undefined) {
          body = JSON.stringify(args.body);
          headers.set("content-type", operation.requestBody.contentType);
        }
      } catch (error) {
        if (error instanceof CallRejected) return toolError(error.message);
        throw error;
      }
      if (signal.aborted) return cancelled();

      const controller = new AbortController();
      let stopped: "timeout" | "cancelled" | undefined;
      const onAbort = () => {
        stopped ??= "cancelled";
        controller.abort();
      };
      signal.addEventListener("abort", onAbort, { once: true });
      const timer = setTimeout(() => {
        stopped ??= "timeout";
        controller.abort();
      }, timeoutMs);
      let response: Response | undefined;
      try {
        // Raced against the abort as well, so a fetch that ignores its signal
        // cannot outlast it; a response that arrives later has its body cancelled.
        response = await untilAborted(
          fetchImpl(url, {
            method: operation.method,
            headers,
            ...(body === undefined ? {} : { body }),
            redirect: "manual",
            signal: controller.signal,
          }),
          controller.signal,
          discard,
        );
        return await toResult(response, {
          hasOutputSchema: request.hasOutputSchema === true,
          ...(typeof request.checkOutput === "function" ? { checkOutput: request.checkOutput } : {}),
          head: operation.method === "HEAD",
          maxResponseBytes,
          secrets: operator.secrets,
          signal: controller.signal,
        });
      } catch (error) {
        if (stopped === "timeout") {
          // An error status already received is kept, though its body never finished.
          return response && !isSuccess(response.status) && !isRedirect(response)
            ? toolError(`The API responded with HTTP ${response.status}; its body did not arrive within ${timeoutMs} ms.`)
            : toolError(`The API did not respond within ${timeoutMs} ms.`);
        }
        if (stopped === "cancelled") return cancelled();
        // Fetch errors can name the URL but never hold header values; report none of them.
        if (response === undefined) return toolError("The request to the API failed.");
        if (error instanceof BodyReadError) {
          return isSuccess(response.status)
            ? toolError(`The API responded with HTTP ${response.status}, but its body could not be read.`)
            : toolError(`The API responded with HTTP ${response.status}; its body could not be read.`);
        }
        throw error;
      } finally {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        // Releases a body no branch consumed, such as a redirect's.
        controller.abort();
      }
    },
  };
}

/** Why fetch cannot send an operation: it refuses TRACE, and a body on GET or HEAD. */
function unsupportedReason(operation: OpenApiOperation): string | undefined {
  if (operation.method === "TRACE") return "fetch cannot send TRACE requests";
  if ((operation.method === "GET" || operation.method === "HEAD") && operation.requestBody) {
    return `fetch cannot send a ${operation.method} request with a body`;
  }
  const managed = operation.parameters.find(
    (parameter) => parameter.in === "header" && parameter.required && TRANSPORT_HEADERS.has(parameter.name.toLowerCase()),
  );
  if (managed) return `fetch manages the required header ${JSON.stringify(managed.name)}`;
  return undefined;
}

function cancelled(): CallToolResult {
  return toolError("The call was cancelled.");
}

function isSuccess(status: number): boolean {
  return status >= 200 && status <= 299;
}

function isRedirect(response: Response): boolean {
  return response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400);
}

/**
 * Settles like `promise`, or rejects as soon as `signal` aborts. A rejection
 * of `promise` after the abort is consumed, not left unhandled, and a value
 * it fulfills with after the abort goes to `late`.
 */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal, late?: (value: T) => void): Promise<T> {
  let settled = false;
  promise.then(
    (value) => {
      if (settled && late) late(value);
    },
    () => undefined,
  );
  if (signal.aborted) {
    settled = true;
    return Promise.reject(signal.reason);
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      settled = true;
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        if (!settled) {
          settled = true;
          resolve(value);
        }
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        if (!settled) {
          settled = true;
          reject(error);
        }
      },
    );
  });
}

/**
 * The operator's headers for one call. A failure here is the server's, not
 * the caller's: it is a plain error (withheld from the client) whose message
 * names at most a header, never a value or the function's own error, also
 * when reading the returned record (or its `then`) throws.
 */
async function resolveHeaders<TContext>(
  source: HttpExecutorHeaderSource<TContext> | undefined,
  context: TContext,
  operation: OpenApiOperation,
): Promise<OperatorHeaders> {
  // Boxed, so resolving the promise never reads a property of the record itself.
  let box: { record: unknown };
  try {
    if (typeof source === "function") {
      // Only a promise is awaited: a record returned as it is is never treated as a thenable.
      const result: unknown = source(context, operation);
      box = { record: result instanceof Promise ? await result : result };
    } else {
      box = { record: source };
    }
  } catch {
    throw new Error("httpExecutor headers function failed");
  }
  try {
    return operatorHeaders(box.record ?? {});
  } catch (error) {
    throw new Error(headerFailure(error));
  }
}

/** The message for a header failure: ours names at most a header; anything else, which may hold a value, is replaced. */
function headerFailure(error: unknown): string {
  try {
    if (error instanceof HeaderError) return error.message;
  } catch {
    // `instanceof` on a revoked or hostile proxy can throw too.
  }
  return "httpExecutor headers could not be read";
}

function operatorHeaders(record: unknown): OperatorHeaders {
  const headers = validateHeaders(record);
  return { headers, secrets: secretForms(headers) };
}

/** Validates operator headers by name only, so no error message carries a value. Values are trimmed as fetch sends them. */
function validateHeaders(record: unknown): Map<string, string> {
  const option = "headers";
  if (record === null || typeof record !== "object" || Array.isArray(record)) {
    throw new HeaderError(`httpExecutor ${option} must be an object of header names to string values`);
  }
  const headers = new Map<string, string>();
  for (const [name, value] of Object.entries(record)) {
    const lower = name.toLowerCase();
    const label = `httpExecutor ${option} entry ${JSON.stringify(name)}`;
    if (!HEADER_NAME.test(name)) throw new HeaderError(`${label} is not a valid header name`);
    if (TRANSPORT_HEADERS.has(lower)) throw new HeaderError(`${label} is managed by fetch`);
    if (typeof value !== "string" || !OPERATOR_VALUE.test(value)) {
      throw new HeaderError(`${label} must be a string of printable ASCII characters`);
    }
    if (headers.has(lower)) throw new HeaderError(`${label} is given twice`);
    headers.set(lower, value.replace(/^[\t ]+|[\t ]+$/g, ""));
  }
  return headers;
}

/**
 * The literal forms of every credential, longest first: each value as sent,
 * the credential after a scheme, each cookie value, and their JSON- and
 * URL-escaped spellings. Other spellings are caught by `exposes`.
 */
function secretForms(credentials: Map<string, string>): string[] {
  const forms = new Set<string>();
  const add = (value: string) => {
    if (value === "") return;
    forms.add(value);
    forms.add(JSON.stringify(value).slice(1, -1));
    forms.add(encodeURIComponent(value));
    // An upstream may decode a value before echoing it, as cookie parsers do (also with `+` for a space).
    for (const decoded of [percentDecoded(value), percentDecoded(value.replace(/\+/g, " "))]) {
      if (decoded !== value && decoded !== "") forms.add(decoded);
    }
  };
  for (const [name, value] of credentials) {
    add(value);
    const scheme = SCHEME_CREDENTIAL.exec(value);
    if (scheme) add(scheme[1]!);
    if (name === "cookie") {
      for (const pair of value.split(";")) {
        const cookie = pair.slice(pair.indexOf("=") + 1).trim();
        add(cookie);
        // A quoted cookie value is parsed without its quotes.
        if (cookie.length >= 2 && cookie.startsWith('"') && cookie.endsWith('"')) add(cookie.slice(1, -1));
      }
    }
  }
  return [...forms].sort((a, b) => b.length - a.length);
}

/** `text` with JSON string escapes decoded, whether or not `text` is valid JSON. */
function jsonUnescaped(text: string): string {
  return text.replace(JSON_ESCAPE, (_match, hex: string | undefined, simple: string | undefined) =>
    hex ? String.fromCharCode(Number.parseInt(hex, 16)) : JSON_SIMPLE_ESCAPES[simple!]!,
  );
}

/** `text` with each run of percent escapes decoded as UTF-8 (invalid bytes become U+FFFD), whether or not the text is a valid URI. */
function percentDecoded(text: string): string {
  return text.replace(PERCENT_RUN, (run) => {
    const bytes = new Uint8Array(run.length / 3);
    for (let index = 0; index < bytes.length; index += 1) bytes[index] = Number.parseInt(run.slice(index * 3 + 1, index * 3 + 3), 16);
    return decode(bytes);
  });
}

/** `text` with HTML/XML character references decoded: the five XML entities and numeric references. */
function htmlUnescaped(text: string): string {
  return text.replace(HTML_REFERENCE, (match, decimal: string | undefined, hex: string | undefined, named: string | undefined) => {
    if (named) return HTML_NAMED[named]!;
    const code = Number.parseInt(decimal ?? hex!, decimal ? 10 : 16);
    return code <= 0x10ffff ? String.fromCodePoint(code) : match;
  });
}

function holdsSecret(text: string, secrets: readonly string[]): boolean {
  return secrets.some((secret) => text.includes(secret));
}

/** `text` as a reader may decode it: each decoding, and each pair of them in either order. */
function decodedViews(text: string): string[] {
  const decoders = [
    jsonUnescaped,
    percentDecoded,
    (value: string) => percentDecoded(value.replace(/\+/g, " ")),
    htmlUnescaped,
  ];
  const views: string[] = [];
  for (const first of decoders) {
    const once = first(text);
    views.push(once);
    for (const second of decoders) views.push(second(once));
  }
  return views;
}

/** A number in `text` whose canonical spelling, which JSON parsing produces, holds a credential its own spelling does not. */
function numberReveals(text: string, secrets: readonly string[]): boolean {
  for (const [literal] of text.matchAll(NUMBER_LITERAL)) {
    if (!holdsSecret(literal, secrets) && holdsSecret(String(Number(literal)), secrets)) return true;
  }
  return false;
}

/** Whether `text` reveals a credential to a reader who decodes it, literal echoes included. */
function exposes(text: string, secrets: readonly string[]): boolean {
  if (secrets.length === 0) return false;
  if (holdsSecret(text, secrets)) return true;
  return [text, ...decodedViews(text)].some((view) => holdsSecret(view, secrets) || numberReveals(view, secrets));
}

function occurrences(text: string, secret: string): number {
  let count = 0;
  for (let at = text.indexOf(secret); at !== -1; at = text.indexOf(secret, at + 1)) count += 1;
  return count;
}

/**
 * Whether `text` reveals a credential other than as a literal echo, judged
 * on the text as received: a decoding that changes how often any credential
 * occurs (so one spelled with escapes, or overlapping a literal one, is
 * found), or a number that spells one. Literal echoes alone never trigger it.
 */
function revealsEncoded(text: string, spans: ReadonlyArray<readonly [number, number]>, secrets: readonly string[]): boolean {
  if (secrets.length === 0) return false;
  const literal = secrets.map((secret) => occurrences(text, secret));
  const changesCount = [text, ...decodedViews(text)].some(
    (view) =>
      numberReveals(view, secrets) ||
      (view !== text && secrets.some((secret, index) => occurrences(view, secret) !== literal[index])),
  );
  // Also with every literal echo masked by a character no decoding produces or
  // consumes, so an encoded echo elsewhere cannot hide behind an equal count.
  return changesCount || exposes(maskSpans(text, spans), secrets);
}

/** `text` with each span replaced by NUL characters of the same length. */
function maskSpans(text: string, spans: ReadonlyArray<readonly [number, number]>): string {
  let result = "";
  let at = 0;
  for (const [start, stop] of spans) {
    result += text.slice(at, start) + "\u0000".repeat(stop - start);
    at = stop;
  }
  return result + text.slice(at);
}

interface ResultOptions {
  hasOutputSchema: boolean;
  checkOutput?: (value: Record<string, unknown>) => boolean;
  head: boolean;
  maxResponseBytes: number;
  secrets: readonly string[];
  signal: AbortSignal;
}

async function toResult(response: Response, options: ResultOptions): Promise<CallToolResult> {
  const { status } = response;
  if (isRedirect(response)) {
    discard(response);
    const shown = status === 0 ? "a redirect" : `HTTP ${status}`;
    return toolError(`The API responded with ${shown}; redirects are not followed.`);
  }
  if (!isSuccess(status)) return errorResult(response, options);

  // A HEAD response, 204 and 205 carry no body, whatever Content-Length says.
  if (options.head || BODYLESS_STATUSES.has(status)) {
    discard(response);
    return unstructured(status, options, "no body");
  }
  if (declaredLength(response) > options.maxResponseBytes) {
    discard(response);
    return tooLarge(status, options.maxResponseBytes);
  }
  const { bytes, complete } = await readBody(response, options.maxResponseBytes, options.signal);
  if (!complete) return tooLarge(status, options.maxResponseBytes);
  if (bytes.byteLength === 0) return unstructured(status, options, "no body");
  const text = decode(bytes);
  // Rewriting a success body could change its data: one that reveals a credential is withheld whole.
  if (exposes(text, options.secrets)) {
    return toolError(`The API responded with HTTP ${status}, so the call succeeded, but its body reveals an operator credential and was withheld.`);
  }
  if (!options.hasOutputSchema) return { content: [{ type: "text", text }] };
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return unstructured(status, options, "a body that is not JSON", text);
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return unstructured(status, options, "a body that is not a JSON object", text);
  }
  // The value is checked and returned as it serializes: a number JSON cannot
  // hold (such as 1e400) or a nesting too deep to serialize is not changed or lost.
  let result: CallToolResult;
  try {
    if (!numbersExact(text)) throw new RangeError("a number JSON parsing would change");
    result = structuredResult(value as Record<string, unknown>);
  } catch {
    return unstructured(status, options, "a body that cannot be returned as structured content", text);
  }
  if (options.checkOutput && !options.checkOutput(result.structuredContent as Record<string, unknown>)) {
    return unstructured(status, options, "a body the output schema does not describe", text);
  }
  return result;
}

/**
 * A success the tool cannot return as structured content. With an output
 * schema it must be an `isError` result, so it says the call succeeded (a
 * completed mutation must not read as a failure) and carries the body text.
 */
function unstructured(status: number, options: ResultOptions, what: string, text?: string): CallToolResult {
  if (!options.hasOutputSchema) return { content: [{ type: "text", text: `The API responded with HTTP ${status} and ${what}.` }] };
  const summary = `The API responded with HTTP ${status} and ${what}, so the call succeeded, but the tool has no structured result to return. Do not repeat the call.`;
  return {
    isError: true,
    content: [{ type: "text", text: summary }, ...(text === undefined ? [] : [{ type: "text" as const, text }])],
  };
}

/**
 * Whether every number in a JSON text parses to exactly the value written:
 * an integer beyond 2^53 or a number that overflows or underflows would be
 * changed, and so would the data the tool returns. Strings are skipped.
 */
function numbersExact(json: string): boolean {
  for (let index = 0; index < json.length; index += 1) {
    const char = json[index]!;
    if (char === '"') {
      // Skip the string, escapes included.
      for (index += 1; index < json.length && json[index] !== '"'; index += 1) if (json[index] === "\\") index += 1;
      continue;
    }
    if (char !== "-" && (char < "0" || char > "9")) continue;
    const match = /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(json.slice(index, index + 1100))!;
    const token = match[0];
    index += token.length - 1;
    const value = Number(token);
    if (!Number.isFinite(value)) return false;
    if (/^-?\d+$/.test(token)) {
      if (BigInt(token) !== BigInt(value)) return false;
    } else if (value === 0 && /[1-9]/.test(token.replace(/[eE].*$/, ""))) {
      return false;
    }
  }
  return true;
}

function declaredLength(response: Response): number {
  const header = response.headers.get("content-length");
  const length = header === null ? Number.NaN : Number(header);
  return Number.isFinite(length) ? length : -1;
}

/**
 * Status and an excerpt of at most 4 KiB. The whole body (within
 * `maxResponseBytes`) is read and checked, so no credential is judged from
 * part of its spelling. Every literal credential echo (overlapping ones
 * merged) is replaced whole and never cut; a body that would reveal a
 * credential any other way is withheld.
 */
async function errorResult(response: Response, options: ResultOptions): Promise<CallToolResult> {
  const { status } = response;
  const heading = `The API responded with HTTP ${status}.`;
  // A HEAD response has no body, whatever Content-Length says of the GET one.
  if (options.head) {
    discard(response);
    return toolError(heading);
  }
  const oversized = toolError(`The API responded with HTTP ${status}; its body exceeds ${options.maxResponseBytes} bytes and was cancelled.`);
  if (declaredLength(response) > options.maxResponseBytes) {
    discard(response);
    return oversized;
  }
  const { bytes, complete } = await readBody(response, options.maxResponseBytes, options.signal);
  if (!complete) return oversized;
  const text = decode(bytes);
  const spans = credentialSpans(text, options.secrets);
  if (revealsEncoded(text, spans, options.secrets)) {
    return toolError(`${heading}\n[body withheld: it reveals an operator credential]`);
  }
  const { excerpt, end } = boundedExcerpt(text, spans, text.length, EXCERPT_BYTES);
  return toolError(
    heading +
      (excerpt.length > 0 ? `\n\n${excerpt}` : "") +
      (end < text.length ? `\n[body truncated after ${encoder.encode(text.slice(0, end)).byteLength} bytes]` : ""),
  );
}

/** Where literal credential forms occur in `text`, overlaps included, merged into sorted disjoint spans. */
function credentialSpans(text: string, secrets: readonly string[]): Array<[number, number]> {
  const found: Array<[number, number]> = [];
  for (const secret of secrets) {
    for (let at = text.indexOf(secret); at !== -1; at = text.indexOf(secret, at + 1)) found.push([at, at + secret.length]);
  }
  found.sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const span of found) {
    const last = merged.at(-1);
    if (last && span[0] < last[1]) last[1] = Math.max(last[1], span[1]);
    else merged.push([...span]);
  }
  return merged;
}

/**
 * The redacted excerpt of `text[0, usable)` that fits in `limit` UTF-8 bytes,
 * and where in `text` it stops. It stops before a span it cannot show whole
 * (one that crosses `usable`, or a marker that would not fit) and never
 * splits a character.
 */
function boundedExcerpt(
  text: string,
  spans: ReadonlyArray<readonly [number, number]>,
  usable: number,
  limit: number,
): { excerpt: string; end: number } {
  let excerpt = "";
  let size = 0;
  let at = 0;
  const markerSize = encoder.encode(REDACTED).byteLength;
  for (const [start, stop] of [...spans.filter(([start]) => start < usable), [usable, usable] as const]) {
    const plain = text.slice(at, start);
    const fits = indexAtBytes(plain, limit - size);
    excerpt += plain.slice(0, fits);
    size += encoder.encode(plain.slice(0, fits)).byteLength;
    if (fits < plain.length) return { excerpt, end: at + fits };
    if (start >= usable || stop > usable || size + markerSize > limit) return { excerpt, end: start };
    excerpt += REDACTED;
    size += markerSize;
    at = stop;
  }
  return { excerpt, end: at };
}

/** The index in `text` of the first character that would take its UTF-8 size past `limit`. */
function indexAtBytes(text: string, limit: number): number {
  let bytes = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.codePointAt(index)!;
    const size = code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
    if (bytes + size > limit) return index;
    bytes += size;
    if (code >= 0x10000) index += 1;
  }
  return text.length;
}

function tooLarge(status: number, limit: number): CallToolResult {
  return toolError(`The API responded with HTTP ${status}, but its body exceeds ${limit} bytes and was cancelled.`);
}

function toolError(text: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text }] };
}

/** Reads at most `limit` bytes; a longer body is cancelled and reported incomplete. */
async function readBody(
  response: Response,
  limit: number,
  signal: AbortSignal,
): Promise<{ bytes: Uint8Array; complete: boolean }> {
  if (!response.body) return { bytes: new Uint8Array(0), complete: true };
  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try {
    reader = response.body.getReader();
  } catch {
    // Such as a body another reader has locked.
    throw new BodyReadError("response body unavailable");
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  let complete = true;
  for (;;) {
    let next: ReadableStreamReadResult<Uint8Array>;
    try {
      next = await untilAborted(reader.read(), signal);
    } catch (error) {
      // Not awaited: a stream that ignored the abort may never settle its cancel either.
      reader.cancel().catch(() => undefined);
      if (signal.aborted) throw error;
      throw new BodyReadError("response body read failed");
    }
    const { done, value } = next;
    if (done) break;
    if (size + value.byteLength > limit) {
      chunks.push(value.subarray(0, limit - size));
      size = limit;
      complete = false;
      reader.cancel().catch(() => undefined);
      break;
    }
    chunks.push(value);
    size += value.byteLength;
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes, complete };
}

function discard(response: Response): void {
  response.body?.cancel().catch(() => undefined);
}

function decode(bytes: Uint8Array): string {
  return new TextDecoder("utf-8").decode(bytes);
}

interface BaseUrl {
  origin: string;
  /** The base path without a trailing slash. */
  path: string;
}

function parseBaseUrl(value: unknown): BaseUrl {
  let url: URL;
  try {
    url = new URL(value instanceof URL ? value.href : String(value));
  } catch {
    throw new McpFnValidationError("httpExecutor baseUrl must be an absolute http: or https: URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new McpFnValidationError("httpExecutor baseUrl must be an absolute http: or https: URL");
  }
  if (url.username !== "" || url.password !== "") {
    throw new McpFnValidationError("httpExecutor baseUrl must not hold credentials; pass them in headers");
  }
  if (url.search !== "" || url.hash !== "" || /[?#]/.test(url.href)) {
    throw new McpFnValidationError("httpExecutor baseUrl must not have a query or fragment");
  }
  return { origin: url.origin, path: url.pathname.replace(/\/+$/, "") };
}

function boundedNumber(value: unknown, fallback: number, max: number, name: string): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > max) {
    throw new McpFnValidationError(`httpExecutor ${name} must be a positive integer no greater than ${max}`);
  }
  return value;
}

/**
 * The request URL. The path is checked once more as fetch will parse it: a
 * template that a URL parser would rewrite (a backslash, a dot segment, a
 * character it encodes) is refused rather than sent somewhere else.
 */
function requestUrl(base: BaseUrl, operation: OpenApiOperation, args: Record<string, unknown>): string {
  const path = base.path + renderPath(operation, args.path);
  const url = base.origin + path + renderQuery(operation, args.query);
  const parsed = new URL(url);
  if (parsed.origin !== base.origin || parsed.pathname !== path) {
    throw new CallRejected("The operation path cannot be sent as written.");
  }
  return url;
}

function parametersIn(operation: OpenApiOperation, location: OpenApiOperationParameter["in"]) {
  return operation.parameters.filter((parameter) => parameter.in === location);
}

/** The argument group's own value for a parameter; the schema allows nothing inherited. */
function argument(group: unknown, name: string): unknown {
  if (group === null || typeof group !== "object" || !Object.hasOwn(group, name)) return undefined;
  return (group as Record<string, unknown>)[name];
}

/** Primitive values as text; `null`, which a nullable schema allows, is empty. */
function primitives(parameter: OpenApiOperationParameter, value: unknown): string[] {
  const items = Array.isArray(value) ? value : [value];
  return items.map((item) => {
    if (item === null) return "";
    if (typeof item === "string" || typeof item === "number" || typeof item === "boolean") return String(item);
    throw new CallRejected(`The ${parameter.in} parameter ${JSON.stringify(parameter.name)} must be a primitive or an array of primitives.`);
  });
}

function encode(parameter: OpenApiOperationParameter, text: string): string {
  try {
    return encodeURIComponent(text);
  } catch {
    throw new CallRejected(`The ${parameter.in} parameter ${JSON.stringify(parameter.name)} is not valid Unicode.`);
  }
}

/**
 * The path template with each `{name}` replaced by its percent-encoded value
 * (`simple` style: array items joined by commas, `null` empty). A segment
 * holding a value may not render empty, `.` or `..`, which would leave the
 * templated path.
 */
function renderPath(operation: OpenApiOperation, group: unknown): string {
  const declared = new Map(parametersIn(operation, "path").map((parameter) => [parameter.name, parameter]));
  const template = operation.path.startsWith("/") ? operation.path : `/${operation.path}`;
  return template
    .split("/")
    .map((segment) => {
      if (!segment.includes("{")) return segment;
      const rendered = segment.replace(/\{([^{}]*)\}/g, (_match, name: string) => {
        const parameter = declared.get(name);
        const value = parameter ? argument(group, name) : undefined;
        if (!parameter || value === undefined) {
          throw new CallRejected(`The path parameter ${JSON.stringify(name)} has no value.`);
        }
        return primitives(parameter, value)
          .map((text) => encode(parameter, text))
          .join(",");
      });
      if (rendered === "" || DOT_SEGMENT.test(rendered)) {
        throw new CallRejected(`The path segment ${JSON.stringify(segment)} cannot be empty, "." or "..".`);
      }
      return rendered;
    })
    .join("/");
}

/** `form` style query: arrays repeat the key (`explode: true`); `null` leaves the parameter out. */
function renderQuery(operation: OpenApiOperation, group: unknown): string {
  const pairs: string[] = [];
  for (const parameter of parametersIn(operation, "query")) {
    const value = argument(group, parameter.name);
    if (value === undefined || value === null) continue;
    const encodeValue = (text: string) => {
      const encoded = encode(parameter, text);
      return parameter.allowReserved ? encoded.replace(RESERVED_ESCAPES, (escape) => decodeURIComponent(escape)) : encoded;
    };
    const key = encode(parameter, parameter.name);
    const texts = primitives(parameter, value);
    if (Array.isArray(value) && !parameter.explode) {
      pairs.push(`${key}=${texts.map(encodeValue).join(",")}`);
    } else {
      for (const text of texts) pairs.push(`${key}=${encodeValue(text)}`);
    }
  }
  return pairs.length === 0 ? "" : `?${pairs.join("&")}`;
}

/**
 * Operator headers, then each declared header parameter that is not forbidden
 * (D9), not a transport header and not one the operator set. Undeclared names
 * in the arguments are never read; `null` leaves the header out.
 */
function requestHeaders(operation: OpenApiOperation, group: unknown, operator: Map<string, string>): Headers {
  const headers = new Headers();
  for (const [name, value] of operator) headers.set(name, value);
  for (const parameter of parametersIn(operation, "header")) {
    const lower = parameter.name.toLowerCase();
    if (isForbiddenHeader(lower) || TRANSPORT_HEADERS.has(lower) || operator.has(lower) || !HEADER_NAME.test(parameter.name)) {
      continue;
    }
    const value = argument(group, parameter.name);
    if (value === undefined || value === null) continue;
    const text = primitives(parameter, value).join(",");
    if (!PARAMETER_VALUE.test(text)) {
      throw new CallRejected(`The header parameter ${JSON.stringify(parameter.name)} has a value no HTTP header can carry.`);
    }
    headers.set(parameter.name, text);
  }
  return headers;
}

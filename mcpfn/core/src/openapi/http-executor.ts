import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
// Runtime imports go through the package name so the `@mcpfn/core/openapi`
// bundle shares the root entry's classes (see from-openapi.ts).
import { McpFnValidationError, structuredResult } from "@mcpfn/core";
import { isForbiddenHeader } from "./headers.js";
import type {
  OpenApiExecuteRequest,
  OpenApiExecutor,
  OpenApiOperation,
  OpenApiOperationParameter,
  OpenApiParameterQuery,
} from "./types.js";

/** Headers the operator adds to every request. */
export type HttpExecutorHeaders = Readonly<Record<string, string>>;

/** A plain object of headers, or a function of the server's trusted context (and the operation) returning one; a `Map`, `Headers` or another realm's object is refused. */
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
   * error excerpts, and a success body that echoes it is withheld. With a
   * record, a header parameter it sets is not a tool input; with a function,
   * whose names are known only per call, a call that gives such a parameter
   * a value is refused rather than having the value dropped.
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

// Hop-by-hop and framing headers belong to fetch, and so do the request headers
// undici rewrites: `Sec-Fetch-Mode`, which it replaces with its own value, and
// `Range`, beside which it appends `identity` to `Accept-Encoding`. Neither the
// operator nor a parameter sets them. (The headers undici only adds when absent,
// such as `Accept`, `User-Agent` and `Cache-Control`, are sent as given.)
const TRANSPORT_HEADERS = new Set([
  "connection",
  "content-length",
  "expect",
  "host",
  "keep-alive",
  "range",
  "sec-fetch-mode",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
// Operator values are ASCII, so an echo decodes to the same characters.
const OPERATOR_VALUE = /^[\t\x20-\x7e]*$/;
const PARAMETER_VALUE = /^[\t\x20-\x7e\x80-\xff]*$/;
// `<scheme> <credential>`, such as `Bearer <token>`: the credential alone is a
// secret too. Any run of SP or HTAB separates them (both are allowed in an
// operator value), and trailing SP or HTAB is not part of the credential.
const SCHEME_CREDENTIAL = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+[\t ]+([^\t ](?:.*[^\t ])?)[\t ]*$/;
// Reserved characters `allowReserved` sends as they are. `&`, `=`, `+` and `#`
// stay encoded: sent raw they would add parameters or end the query.
const RESERVED_ESCAPES = /%(3A|2F|3F|40|24|2C|3B|5B|5D)/gi;
const DOT_SEGMENT = /^(?:\.|%2e){1,2}$/i;
const BODYLESS_STATUSES = new Set([204, 205]);
const JSON_ESCAPE = /\\(?:u([0-9a-fA-F]{4})|(["\\/bfnrt]))/g;
const JSON_SIMPLE_ESCAPES: Record<string, string> = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };
const PERCENT_RUN = /(?:%[0-9a-fA-F]{2})+/g;
// A character reference as HTML decodes it: numeric (any number of digits) or
// named, the closing `;` optional. Operator values are ASCII, so only the named
// references whose value is printable ASCII, TAB or LF are decoded (all of the
// HTML5 table's), and the legacy ones HTML also decodes without `;`.
const HTML_REFERENCE = /&(?:#(?:(\d+)|[xX]([0-9a-fA-F]+));?|([A-Za-z][A-Za-z0-9]*)(;?))/g;
const HTML_NAMED = new Map<string, string>(
  Object.entries({
    Tab: "\t", NewLine: "\n", excl: "!", quot: '"', QUOT: '"', num: "#", dollar: "$", percnt: "%", amp: "&", AMP: "&",
    apos: "'", lpar: "(", rpar: ")", ast: "*", midast: "*", plus: "+", comma: ",", period: ".", sol: "/", colon: ":",
    semi: ";", lt: "<", LT: "<", equals: "=", gt: ">", GT: ">", quest: "?", commat: "@", lsqb: "[", lbrack: "[",
    bsol: "\\", rsqb: "]", rbrack: "]", Hat: "^", lowbar: "_", UnderBar: "_", grave: "`", DiacriticalGrave: "`",
    lcub: "{", lbrace: "{", verbar: "|", vert: "|", VerticalLine: "|", rcub: "}", rbrace: "}", fjlig: "fj",
  }),
);
const HTML_LEGACY = ["amp", "AMP", "lt", "LT", "gt", "GT", "quot", "QUOT"] as const;
const HTML_LEGACY_NAMES: ReadonlySet<string> = new Set(HTML_LEGACY);
const HTML_NAME = /&([A-Za-z][A-Za-z0-9]*)(;?)/g;
// The HTML5 named references HTML also decodes without `;` (a longer name
// that starts with one, such as `&notit`, decodes as the legacy one plus text).
const HTML_SEMICOLONLESS = [
  "AElig", "AMP", "Aacute", "Acirc", "Agrave", "Aring", "Atilde", "Auml", "COPY", "Ccedil", "ETH", "Eacute", "Ecirc",
  "Egrave", "Euml", "GT", "Iacute", "Icirc", "Igrave", "Iuml", "LT", "Ntilde", "Oacute", "Ocirc", "Ograve", "Oslash",
  "Otilde", "Ouml", "QUOT", "REG", "THORN", "Uacute", "Ucirc", "Ugrave", "Uuml", "Yacute", "aacute", "acirc", "acute",
  "aelig", "agrave", "amp", "aring", "atilde", "auml", "brvbar", "ccedil", "cedil", "cent", "copy", "curren", "deg",
  "divide", "eacute", "ecirc", "egrave", "eth", "euml", "frac12", "frac14", "frac34", "gt", "iacute", "icirc", "iexcl",
  "igrave", "iquest", "iuml", "laquo", "lt", "macr", "micro", "middot", "nbsp", "not", "ntilde", "oacute", "ocirc",
  "ograve", "ordf", "ordm", "oslash", "otilde", "ouml", "para", "plusmn", "pound", "quot", "raquo", "reg", "sect", "shy",
  "sup1", "sup2", "sup3", "szlig", "thorn", "times", "uacute", "ucirc", "ugrave", "uml", "uuml", "yacute", "yen", "yuml",
] as const;
const HTML_SEMICOLONLESS_NAMES: ReadonlySet<string> = new Set(HTML_SEMICOLONLESS);
// The longest semicolon-less name, so a prefix check looks at a bounded number of prefixes.
const HTML_SEMICOLONLESS_LONGEST = Math.max(...HTML_SEMICOLONLESS.map((name) => name.length));
// The WHATWG HTML numeric character reference replacements for 0x80-0x9F
// (windows-1252); 0x81, 0x8D, 0x8F, 0x90 and 0x9D are not replaced.
const HTML_C1 = new Map<number, number>([
  [0x80, 0x20ac], [0x82, 0x201a], [0x83, 0x0192], [0x84, 0x201e], [0x85, 0x2026], [0x86, 0x2020], [0x87, 0x2021],
  [0x88, 0x02c6], [0x89, 0x2030], [0x8a, 0x0160], [0x8b, 0x2039], [0x8c, 0x0152], [0x8e, 0x017d], [0x91, 0x2018],
  [0x92, 0x2019], [0x93, 0x201c], [0x94, 0x201d], [0x95, 0x2022], [0x96, 0x2013], [0x97, 0x2014], [0x98, 0x02dc],
  [0x99, 0x2122], [0x9a, 0x0161], [0x9b, 0x203a], [0x9c, 0x0153], [0x9e, 0x017e], [0x9f, 0x0178],
]);
const NON_ASCII = /[^\x00-\x7f]/;

const encoder = new TextEncoder();
const percentDecoder = new TextDecoder("utf-8", { ignoreBOM: true });
const utf8Decoder = new TextDecoder("utf-8", { ignoreBOM: true });

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
  // A record (or none) is validated once and its copy sent on every call, so
  // changing the operator's object later cannot change what is sent or which
  // parameters are tool inputs; per-call headers come from a function.
  let fixed: OperatorHeaders | undefined;
  // Header names a record sets, which are never tool inputs.
  let fixedNames = new Set<string>();
  try {
    source = options.headers;
    if (typeof source !== "function") {
      // Only an omitted option means no headers: `null` or any other value that is not a record is refused.
      fixed = operatorHeaders(source === undefined ? {} : source);
      fixedNames = new Set(fixed.headers.keys());
    }
  } catch (error) {
    throw new McpFnValidationError(headerFailure(error));
  }

  // A Content-Type the operator's record fixes: a documented media type it conflicts with is refused on every call, so it is not chosen,
  // and an operation whose required body it cannot label is never listed (every call would be refused before fetch).
  const fixedContentType = fixed?.headers.get("content-type");
  const fixedMediaRefusal = (operation: OpenApiOperation) =>
    fixedContentType !== undefined && operation.requestBody?.required && contentTypeConflicts(fixedContentType, operation.requestBody.contentType)
      ? "the server's Content-Type header cannot label the required request body this operation documents"
      : undefined;
  const refusal = (operation: OpenApiOperation) =>
    unsupportedReason(operation) ?? fixedMediaRefusal(operation) ?? pathRefusal(base, operation);

  return {
    unsupported: refusal,
    outputSchemaRule: "every-success",
    ownsParameter: (parameter: OpenApiParameterQuery) => ownsParameter(parameter, fixedNames),
    sendsRequestMedia: (contentType: string) =>
      requestMediaRefusal(contentType) === undefined &&
      (fixedContentType === undefined || !contentTypeConflicts(fixedContentType, contentType)),

    async execute(request: OpenApiExecuteRequest<TContext>): Promise<CallToolResult> {
      const { operation, args } = request;
      const signal = request.signal ?? new AbortController().signal;
      if (signal.aborted) return cancelled();
      let operator: OperatorHeaders;
      try {
        // Settles as soon as the call is cancelled, even while a headers function is still running.
        operator = fixed ?? (await untilAborted(resolveHeaders(source, request.context, operation), signal));
      } catch (error) {
        if (signal.aborted) return cancelled();
        throw error;
      }

      let url: string;
      let headers: Headers;
      let body: string | undefined;
      try {
        const refused = refusal(operation);
        if (refused !== undefined) throw new CallRejected(`${refused[0]!.toUpperCase()}${refused.slice(1)}.`);
        const credentials = credentialParameters(operation);
        url = requestUrl(base, operation, args, credentials.query);
        headers = requestHeaders(operation, args.header, operator.headers, credentials.header);
        if (operation.requestBody && args.body !== undefined) {
          body = JSON.stringify(args.body);
          bodyContentType(headers, operation.requestBody.contentType);
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
          // A status already received is kept, though its body never finished:
          // after a success the call may have taken effect, so it must not read as unanswered.
          if (response === undefined || isRedirect(response)) return toolError(`The API did not respond within ${timeoutMs} ms.`);
          return isSuccess(response.status)
            ? toolError(
                `The API responded with HTTP ${response.status}, so the call reached the API and may have taken effect, but its body did not arrive within ${timeoutMs} ms. Do not repeat the call without checking.`,
              )
            : toolError(`The API responded with HTTP ${response.status}; its body did not arrive within ${timeoutMs} ms.`);
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

/**
 * Whether a query or header parameter is the executor's own: a forbidden
 * header (D9), an optional header fetch manages or whose name is not an HTTP
 * token, so it cannot be sent (a required one makes the operation
 * unsupported instead), or a header the operator's record sets.
 */
function ownsParameter(parameter: OpenApiParameterQuery, fixedNames: ReadonlySet<string>): boolean {
  if (parameter.in !== "header") return false;
  const lower = parameter.name.toLowerCase();
  return (
    isForbiddenHeader(lower) ||
    fixedNames.has(lower) ||
    (!parameter.required && (TRANSPORT_HEADERS.has(lower) || !HEADER_NAME.test(parameter.name)))
  );
}

/** The query and header parameters an apiKey scheme of the operation sends its credential in (header names lower case). */
function credentialParameters(operation: OpenApiOperation): { query: Set<string>; header: Set<string> } {
  const query = new Set<string>();
  const header = new Set<string>();
  for (const scheme of Object.values(operation.securitySchemes ?? {})) {
    if (scheme.type !== "apiKey" || typeof scheme.name !== "string") continue;
    if (scheme.in === "query") query.add(scheme.name);
    else if (scheme.in === "header") header.add(scheme.name.toLowerCase());
  }
  return { query, header };
}

/**
 * Why the operation's security cannot be met with operator headers alone.
 * Malformed security (`securityUnresolved`) is refused, never read in part.
 * A requirement that names a scheme which does not resolve (missing, an
 * external `$ref`, a cycle) or an `apiKey` scheme with no usable placement
 * leaves its credential parameter unknown, so a caller could fill it: the
 * operation is refused whatever the alternatives. Otherwise it is refused
 * when every requirement needs an `apiKey` the operator cannot send: a
 * query one, or a header fetch manages. An alternative without one
 * (another scheme, or `{}` for none) is enough.
 */
function securityRefusal(operation: OpenApiOperation): string | undefined {
  if (operation.securityUnresolved !== undefined) return `its security cannot be read: ${operation.securityUnresolved}`;
  const requirements = operation.security;
  if (!requirements || requirements.length === 0) return undefined;
  const schemes = operation.securitySchemes ?? {};
  const schemeOf = (name: string) => (Object.hasOwn(schemes, name) ? schemes[name] : undefined);
  for (const requirement of requirements) {
    for (const name of Object.keys(requirement)) {
      const scheme = schemeOf(name);
      if (scheme === undefined) {
        return `the security scheme ${JSON.stringify(name)} does not resolve to a scheme of a known type, so the parameter that carries its credential is unknown`;
      }
      if (scheme.type === "apiKey" && (scheme.name === undefined || scheme.in === undefined)) {
        return `the apiKey security scheme ${JSON.stringify(name)} has no usable name and location`;
      }
    }
  }
  let needed: string | undefined;
  for (const requirement of requirements) {
    const unsuppliable = Object.keys(requirement)
      .map((name) => schemeOf(name)!)
      .find((scheme) => scheme.type === "apiKey" && (scheme.in === "query" || (scheme.in === "header" && TRANSPORT_HEADERS.has(scheme.name!.toLowerCase()))));
    if (unsuppliable === undefined) return undefined;
    needed ??= unsuppliable.in === "query"
      ? `the operation needs the query credential ${JSON.stringify(unsuppliable.name)}, which operator headers cannot supply`
      : `the operation needs the credential header ${JSON.stringify(unsuppliable.name)}, which fetch manages`;
  }
  return needed;
}

/**
 * Why fetch cannot send an operation: it refuses TRACE, and a body on GET or
 * HEAD. A body is sent as UTF-8 JSON, so a documented media type that names
 * another charset (or cannot be parsed) would mislabel it.
 */
function unsupportedReason(operation: OpenApiOperation): string | undefined {
  if (operation.method === "TRACE") return "fetch cannot send TRACE requests";
  if ((operation.method === "GET" || operation.method === "HEAD") && operation.requestBody) {
    return `fetch cannot send a ${operation.method} request with a body`;
  }
  if (operation.requestBody) {
    const refusal = requestMediaRefusal(operation.requestBody.contentType);
    if (refusal !== undefined) return refusal;
  }
  const managed = operation.parameters.find(
    (parameter) => parameter.in === "header" && parameter.required && TRANSPORT_HEADERS.has(parameter.name.toLowerCase()),
  );
  if (managed) return `fetch manages the required header ${JSON.stringify(managed.name)}`;
  const unsendable = operation.parameters.find(
    (parameter) =>
      parameter.in === "header" &&
      parameter.required &&
      !isForbiddenHeader(parameter.name.toLowerCase()) &&
      !HEADER_NAME.test(parameter.name),
  );
  if (unsendable) return `the required header ${JSON.stringify(unsendable.name)} is not a valid HTTP header name`;
  return securityRefusal(operation);
}

/** Why a request body cannot be sent under the documented media type `contentType`, or `undefined` when it can. */
function requestMediaRefusal(contentType: string): string | undefined {
  // Headers.set throws for CR, LF, NUL or a character above 0xFF, also inside a quoted parameter.
  if (/[\x00-\x08\x0a-\x1f\x7f]|[^\x00-\xff]/.test(contentType)) {
    return "the request body's documented media type has a character no HTTP header can carry";
  }
  const documented = parseMediaType(contentType);
  if (documented === null || (documented.charset !== undefined && !isUtf8(documented.charset))) {
    return "the request body's documented media type names a charset other than UTF-8, but the body is sent as UTF-8";
  }
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
      // Only a native promise (of any realm) is awaited: a record returned
      // as it is is never treated as a thenable.
      const result: unknown = source(context, operation);
      const settled = nativePromise(result);
      box = { record: settled === undefined ? result : await settled };
    } else {
      box = { record: source ?? {} };
    }
  } catch {
    throw new Error("httpExecutor headers function failed");
  }
  try {
    // A function that returns no record fails closed: nothing is sent without the operator's headers.
    return operatorHeaders(box.record);
  } catch (error) {
    throw new Error(headerFailure(error));
  }
}

/**
 * The settlement of a native promise from any realm, found by its internal
 * slot: `Promise.prototype.then` throws for anything else before reading a
 * property, so a record's own `then` is never called.
 */
function nativePromise(value: unknown): Promise<unknown> | undefined {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) return undefined;
  let resolve!: (value: unknown) => void;
  let reject!: (reason: unknown) => void;
  const settled = new Promise<unknown>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  try {
    // The derived promise `then` returns only settles with what `resolve` or `reject` return, so it never rejects
    // and is deliberately left unobserved; only a synchronous throw (no native promise) matters here.
    void Reflect.apply(Promise.prototype.then, value, [resolve, reject]);
  } catch {
    return undefined;
  }
  return settled;
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
  // Only a plain record: a Map, a Headers or another realm's object would read as empty and send no credentials.
  if (record === null || typeof record !== "object" || !isPlainRecord(record)) {
    throw new HeaderError(`httpExecutor ${option} must be a plain object of header names to string values`);
  }
  const headers = new Map<string, string>();
  // Every own key is sent or refused: a symbol or non-enumerable key would otherwise be skipped unseen.
  for (const key of Reflect.ownKeys(record)) {
    if (typeof key === "symbol") throw new HeaderError(`httpExecutor ${option} has a symbol key`);
    const name = key;
    if (!Object.getOwnPropertyDescriptor(record, name)?.enumerable) {
      throw new HeaderError(`httpExecutor ${option} entry ${JSON.stringify(name)} is not enumerable`);
    }
    const value: unknown = (record as Record<string, unknown>)[name];
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

function isPlainRecord(record: object): boolean {
  const prototype: unknown = Object.getPrototypeOf(record);
  return prototype === Object.prototype || prototype === null;
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

/** `text` with each run of percent escapes decoded as UTF-8 (invalid bytes become U+FFFD, a BOM is kept), whether or not the text is a valid URI. */
function percentDecoded(text: string): string {
  return text.replace(PERCENT_RUN, (run) => {
    const bytes = new Uint8Array(run.length / 3);
    for (let index = 0; index < bytes.length; index += 1) bytes[index] = Number.parseInt(run.slice(index * 3 + 1, index * 3 + 3), 16);
    // A byte order mark is kept, as decodeURIComponent and cookie parsers keep it.
    return percentDecoder.decode(bytes);
  });
}

/**
 * `text` with HTML character references decoded as an HTML reader decodes
 * them, for every character an operator value can hold: numeric references
 * with or without `;` (an invalid code point becomes U+FFFD) and the named
 * references `HTML_NAMED` lists, including the legacy ones without `;`
 * (`&ampx` reads as `&x`). It may decode more than HTML does (`&ltimes;` reads
 * as `<imes;`), which only withholds more. One pass, linear in the text.
 */
function htmlUnescaped(text: string): string {
  return text.replace(
    HTML_REFERENCE,
    (match, decimal: string | undefined, hex: string | undefined, name: string | undefined, semicolon: string | undefined) => {
      if (name === undefined) return codePointText(decimal ?? hex!, decimal === undefined ? 16 : 10);
      if (semicolon && HTML_NAMED.has(name)) return HTML_NAMED.get(name)!;
      const legacy = HTML_LEGACY.find((candidate) => name.startsWith(candidate));
      return legacy === undefined ? match : `${HTML_NAMED.get(legacy)!}${name.slice(legacy.length)}${semicolon}`;
    },
  );
}

/**
 * The character a numeric reference's digits name as HTML reads it: U+FFFD for
 * NUL, a surrogate or a value past U+10FFFF, and 0x80-0x9F through the
 * windows-1252 replacements in `HTML_C1`.
 */
function codePointText(digits: string, radix: number): string {
  let start = 0;
  while (start < digits.length - 1 && digits[start] === "0") start += 1;
  // More than seven significant digits exceed U+10FFFF in either radix, so such runs are not parsed.
  const code = digits.length - start > 7 ? Number.POSITIVE_INFINITY : Number.parseInt(digits.slice(start), radix);
  if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return "\ufffd";
  return String.fromCodePoint(HTML_C1.get(code) ?? code);
}

function holdsSecret(text: string, secrets: readonly string[]): boolean {
  return secrets.some((secret) => text.includes(secret));
}

/**
 * Whether `text` has a named character reference HTML could decode whose name
 * is not exactly one `htmlUnescaped` decodes (a longer name that starts with a
 * legacy one, such as `&ltimes;`, is not). HTML could decode a name that ends
 * in `;` or starts with a semicolon-less one; other text such as `&view=` in a
 * URL is left alone. Such a reference (`&eacute;`) can stand for a non-ASCII
 * character, which only a credential form decoded from percent escapes can
 * hold, so with one of those it counts as a possible echo.
 */
function opaqueReference(text: string): boolean {
  for (const [, name, semicolon] of text.matchAll(HTML_NAME)) {
    // Only an exact name counts as decoded: `&ltimes;` starts with a legacy name but stands for U+22C9.
    if (HTML_NAMED.has(name!) || HTML_LEGACY_NAMES.has(name!)) continue;
    if (semicolon || semicolonlessPrefix(name!)) return true;
  }
  return false;
}

/** Whether `name` starts with a named reference HTML decodes without `;`. */
function semicolonlessPrefix(name: string): boolean {
  const longest = Math.min(name.length, HTML_SEMICOLONLESS_LONGEST);
  for (let length = 2; length <= longest; length += 1) {
    if (HTML_SEMICOLONLESS_NAMES.has(name.slice(0, length))) return true;
  }
  return false;
}

/** Whether a credential form has a character outside ASCII, which a named reference `htmlUnescaped` does not decode may spell. */
function nonAsciiSecret(secrets: readonly string[]): boolean {
  return secrets.some((secret) => NON_ASCII.test(secret));
}

/** `text` as a reader may decode it: each decoding, and each pair of them in either order, made one at a time. */
function* decodedViews(text: string): Generator<string> {
  const decoders = [
    jsonUnescaped,
    percentDecoded,
    (value: string) => percentDecoded(value.replace(/\+/g, " ")),
    htmlUnescaped,
  ];
  for (const first of decoders) {
    const once = first(text);
    yield once;
    for (const second of decoders) yield second(once);
  }
}

/**
 * Whether `text` reveals a credential to a reader who decodes it, literal
 * echoes included, also with any NUL characters removed (a UTF-16 echo read
 * as single bytes). With a non-ASCII credential form, any named reference
 * left undecoded counts as an echo. Views are made one at a time, so memory
 * stays a small multiple of the text.
 */
function exposes(text: string, secrets: readonly string[]): boolean {
  if (secrets.length === 0) return false;
  // A named reference left undecoded may spell a non-ASCII credential character.
  const opaque = nonAsciiSecret(secrets);
  for (const view of textViews(text)) {
    if (holdsSecret(view, secrets) || (opaque && opaqueReference(view))) return true;
    for (const decoded of decodedViews(view)) {
      if (holdsSecret(decoded, secrets) || (opaque && opaqueReference(decoded))) return true;
    }
  }
  return false;
}

/** `text`, and `text` without NUL characters when it has any. */
function* textViews(text: string): Generator<string> {
  yield text;
  if (text.includes("\u0000")) yield text.replaceAll("\u0000", "");
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
  const body = decode(bytes, response);
  if (body === undefined) {
    return toolError(`The API responded with HTTP ${status}, so the call succeeded, but its body is in a character encoding that cannot be determined or decoded and was withheld.`);
  }
  const withheld = toolError(`The API responded with HTTP ${status}, so the call succeeded, but its body reveals an operator credential and was withheld.`);
  // Rewriting a success body could change its data, so one that reveals a credential in any way is withheld whole.
  if (bodyExposes(bytes, body.text, body.encoding, jsonStructure(body.text, options.secrets), options.secrets)) return withheld;
  // A leading byte order mark is dropped only after the check, as JSON parsing needs.
  const text = withoutBom(body.text);
  const parsed = parseJson(text);
  // A reader that parses a JSON body sees each number as it serializes (`1.2345e4` as `12345`).
  if (parsed.ok && serializedExposes(text, parsed.value, options.secrets)) return withheld;
  if (!options.hasOutputSchema) return { content: [{ type: "text", text }] };
  if (!parsed.ok) return unstructured(status, options, "a body that is not JSON", text);
  const value = parsed.value;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return unstructured(status, options, "a body that is not a JSON object", text);
  }
  // The value is checked and returned as it serializes: a number JSON cannot
  // hold (such as 1e400) or a nesting too deep to serialize is not changed or lost.
  let result: CallToolResult;
  try {
    if (!numbersExact(text)) throw new RangeError("a number JSON parsing would change");
    // Normalized with no text, which is then the compact serialization: a
    // pretty-printed one could be many times the body (deep nesting indents every line).
    const normalized = structuredResult(value as Record<string, unknown>, []).structuredContent;
    result = { content: [{ type: "text", text: JSON.stringify(normalized) }], structuredContent: normalized };
  } catch {
    return unstructured(status, options, "a body that cannot be returned as structured content", text);
  }
  // What is returned is checked as returned: the structured content as it
  // serializes (a number spelled `1.2345e4` in the body) and the text that carries it.
  if (
    exposes(JSON.stringify(result.structuredContent), options.secrets) ||
    result.content.some((block) => block.type === "text" && exposes(block.text, options.secrets))
  ) {
    return withheld;
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
 * Whether every number in a JSON text parses to the value written: one whose
 * shortest spelling (which serializing produces) denotes another decimal
 * value, however it was written (`9007199254740993.0`,
 * `0.123456789012345678901`, `1.0000000000000001`, an overflow or an
 * underflow), would be changed, and so would the data the tool returns.
 * Other spellings of the same value (`1e23`, `1.50`) pass. Strings are skipped.
 */
function numbersExact(json: string): boolean {
  return numberTokens(json).every((written) => {
    const value = Number(written);
    // An overflow, and a negative zero (it serializes as `0`), would change.
    if (!Number.isFinite(value) || Object.is(value, -0)) return false;
    const shortest = String(value);
    return written === shortest || decimalValue(written) === decimalValue(shortest);
  });
}

/** The number literals of a JSON text, as written; strings are skipped. */
function numberTokens(json: string): string[] {
  const token = /-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
  const tokens: string[] = [];
  for (let index = 0; index < json.length; index += 1) {
    const char = json[index]!;
    if (char === '"') {
      // Skip the string, escapes included.
      for (index += 1; index < json.length && json[index] !== '"'; index += 1) if (json[index] === "\\") index += 1;
      continue;
    }
    if (char !== "-" && (char < "0" || char > "9")) continue;
    token.lastIndex = index;
    const written = token.exec(json)?.[0];
    if (written === undefined) continue;
    index += written.length - 1;
    tokens.push(written);
  }
  return tokens;
}

/**
 * The exact decimal value of a number literal, as significant digits and a
 * power of ten. Read with index scans, so the work is linear in the literal's
 * length (an upstream controls it, and the check is synchronous).
 */
function decimalValue(literal: string): string {
  const negative = literal.startsWith("-");
  const exponentAt = literal.search(/[eE]/);
  const mantissa = literal.slice(negative ? 1 : 0, exponentAt === -1 ? literal.length : exponentAt);
  const point = mantissa.indexOf(".");
  const whole = point === -1 ? mantissa : mantissa.slice(0, point);
  const fraction = point === -1 ? "" : mantissa.slice(point + 1);
  const digits = whole + fraction;
  let first = 0;
  while (first < digits.length && digits[first] === "0") first += 1;
  let last = digits.length;
  while (last > first && digits[last - 1] === "0") last -= 1;
  if (first === last) return "0";
  const significant = digits.slice(first, last);
  let exponent = exponentAt === -1 ? "0" : literal.slice(exponentAt + 1);
  const exponentNegative = exponent.startsWith("-");
  if (exponentNegative || exponent.startsWith("+")) exponent = exponent.slice(1);
  let lead = 0;
  while (lead < exponent.length - 1 && exponent[lead] === "0") lead += 1;
  exponent = exponent.slice(lead);
  const sign = negative ? "-" : "";
  // Beyond 15 digits the exponent dwarfs any digit count under the body cap, so
  // the value is no double's: a form no shortest spelling has, without BigInt work.
  if (exponent.length > 15) return `${sign}${significant}e${exponentNegative ? "-" : "+"}${exponent}!`;
  const power = BigInt(exponentNegative ? `-${exponent}` : exponent) - BigInt(fraction.length) + BigInt(digits.length - last);
  return `${sign}${significant}e${power}`;
}

function declaredLength(response: Response): number {
  const header = response.headers.get("content-length");
  const length = header === null ? Number.NaN : Number(header);
  return Number.isFinite(length) ? length : -1;
}

/**
 * Status and an excerpt of at most 4 KiB. The whole body (within
 * `maxResponseBytes`) is read and checked, so no credential is judged from
 * part of its spelling. A body that reveals a credential is redacted only when
 * it is plain (`isPlain`): its literal text is then the only reading of it, so
 * replacing every literal echo (overlapping ones merged, never cut) leaves
 * none. Any other body that reveals a credential is withheld whole.
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
  const body = decode(bytes, response);
  if (body === undefined) return toolError(`${heading}\n[body withheld: its character encoding cannot be determined or decoded]`);
  const withheld = toolError(`${heading}\n[body withheld: it reveals an operator credential]`);
  const { secrets } = options;
  const { text, encoding } = body;
  const json = jsonStructure(text, secrets);
  let mask: Uint8Array | undefined;
  let masked: string | undefined;
  // The readings a success body is checked in, its JSON serialization included.
  if (bodyExposes(bytes, text, encoding, json, secrets) || (json !== undefined && serializedExposes(withoutBom(text), JSON.parse(withoutBom(text)), secrets))) {
    if (!isPlain(bytes, text, encoding, json, secrets)) return withheld;
    mask = literalMask(text, secrets);
    if (!mask) return withheld;
    // The body with its literal echoes masked is judged exactly as a success body is and must reveal nothing.
    masked = maskText(text, mask);
    if (bodyExposes(encoder.encode(masked), masked, encoding, json, secrets)) return withheld;
  }
  // A leading byte order mark is dropped (a plain body, the only one redacted, has none).
  const start = text.startsWith("\uFEFF") ? 1 : 0;
  const { excerpt, end } = boundedExcerpt(text, mask, start, EXCERPT_BYTES);
  // What is returned is checked as returned: the excerpt (a marker beside the
  // text around it), and the numbers its cut leaves (`1.2345e4` of `1.2345e45`).
  if (exposes(excerpt, secrets)) return withheld;
  if (json !== undefined && end < text.length && exposes(canonicalNumbers(masked ?? text, json, start, end), secrets)) return withheld;
  return toolError(
    heading +
      (excerpt.length > 0 ? `\n\n${excerpt}` : "") +
      (end < text.length ? `\n[body truncated after ${encoder.encode(text.slice(start, end)).byteLength} bytes]` : ""),
  );
}

/**
 * Whether the literal text is the only reading of a body, so masking its
 * literal credential echoes removes every echo: it is UTF-8 that re-encodes to
 * the same bytes, with no NUL and no leading byte order mark; no decoding
 * (JSON escapes, percent escapes, `+` as a space, HTML references) changes it;
 * as JSON, it is its own compact serialization (the reading a success is
 * checked in), every number written as it parses; with a non-ASCII credential
 * form, it has no named reference left undecoded; and its bytes hold no
 * UTF-16 form of a credential. Each condition is checked on its own, never counted.
 */
function isPlain(bytes: Uint8Array, text: string, encoding: string, json: string | undefined, secrets: readonly string[]): boolean {
  if (encoding !== "utf-8" || text.includes("\u0000") || text.startsWith("\uFEFF")) return false;
  if (!sameBytes(encoder.encode(text), bytes)) return false;
  if (jsonUnescaped(text) !== text || percentDecoded(text) !== text || text.includes("+") || htmlUnescaped(text) !== text) return false;
  if (nonAsciiSecret(secrets) && opaqueReference(text)) return false;
  if (json !== undefined && (compactJson(text) !== text || canonicalNumbers(text, json, 0, text.length) !== text)) return false;
  const raw = binary(bytes);
  return !secrets.some((secret) => byteForms(secret).some(([name, form]) => name !== "utf-8" && raw.includes(form)));
}

/**
 * Whether a body reveals a credential to any reader: in `text` (its declared
 * or marked decoding), in its bytes read as UTF-8, in the bytes themselves
 * (UTF-8, UTF-16LE or UTF-16BE at any offset), or, when the body is JSON,
 * through a number a parser reads as one (`1.2345e4` as `12345`, also under
 * a duplicate key). `json` is the unmasked body when it is JSON: its strings
 * and syntax decide which characters are number tokens. The error path runs
 * it again on the body with its literal echoes masked, so both paths judge
 * the same views.
 */
function bodyExposes(
  bytes: Uint8Array,
  text: string,
  encoding: string,
  json: string | undefined,
  secrets: readonly string[],
): boolean {
  if (secrets.length === 0) return false;
  if (exposes(text, secrets)) return true;
  if (encoding !== "utf-8" && exposes(utf8Decoder.decode(bytes), secrets)) return true;
  if (bytesHold(bytes, secrets)) return true;
  return json !== undefined && exposes(canonicalNumbers(text, json, 0, text.length), secrets);
}

/** A JSON text as it serializes once parsed, or undefined when it cannot be (nesting too deep). */
function compactJson(text: string): string | undefined {
  try {
    return JSON.stringify(JSON.parse(text));
  } catch {
    return undefined;
  }
}

/** The body text when (a leading byte order mark aside) it is JSON and there is a credential to look for, else undefined. */
function jsonStructure(text: string, secrets: readonly string[]): string | undefined {
  return secrets.length > 0 && parseJson(withoutBom(text)).ok ? text : undefined;
}

/**
 * `text[from, to)` with each JSON number token written in another spelling
 * replaced by the one a parser's value serializes as. Which characters are
 * strings is read from `json` (the unmasked body, of the same length), so a
 * masked character never changes it and a token stops at one. Strings and
 * everything else are kept as written.
 */
function canonicalNumbers(text: string, json: string, from: number, to: number): string {
  const token = /-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
  const parts: string[] = [];
  let kept = from;
  for (let index = from; index < to; index += 1) {
    if (json[index] === '"') {
      // Skip the string, escapes included.
      for (index += 1; index < to && json[index] !== '"'; index += 1) if (json[index] === "\\") index += 1;
      continue;
    }
    const char = text[index]!;
    if (char !== "-" && (char < "0" || char > "9")) continue;
    token.lastIndex = index;
    let written = token.exec(text)?.[0];
    if (written === undefined) continue;
    // A token the range cuts is read as far as it is shown.
    if (index + written.length > to) written = /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text.slice(index, to))?.[0];
    if (written === undefined) continue;
    const value = String(Number(written));
    if (value !== written) {
      parts.push(text.slice(kept, index), value);
      kept = index + written.length;
    }
    index += written.length - 1;
  }
  parts.push(text.slice(kept, to));
  return parts.join("");
}

/** Which characters of `text` belong to a literal credential echo (overlaps included), or undefined when none does. */
function literalMask(text: string, secrets: readonly string[]): Uint8Array | undefined {
  let mask: Uint8Array | undefined;
  for (const secret of secrets) {
    // Occurrences come in order, so each character is marked once.
    let marked = 0;
    for (let at = text.indexOf(secret); at !== -1; at = text.indexOf(secret, at + 1)) {
      mask ??= new Uint8Array(text.length);
      const stop = at + secret.length;
      for (let index = Math.max(at, marked); index < stop; index += 1) mask[index] = 1;
      marked = stop;
    }
  }
  return mask;
}

/** `text` with each masked character replaced by U+FFFF, which no decoding produces or consumes. */
function maskText(text: string, mask: Uint8Array): string {
  let result = "";
  const units = new Uint16Array(Math.min(text.length, 0x8000));
  for (let at = 0; at < text.length; at += 0x8000) {
    const chunk = units.subarray(0, Math.min(text.length - at, 0x8000));
    for (let index = 0; index < chunk.length; index += 1) chunk[index] = mask[at + index] ? 0xffff : text.charCodeAt(at + index);
    result += String.fromCharCode(...chunk);
  }
  return result;
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) if (left[index] !== right[index]) return false;
  return true;
}

function withoutBom(text: string): string {
  return text.startsWith("\uFEFF") ? text.slice(1) : text;
}

function parseJson(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

/**
 * Whether the JSON `text`, parsed as `value`, reveals a credential as it
 * serializes (a number in another spelling, `1.2345e4` as `12345`). For a
 * value too deep to serialize, each number's serialized spelling is checked.
 */
function serializedExposes(text: string, value: unknown, secrets: readonly string[]): boolean {
  if (secrets.length === 0) return false;
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    serialized = numberTokens(text)
      .map((token) => String(Number(token)))
      .join("\n");
  }
  return exposes(serialized, secrets);
}

type ByteEncoding = "utf-8" | "utf-16le" | "utf-16be";

/** `secret` in each encoding a body's bytes are searched in, as one character per byte. */
function byteForms(secret: string): Array<[ByteEncoding, string]> {
  let little = "";
  let big = "";
  for (let index = 0; index < secret.length; index += 1) {
    const unit = secret.charCodeAt(index);
    little += String.fromCharCode(unit & 0xff, unit >> 8);
    big += String.fromCharCode(unit >> 8, unit & 0xff);
  }
  return [
    ["utf-8", binary(encoder.encode(secret))],
    ["utf-16le", little],
    ["utf-16be", big],
  ];
}

/** `bytes` as a string of one character per byte, so substring search runs on bytes at any offset. */
function binary(bytes: Uint8Array): string {
  let result = "";
  for (let at = 0; at < bytes.length; at += 0x8000) result += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  return result;
}

/** Whether the bytes hold any credential in UTF-8, UTF-16LE or UTF-16BE, at any offset. */
function bytesHold(bytes: Uint8Array, secrets: readonly string[]): boolean {
  if (secrets.length === 0) return false;
  const raw = binary(bytes);
  return secrets.some((secret) => byteForms(secret).some(([, form]) => raw.includes(form)));
}

/**
 * The excerpt of `text` from `start` that fits in `limit` UTF-8 bytes, each
 * masked run shown as the redaction marker, and where in `text` it stops. It
 * stops before a marker that would not fit and never splits a character;
 * nothing larger than the excerpt is built.
 */
function boundedExcerpt(
  text: string,
  mask: Uint8Array | undefined,
  start: number,
  limit: number,
): { excerpt: string; end: number } {
  let excerpt = "";
  let size = 0;
  let at = start;
  const markerSize = encoder.encode(REDACTED).byteLength;
  while (at < text.length) {
    const found = mask ? mask.indexOf(1, at) : -1;
    const run = found === -1 ? text.length : found;
    const fits = indexAtBytes(text, at, run, limit - size);
    const shown = text.slice(at, fits);
    excerpt += shown;
    size += encoder.encode(shown).byteLength;
    if (fits < run) return { excerpt, end: fits };
    if (run === text.length) break;
    if (size + markerSize > limit) return { excerpt, end: run };
    excerpt += REDACTED;
    size += markerSize;
    const stop = mask!.indexOf(0, run);
    at = stop === -1 ? text.length : stop;
  }
  return { excerpt, end: text.length };
}

/** The index in `text[from, to)` of the first character that would take its UTF-8 size past `limit`, or `to`. */
function indexAtBytes(text: string, from: number, to: number, limit: number): number {
  let bytes = 0;
  for (let index = from; index < to; index += 1) {
    const code = text.codePointAt(index)!;
    const size = code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
    if (bytes + size > limit) return index;
    bytes += size;
    if (code >= 0x10000) index += 1;
  }
  return to;
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

interface BodyText {
  text: string;
  /** The encoding the text was decoded from, as TextDecoder names it (`utf-8`, `utf-16le`, `windows-1252`, ...). */
  encoding: string;
}

/**
 * Decodes a body for credential matching and excerpts in the encoding it
 * marks or declares: a UTF-16 or UTF-8 byte order mark, else the
 * `Content-Type` charset, else UTF-8. A leading byte order mark is kept (a
 * credential may begin with U+FEFF). Undefined when the `Content-Type`
 * cannot be parsed or names a charset TextDecoder does not know, so the
 * body is withheld rather than checked in the wrong encoding.
 */
function decode(bytes: Uint8Array, response: Response): BodyText | undefined {
  let label: string | undefined;
  if (bytes[0] === 0xff && bytes[1] === 0xfe) label = "utf-16le";
  else if (bytes[0] === 0xfe && bytes[1] === 0xff) label = "utf-16be";
  else if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) label = "utf-8";
  else {
    const declared = charset(response.headers.get("content-type"));
    if (declared === null) return undefined;
    label = declared ?? "utf-8";
  }
  let decoder: TextDecoder;
  try {
    decoder = new TextDecoder(label, { ignoreBOM: true });
  } catch {
    return undefined;
  }
  return { text: decoder.decode(bytes), encoding: decoder.encoding };
}

const MEDIA_TOKEN = /[!#$%&'*+.^_`|~0-9A-Za-z-]+/y;

/**
 * Sets the Content-Type of a JSON body. An operator Content-Type is kept, as
 * written, only when its media type is the operation's documented one and any
 * charset it names is UTF-8 (the body is sent as UTF-8); otherwise the call is
 * refused before fetch, naming the header and never its value.
 */
function bodyContentType(headers: Headers, documented: string): void {
  const operator = headers.get("content-type");
  if (operator === null) {
    headers.set("content-type", documented);
    return;
  }
  if (contentTypeConflicts(operator, documented)) {
    throw new CallRejected(
      `The server's Content-Type header does not match the ${JSON.stringify(documentedEssence(documented))} body this operation sends, so the call was not made.`,
    );
  }
}

/**
 * Whether an operator Content-Type cannot label a body documented as
 * `documented`: it is not the same media type, names a charset other than
 * UTF-8, or the two do not have the same parameters other than `charset` (such
 * as `profile`): either side has a name the other lacks or gives it another
 * value (names compared without case, values exactly after unquoting). The
 * executor uses it both to choose a request body entry and to refuse a call,
 * so the two cannot disagree.
 */
function contentTypeConflicts(operator: string, documented: string): boolean {
  const parsed = parseMediaType(operator);
  if (parsed === null || parsed.essence !== documentedEssence(documented) || (parsed.charset !== undefined && !isUtf8(parsed.charset))) {
    return true;
  }
  const operatorValues = parameterValues(parsed.parameters);
  const documentedValues = parameterValues(parseMediaType(documented)?.parameters ?? []);
  if (operatorValues.size !== documentedValues.size) return true;
  for (const [name, value] of operatorValues) {
    if (value === null || documentedValues.get(name) !== value) return true;
  }
  return false;
}

/**
 * Non-charset media type parameters by name. A name given two different
 * values is ambiguous, so it maps to null and matches nothing.
 */
function parameterValues(parameters: Array<[name: string, value: string]>): Map<string, string | null> {
  const values = new Map<string, string | null>();
  for (const [name, value] of parameters) {
    const earlier = values.get(name);
    values.set(name, earlier === undefined || earlier === value ? value : null);
  }
  return values;
}

function documentedEssence(documented: string): string {
  return parseMediaType(documented)?.essence ?? documented.split(";")[0]!.trim().toLowerCase();
}

function isUtf8(charset: string): boolean {
  return /^utf-?8$/i.test(charset);
}

/**
 * The `charset` parameter of a media type, undefined when there is none, and
 * null when the header cannot be parsed or names two different charsets.
 */
function charset(contentType: string | null): string | undefined | null {
  if (contentType === null) return undefined;
  const parsed = parseMediaType(contentType);
  return parsed === null ? null : parsed.charset;
}

/**
 * A media type (RFC 9110: `type/subtype` then `;`-separated `name=value`
 * parameters, a value a token or a quoted string): its lowercased
 * `type/subtype`, its `charset` parameter and its other parameters (lowercased
 * name, unquoted value, in order), or null when the text cannot be parsed or
 * names two different charsets, so a `;` or `charset=` inside a quoted value
 * never picks the decoder.
 */
function parseMediaType(
  text: string,
): { essence: string; charset: string | undefined; parameters: Array<[name: string, value: string]> } | null {
  let at = 0;
  const skipSpace = () => {
    while (text[at] === " " || text[at] === "\t") at += 1;
  };
  const token = (): string | undefined => {
    MEDIA_TOKEN.lastIndex = at;
    const found = MEDIA_TOKEN.exec(text)?.[0];
    if (found !== undefined) at += found.length;
    return found;
  };
  skipSpace();
  const type = token();
  if (type === undefined || text[at] !== "/") return null;
  at += 1;
  const subtype = token();
  if (subtype === undefined) return null;
  const essence = `${type}/${subtype}`.toLowerCase();
  let found: string | undefined;
  const parameters: Array<[string, string]> = [];
  for (;;) {
    skipSpace();
    if (at === text.length) return { essence, charset: found, parameters };
    if (text[at] !== ";") return null;
    at += 1;
    skipSpace();
    // An empty parameter (`;;` or a trailing `;`).
    if (at === text.length || text[at] === ";") continue;
    const name = token();
    if (name === undefined || text[at] !== "=") return null;
    at += 1;
    let value: string | undefined;
    if (text[at] === '"') {
      value = "";
      for (at += 1; ; at += 1) {
        if (at >= text.length) return null;
        const char = text[at]!;
        if (char === '"') break;
        if (char === "\\") {
          at += 1;
          if (at >= text.length) return null;
          value += text[at];
        } else value += char;
      }
      at += 1;
    } else {
      value = token();
      if (value === undefined) return null;
    }
    if (name.toLowerCase() !== "charset") {
      parameters.push([name.toLowerCase(), value]);
      continue;
    }
    if (found !== undefined && found.toLowerCase() !== value.toLowerCase()) return null;
    found = value;
  }
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
function requestUrl(
  base: BaseUrl,
  operation: OpenApiOperation,
  args: Record<string, unknown>,
  credentials: ReadonlySet<string>,
): string {
  const path = base.path + renderPath(operation, args.path);
  const url = base.origin + path + renderQuery(operation, args.query, credentials);
  if (!pathSurvives(base, path, url)) throw new CallRejected("The operation path cannot be sent as written.");
  return url;
}

/** Whether a URL parser keeps `url` at the base origin with exactly `path` as its path. */
function pathSurvives(base: BaseUrl, path: string, url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return parsed.origin === base.origin && parsed.pathname === path;
}

/**
 * Why no call can send the operation's path: its template text outside the
 * `{name}` parts (each standing for an encoded value) is rewritten by a URL
 * parser, as `/a b` or `/café` is. The check is the one `requestUrl` makes.
 */
function pathRefusal(base: BaseUrl, operation: OpenApiOperation): string | undefined {
  const path = base.path + pathTemplate(operation).replace(/\{[^{}]*\}/g, "x");
  return pathSurvives(base, path, base.origin + path) ? undefined : "the operation path cannot be sent as written";
}

function pathTemplate(operation: OpenApiOperation): string {
  return operation.path.startsWith("/") ? operation.path : `/${operation.path}`;
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
  return pathTemplate(operation)
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

/**
 * `form` style query: arrays repeat the key (`explode: true`); `null` leaves
 * the parameter out, and so does an apiKey credential's name (D9), which no
 * caller value may fill.
 */
function renderQuery(operation: OpenApiOperation, group: unknown, credentials: ReadonlySet<string>): string {
  const pairs: string[] = [];
  for (const parameter of parametersIn(operation, "query")) {
    if (credentials.has(parameter.name)) continue;
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
 * or an apiKey credential (D9) and not a transport header; a value for one of
 * those, which validation never accepts, is dropped. A value for a header the
 * operator set is refused, never dropped silently. Undeclared names in the
 * arguments are never read; `null` leaves the header out.
 */
function requestHeaders(
  operation: OpenApiOperation,
  group: unknown,
  operator: Map<string, string>,
  credentials: ReadonlySet<string>,
): Headers {
  const headers = new Headers();
  for (const [name, value] of operator) headers.set(name, value);
  for (const parameter of parametersIn(operation, "header")) {
    const lower = parameter.name.toLowerCase();
    if (isForbiddenHeader(lower) || credentials.has(lower) || TRANSPORT_HEADERS.has(lower) || !HEADER_NAME.test(parameter.name)) {
      continue;
    }
    const value = argument(group, parameter.name);
    if (value === undefined || value === null) continue;
    if (operator.has(lower)) {
      throw new CallRejected(`The header parameter ${JSON.stringify(parameter.name)} is set by the server; leave it out.`);
    }
    const text = primitives(parameter, value).join(",");
    if (!PARAMETER_VALUE.test(text)) {
      throw new CallRejected(`The header parameter ${JSON.stringify(parameter.name)} has a value no HTTP header can carry.`);
    }
    headers.set(parameter.name, text);
  }
  return headers;
}

import { defaultCookieAccessor, readCsrfToken } from './cookies.js';
import { isRegionId } from './region-id.js';
import { collectBodyStrings, repeatsSecret, safeLabel, safeText, sharesText, type TextCheck } from './secret-text.js';
import type { AuthFnClientOptions, AuthFnClientRequestMetric, AuthFnErrorEnvelope } from './types.js';

interface RequestOptions {
  method: 'GET' | 'POST' | 'DELETE';
  path: string;
  body?: unknown;
  csrf?: boolean;
  /**
   * The body carries one-time secrets (a handoff code and verifier). The
   * body is serialized once, before anything is awaited, and its strings
   * are the secrets. Everything the request reports then passes through
   * `redactSensitive`: no response text, error message, stack or cause
   * reaches `onRequestMetric` or the returned error envelope.
   */
  sensitiveBody?: boolean;
}

const TRANSPORT_FAILURE_MESSAGE = 'AuthFn request failed before a response was received';
const REQUEST_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/;
const ERROR_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;
const DURATION_PATTERN = /^\d{1,9}(\.\d{1,6})?$/;
const COUNT_PATTERN = /^\d{1,9}$/;
const NETWORK_ERROR_CODE = 'AUTHFN_NETWORK_ERROR';
/** Up to 2048 characters, none of them whitespace or control characters (`new URL` drops some). */
const URL_TEXT_PATTERN = /^[^\s\u0000-\u001f\u007f-\u009f]{1,2048}$/;
const ISO_TIMESTAMP_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|[+-](\d{2}):(\d{2}))$/;
/** The request fields the social handoff exchange reports in a validation error. */
const EXCHANGE_VALIDATION_FIELDS: ReadonlySet<string> = new Set(['code', 'verifier', 'userId']);
/**
 * The error details current hosts act on, per code, each kept only when it
 * has its shape and shares no text with the body; all others are dropped.
 */
const KEPT_ERROR_DETAILS: Readonly<Record<string, Readonly<Record<string, TextCheck | 'boolean'>>>> = {
  AUTHFN_REGION_MISMATCH: {
    regionId: isRegionId,
    authority: isAbsoluteHttpUrl,
    redirectTo: isAbsoluteHttpUrl,
    continueLocally: 'boolean'
  },
  AUTHFN_RATE_LIMITED: { resetAt: isIsoTimestamp },
  AUTHFN_REDIRECT_REQUIRES_NAVIGATION: { redirectTo: isNavigationTarget },
  AUTHFN_VALIDATION_ERROR: { field: (value) => EXCHANGE_VALIDATION_FIELDS.has(value) }
};
/**
 * The metric header fields a sensitive request may report, each only when
 * it matches its pattern and shares no text with the body. `serverTiming`
 * is free text, so it is never reported.
 */
const SENSITIVE_METRIC_FIELDS = {
  requestId: REQUEST_ID_PATTERN,
  dbDurationMs: DURATION_PATTERN,
  dbCallCount: COUNT_PATTERN,
  cacheDurationMs: DURATION_PATTERN,
  cacheCallCount: COUNT_PATTERN,
  lookupDurationMs: DURATION_PATTERN,
  lookupCallCount: COUNT_PATTERN,
  workerColo: /^[A-Za-z0-9-]{1,16}$/,
  accountRegion: isRegionId
} as const satisfies Partial<Record<keyof AuthFnClientRequestMetric, TextCheck>>;
export function createAuthFnHttpClient(options: AuthFnClientOptions = {}) {
  const fetchImpl = options.fetch ?? fetch;
  const baseUrl = (options.baseUrl ?? '/auth').replace(/\/$/, '');
  const credentials = options.credentials ?? 'include';
  const cookieAccessor = options.cookieAccessor ?? defaultCookieAccessor;
  const cookiePrefix = options.cookiePrefix?.trim();
  const resolveBearerToken = async (): Promise<string | undefined> => {
    if (!options.bearerToken) {
      return undefined;
    }
    const token = typeof options.bearerToken === 'function'
      ? await options.bearerToken()
      : options.bearerToken;
    return token?.trim() || undefined;
  };
  const buildTransportError = (error: unknown): AuthFnErrorEnvelope => ({
    ok: false,
    error: {
      code: 'AUTHFN_NETWORK_ERROR',
      message:
        error instanceof Error
          ? error.message
          : 'AuthFn request failed before a response was received',
      retryable: true,
      details:
        error instanceof Error
          ? {
              name: error.name,
              stack: error.stack
            }
          : {
              cause: error
            }
    },
    requestId: 'authfn-transport-error'
  });

  // Sends one request; the body is serialized where it always was, after the bearer token.
  const transport = {
    send: async <T>(
      request: RequestOptions,
      serializeBody: () => string | undefined,
      report: (metric: AuthFnClientRequestMetric) => void
    ): Promise<T | AuthFnErrorEnvelope> => {
      const headers = new Headers();
      const url = `${baseUrl}${request.path}`;
      const startedAt = now();

      if (request.body !== undefined) {
        headers.set('content-type', 'application/json');
      }

      let response: Response;
      try {
        const bearerToken = await resolveBearerToken();
        if (bearerToken) {
          headers.set('authorization', `Bearer ${bearerToken}`);
        }

        if (request.csrf) {
          const csrfToken = readCsrfToken(cookieAccessor, cookiePrefix);
          if (csrfToken) {
            headers.set('x-authfn-csrf', csrfToken);
          }
        }

        response = await fetchImpl(url, {
          method: request.method,
          headers,
          credentials,
          body: serializeBody()
        });
      } catch (error) {
        report({
          method: request.method,
          path: request.path,
          url,
          ok: false,
          durationMs: now() - startedAt,
          error: error instanceof Error
            ? {
                name: error.name,
                message: error.message
              }
            : {
                message: String(error)
              }
        });
        return buildTransportError(error);
      }

      report({
        method: request.method,
        path: request.path,
        url,
        status: response.status,
        ok: response.ok,
        durationMs: now() - startedAt,
        requestId: response.headers.get('x-request-id') ?? undefined,
        serverTiming: response.headers.get('server-timing') ?? undefined,
        dbDurationMs: response.headers.get('x-account-db-duration-ms') ?? undefined,
        dbCallCount: response.headers.get('x-account-db-call-count') ?? undefined,
        cacheDurationMs: response.headers.get('x-account-cache-duration-ms') ?? undefined,
        cacheCallCount: response.headers.get('x-account-cache-call-count') ?? undefined,
        lookupDurationMs: response.headers.get('x-account-lookup-duration-ms') ?? undefined,
        lookupCallCount: response.headers.get('x-account-lookup-call-count') ?? undefined,
        workerColo: response.headers.get('x-account-worker-colo') ?? undefined,
        accountRegion: response.headers.get('x-account-region') ?? undefined
      });

      if (response.status >= 300 && response.status < 400 && response.headers.get('location')) {
        return {
          ok: false,
          error: {
            code: 'AUTHFN_REDIRECT_REQUIRES_NAVIGATION',
            message: 'Browser clients must use JSON callback mode or navigate directly for redirect-based auth flows',
            retryable: false,
            details: {
              status: response.status,
              redirectTo: response.headers.get('location')
            }
          },
          requestId: response.headers.get('x-request-id') ?? 'authfn-redirect'
        };
      }

      const raw = await response.text();
      if (!raw) {
        if (!response.ok) {
          return {
            ok: false,
            error: {
              code: 'AUTHFN_INTERNAL_ERROR',
              message: `AuthFn returned an empty error response (${response.status})`,
              retryable: response.status >= 500,
              details: {
                status: response.status
              }
            },
            requestId: response.headers.get('x-request-id') ?? 'authfn-empty'
          };
        }

        return {
          ok: true,
          data: {} as Record<string, never>,
          requestId: response.headers.get('x-request-id') ?? 'authfn-empty'
        } as T;
      }

      try {
        const parsed = JSON.parse(raw) as unknown;
        if (!isAuthFnEnvelope(parsed)) {
          return {
            ok: false,
            error: {
              code: 'AUTHFN_INTERNAL_ERROR',
              message: `AuthFn returned an invalid JSON envelope (${response.status})`,
              retryable: response.status >= 500,
              details: {
                status: response.status
              }
            },
            requestId: response.headers.get('x-request-id') ?? 'authfn-invalid-envelope'
          };
        }
        return parsed as T | AuthFnErrorEnvelope;
      } catch {
        return {
          ok: false,
          error: {
            code: 'AUTHFN_INTERNAL_ERROR',
            message: response.ok
              ? 'AuthFn returned a non-JSON response'
              : `AuthFn returned a non-JSON error response (${response.status})`,
            retryable: response.status >= 500,
            details: {
              status: response.status
            }
          },
          requestId: response.headers.get('x-request-id') ?? 'authfn-non-json'
        };
      }
    }
  };

  /**
   * A request whose body holds secrets: the body is serialized and its
   * secrets collected before anything is awaited, so a caller that changes
   * the object later changes neither, and the request reports only what
   * `redactSensitive` lets through.
   */
  const sendSensitive = async <T>(request: RequestOptions): Promise<T | AuthFnErrorEnvelope> => {
    let body: string | undefined;
    let secrets: string[];
    try {
      body = request.body !== undefined ? JSON.stringify(request.body) : undefined;
      secrets = body === undefined ? [] : collectBodyStrings(JSON.parse(body));
    } catch {
      return redactSensitive.envelope(undefined, undefined, []) as AuthFnErrorEnvelope;
    }
    let status: number | undefined;
    let requestId: string | undefined;
    let result: unknown;
    let transportFailed = false;
    try {
      result = await transport.send<T>(request, () => body, (metric) => {
        status = metric.status;
        requestId = metric.requestId;
        try {
          options.onRequestMetric?.(redactSensitive.metric(metric, secrets));
        } catch {
          // A failing metric hook must not turn an issued session into an error.
        }
      });
    } catch {
      // The response arrived but its body could not be read (for example an
      // aborted stream): the request did not complete, as when fetch fails.
      transportFailed = true;
      result = { ok: false, error: { code: NETWORK_ERROR_CODE, retryable: true }, requestId };
    }
    return redactSensitive.envelope(
      result,
      status,
      secrets,
      transportFailed,
      absoluteUrl(`${baseUrl}${request.path}`)
    ) as T | AuthFnErrorEnvelope;
  };

  return {
    requestJson: <T>(request: RequestOptions): Promise<T | AuthFnErrorEnvelope> =>
      request.sensitiveBody === true
        ? sendSensitive<T>(request)
        : transport.send<T>(
            request,
            () => (request.body !== undefined ? JSON.stringify(request.body) : undefined),
            (metric) => options.onRequestMetric?.(metric)
          )
  };
}

/**
 * The one shape a sensitive request reports in. The metric keeps method,
 * path, url, status, ok and duration, plus header fields that match their
 * pattern and share no text with the body; a transport failure is a fixed
 * name and message. A success envelope is passed on with a safe request id;
 * any other result becomes an error envelope with a code that matches the
 * error code pattern, a fixed message, `details: { status }` and a safe
 * request id, plus the few details `KEPT_ERROR_DETAILS` lists for its code.
 * An error code or detail equal to one of the client's fixed public labels
 * (`safeLabel`) is that label, not a reflection of the body.
 * A success envelope with any string (other than its request id) that
 * repeats the body is not passed on: it becomes that error envelope too.
 * A request that failed before
 * its response was read (fetch threw, or the body stream failed) is
 * `AUTHFN_NETWORK_ERROR` with the fixed transport message.
 */
const redactSensitive = {
  metric(metric: AuthFnClientRequestMetric, secrets: readonly string[]): AuthFnClientRequestMetric {
    const safe: AuthFnClientRequestMetric = {
      method: metric.method,
      path: metric.path,
      url: metric.url,
      ...(metric.status !== undefined ? { status: metric.status } : {}),
      ok: metric.ok,
      durationMs: metric.durationMs
    };
    for (const [field, check] of Object.entries(SENSITIVE_METRIC_FIELDS)) {
      const value = safeText(metric[field as keyof typeof SENSITIVE_METRIC_FIELDS], check, secrets);
      if (value !== undefined) {
        safe[field as keyof typeof SENSITIVE_METRIC_FIELDS] = value;
      }
    }
    if (metric.error) {
      safe.error = { name: 'AuthFnTransportError', message: TRANSPORT_FAILURE_MESSAGE };
    }
    return safe;
  },

  envelope(
    result: unknown,
    status: number | undefined,
    secrets: readonly string[],
    transportFailed = false,
    requestUrl?: string
  ): unknown {
    const candidate = (typeof result === 'object' && result !== null ? result : {}) as {
      ok?: unknown;
      requestId?: unknown;
      error?: { code?: unknown; retryable?: unknown; details?: unknown };
    };
    const requestId = safeText(candidate.requestId, REQUEST_ID_PATTERN, secrets) ?? 'authfn-redacted';
    if (candidate.ok === true) {
      // The request id is replaced on its own; any other string that repeats
      // the body turns the whole success into an error.
      const { requestId: _requestId, ...rest } = candidate;
      if (!repeatsSecret(rest, secrets)) {
        return candidate.requestId === requestId ? result : { ...candidate, requestId };
      }
    }
    const error = candidate.ok !== true && typeof candidate.error === 'object' && candidate.error !== null
      ? candidate.error
      : {};
    const code = safeLabel(error.code, ERROR_CODE_PATTERN, secrets) ?? 'AUTHFN_INTERNAL_ERROR';
    return {
      ok: false,
      error: {
        code,
        message: status === undefined || transportFailed ? TRANSPORT_FAILURE_MESSAGE : `AuthFn request failed (${status})`,
        retryable: typeof error.retryable === 'boolean' ? error.retryable : status === undefined || status >= 500,
        details: {
          ...(status === undefined ? {} : { status }),
          ...keptDetails(code, error.details, secrets, requestUrl)
        }
      },
      requestId
    } satisfies AuthFnErrorEnvelope;
  }
};

/**
 * The details of `KEPT_ERROR_DETAILS[code]` that have their shape and share
 * no text with `secrets`. A navigation target is judged against `requestUrl`,
 * the URL the request was sent to.
 */
function keptDetails(
  code: string,
  details: unknown,
  secrets: readonly string[],
  requestUrl: string | undefined
): Record<string, unknown> {
  const fields = Object.hasOwn(KEPT_ERROR_DETAILS, code) ? KEPT_ERROR_DETAILS[code]! : {};
  const kept: Record<string, unknown> = {};
  for (const [field, rule] of Object.entries(fields)) {
    const check: TextCheck | 'boolean' = rule === isNavigationTarget
      ? (value: string) => isNavigationTarget(value, requestUrl)
      : rule;
    const value = details && typeof details === 'object' && Object.hasOwn(details, field)
      ? (details as Record<string, unknown>)[field]
      : undefined;
    const keep = check === 'boolean'
      ? typeof value === 'boolean'
      : safeLabel(value, check, secrets) !== undefined
        && !((rule === isAbsoluteHttpUrl || rule === isNavigationTarget) && parsedUrlSharesText(value as string, secrets));
    if (keep) {
      kept[field] = value;
    }
  }
  return kept;
}

/**
 * An ISO-8601 date and time with a zone whose calendar fields all exist, so
 * an impossible date such as February 31, which `Date.parse` rolls over, fails.
 */
function isIsoTimestamp(value: string): boolean {
  const match = ISO_TIMESTAMP_PATTERN.exec(value);
  if (!match) {
    return false;
  }
  const [year, month, day, hour, minute, second, offsetHour = 0, offsetMinute = 0] = match
    .slice(1)
    .map((part) => (part === undefined ? undefined : Number(part)));
  const leapYear = year! % 4 === 0 && (year! % 100 !== 0 || year! % 400 === 0);
  const daysInMonth = month === 2 ? (leapYear ? 29 : 28) : [4, 6, 9, 11].includes(month!) ? 30 : 31;
  return month! >= 1 && month! <= 12 && day! >= 1 && day! <= daysInMonth
    && hour! <= 23 && minute! <= 59 && second! <= 59
    && offsetHour <= 23 && offsetMinute <= 59;
}

/** An absolute http(s) URL of at most 2048 characters, without credentials. */
function isAbsoluteHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return URL_TEXT_PATTERN.test(value) && /^https?:$/.test(url.protocol) && !url.username && !url.password;
  } catch {
    return false;
  }
}

/**
 * An absolute http(s) URL as `isAbsoluteHttpUrl` accepts, or a reference
 * relative to the request (a path, '../', '?query' or '#fragment' with no
 * scheme and no '//' authority) that resolves against `requestUrl` to such a
 * URL. The value is kept as sent, so the host resolves it as the server meant.
 * Without an absolute request URL it is checked against a placeholder http
 * base: a reference with no scheme and no authority cannot leave whatever
 * origin the host resolves it against, nor add credentials.
 */
function isNavigationTarget(value: string, requestUrl?: string): boolean {
  if (isAbsoluteHttpUrl(value)) {
    return true;
  }
  // A scheme ('mailto:', 'javascript:', 'https:host') or an authority
  // ('//host', or the same with backslashes) leaves the request's origin.
  if (!URL_TEXT_PATTERN.test(value) || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(value) || /^[/\\][/\\]/.test(value)) {
    return false;
  }
  try {
    const resolved = new URL(value, requestUrl ?? 'http://authfn.invalid/');
    return /^https?:$/.test(resolved.protocol) && !resolved.username && !resolved.password;
  } catch {
    return false;
  }
}

/** `url` as an absolute URL, resolved against the page when it is relative, or `undefined`. */
function absoluteUrl(url: string): string | undefined {
  const page = (globalThis as { location?: { href?: unknown } }).location?.href;
  try {
    return new URL(url, typeof page === 'string' ? page : undefined).href;
  } catch {
    return undefined;
  }
}

/**
 * Whether the URL as `new URL` rebuilds it shares text with `secrets`: its
 * href, and its hostname (lowercased and IDNA-mapped, so upper case, fullwidth
 * letters or an ignored soft hyphen can spell a secret) against the
 * lowercased secrets. A value that does not parse counts as sharing.
 */
function parsedUrlSharesText(value: string, secrets: readonly string[]): boolean {
  let url: URL;
  try {
    url = new URL(value, 'http://authfn.invalid');
  } catch {
    return true;
  }
  return secrets.some((secret) => sharesText(url.href, secret) || sharesText(url.hostname, secret.toLowerCase()));
}

function now(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

function isAuthFnEnvelope(value: unknown): value is { ok: boolean; requestId: string } {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  if (typeof candidate.ok !== 'boolean' || typeof candidate.requestId !== 'string') {
    return false;
  }

  if (candidate.ok) {
    return 'data' in candidate;
  }

  const error = candidate.error;
  if (typeof error !== 'object' || error === null) {
    return false;
  }

  const envelopeError = error as Record<string, unknown>;
  return (
    typeof envelopeError.code === 'string'
    && typeof envelopeError.message === 'string'
    && typeof envelopeError.retryable === 'boolean'
  );
}

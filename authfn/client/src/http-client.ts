import { defaultCookieAccessor, readCsrfToken } from './cookies.js';
import { isRegionId } from './region-id.js';
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
const REGION_MISMATCH_CODE = 'AUTHFN_REGION_MISMATCH';
/** A check a reported value must pass: a pattern it matches or a predicate. */
type TextCheck = RegExp | ((value: string) => boolean);
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
  accountRegion: /^[A-Za-z0-9_.-]{1,64}$/
} as const satisfies Partial<Record<keyof AuthFnClientRequestMetric, TextCheck>>;
/** A reported value may not repeat this many consecutive characters of a secret. */
const SECRET_WINDOW = 8;

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
    return redactSensitive.envelope(result, status, secrets, transportFailed) as T | AuthFnErrorEnvelope;
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
 * request id. The one exception is `AUTHFN_REGION_MISMATCH`, whose
 * `details.regionId` names the region to retry in: it is kept when it is a
 * region id that shares no text with the body. A request that failed before
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
    transportFailed = false
  ): unknown {
    const candidate = (typeof result === 'object' && result !== null ? result : {}) as {
      ok?: unknown;
      requestId?: unknown;
      error?: { code?: unknown; retryable?: unknown; details?: unknown };
    };
    const requestId = safeText(candidate.requestId, REQUEST_ID_PATTERN, secrets) ?? 'authfn-redacted';
    if (candidate.ok === true) {
      return candidate.requestId === requestId ? result : { ...candidate, requestId };
    }
    const error = typeof candidate.error === 'object' && candidate.error !== null ? candidate.error : {};
    const code = safeText(error.code, ERROR_CODE_PATTERN, secrets) ?? 'AUTHFN_INTERNAL_ERROR';
    const regionId = code === REGION_MISMATCH_CODE && typeof error.details === 'object' && error.details !== null
      ? safeText((error.details as { regionId?: unknown }).regionId, isRegionId, secrets)
      : undefined;
    return {
      ok: false,
      error: {
        code,
        message: status === undefined || transportFailed ? TRANSPORT_FAILURE_MESSAGE : `AuthFn request failed (${status})`,
        retryable: typeof error.retryable === 'boolean' ? error.retryable : status === undefined || status >= 500,
        details: {
          ...(status === undefined ? {} : { status }),
          ...(regionId === undefined ? {} : { regionId })
        }
      },
      requestId
    } satisfies AuthFnErrorEnvelope;
  }
};

/** `value` when it is a string that passes `check` and shares no text with `secrets`. */
function safeText(value: unknown, check: TextCheck, secrets: readonly string[]): string | undefined {
  if (typeof value !== 'string' || !(typeof check === 'function' ? check(value) : check.test(value))) {
    return undefined;
  }
  return secrets.some((secret) => sharesText(value, secret)) ? undefined : value;
}

/** Whether `value` contains `secret`, or any run of `SECRET_WINDOW` of its characters. */
function sharesText(value: string, secret: string): boolean {
  if (secret.length <= SECRET_WINDOW) {
    return value.includes(secret);
  }
  for (let index = 0; index + SECRET_WINDOW <= secret.length; index += 1) {
    if (value.includes(secret.slice(index, index + SECRET_WINDOW))) {
      return true;
    }
  }
  return false;
}

/** Every non-empty string value in a JSON request body. */
function collectBodyStrings(body: unknown, found: string[] = []): string[] {
  if (typeof body === 'string') {
    if (body.length > 0) {
      found.push(body);
    }
  } else if (Array.isArray(body)) {
    for (const item of body) {
      collectBodyStrings(item, found);
    }
  } else if (body && typeof body === 'object') {
    for (const value of Object.values(body)) {
      collectBodyStrings(value, found);
    }
  }
  return found;
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

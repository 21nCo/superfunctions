import { err, ok, type Envelope } from '@superfunctions/envelope';
import type { SuperfunctionError } from '@superfunctions/errors';

export function jsonResponse<T>(body: Envelope<T>, status: number = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json'
    }
  });
}

export function successResponse<T>(data: T, status: number = 200): Response {
  return jsonResponse(ok(data), status);
}

/**
 * Error detail keys never returned to a caller: a provider's raw response body and configuration (bundle ids,
 * catalog price ids). They stay on the thrown error for the host's logs.
 */
const PRIVATE_DETAIL_KEYS: ReadonlySet<string> = new Set(['body', 'raw', 'rawBody', 'bundleIds', 'matchingPriceIds']);

/** The error details safe to return over HTTP: a plain object without the private keys. */
export function publicErrorDetails(details: unknown): Record<string, unknown> | undefined {
  if (details === null || typeof details !== 'object' || Array.isArray(details)) {
    return undefined;
  }
  const kept = Object.entries(details as Record<string, unknown>).filter(([key]) => !PRIVATE_DETAIL_KEYS.has(key));
  return kept.length > 0 ? Object.fromEntries(kept) : undefined;
}

export function errorResponse(error: Error): Response {
  if (isSuperfunctionError(error)) {
    return jsonResponse(
      err({
        code: error.code,
        message: error.message,
        status: error.status,
        retryable: error.retryable,
        details: publicErrorDetails(error.details)
      }),
      error.status
    );
  }

  return jsonResponse(
    err({
      code: 'BILLFN_INTERNAL_ERROR',
      message: 'Unexpected billfn error',
      status: 500,
      retryable: false
    }),
    500
  );
}

function isSuperfunctionError(value: Error): value is SuperfunctionError {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { code?: unknown }).code === 'string' &&
    typeof (value as { status?: unknown }).status === 'number' &&
    typeof (value as { retryable?: unknown }).retryable === 'boolean'
  );
}

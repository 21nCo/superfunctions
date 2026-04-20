/**
 * Canonical BrowseFn error and router envelope definitions.
 */

export const BROWSEFN_ERROR_CODES = [
  'INVALID_ARGUMENT',
  'INVALID_URL',
  'UNSUPPORTED_PROVIDER',
  'UNSUPPORTED_PROVIDER_CAPABILITY',
  'PROVIDER_UNAVAILABLE',
  'PROVIDER_ERROR',
  'RATE_LIMITED',
  'UPSTREAM_TIMEOUT',
  'UPSTREAM_NOT_FOUND',
  'DOWNLOAD_EXISTS',
  'DOWNLOAD_TOO_LARGE',
  'SECURITY_POLICY_BLOCKED',
  'CACHE_ERROR',
  'INTERNAL_ERROR',
] as const;

export type BrowseFnErrorCode = typeof BROWSEFN_ERROR_CODES[number];

export interface BrowseFnSuccessEnvelope<T> {
  ok: true;
  data: T;
  meta: {
    requestId: string;
    provider?: string;
    cached?: boolean;
    durationMs?: number;
    fallbackFrom?: string;
  };
}

export interface BrowseFnErrorEnvelope {
  ok: false;
  error: {
    code: BrowseFnErrorCode;
    message: string;
    provider?: string;
    retryAfterMs?: number;
    details?: Record<string, unknown>;
  };
  meta: {
    requestId: string;
  };
}

export class BrowseFnError extends Error {
  readonly code: BrowseFnErrorCode;
  readonly provider?: string;
  readonly retryAfterMs?: number;
  readonly details?: Record<string, unknown>;

  constructor(input: {
    code: BrowseFnErrorCode;
    message: string;
    provider?: string;
    retryAfterMs?: number;
    details?: Record<string, unknown>;
  }) {
    super(input.message);
    this.name = 'BrowseFnError';
    this.code = input.code;
    this.provider = input.provider;
    this.retryAfterMs = input.retryAfterMs;
    this.details = input.details;
  }
}

export function isBrowseFnError(error: unknown): error is BrowseFnError {
  return error instanceof BrowseFnError;
}

export function createSuccessEnvelope<T>(
  data: T,
  meta: BrowseFnSuccessEnvelope<T>['meta']
): BrowseFnSuccessEnvelope<T> {
  return { ok: true, data, meta };
}

export function createErrorEnvelope(
  error: BrowseFnError,
  requestId: string
): BrowseFnErrorEnvelope {
  return {
    ok: false,
    error: {
      code: error.code,
      message: error.message,
      provider: error.provider,
      retryAfterMs: error.retryAfterMs,
      details: error.details,
    },
    meta: { requestId },
  };
}

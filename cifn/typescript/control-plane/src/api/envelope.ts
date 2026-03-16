import { createErrorRegistry } from '@superfunctions/errors';
import {
  err as createEnvelopeError,
  ok as createEnvelopeSuccess,
  toLegacyDataEnvelope,
} from '@superfunctions/envelope';

/** Canonical error code set per SPEC.md (v1). */
export type ErrorCode =
  | 'BAD_REQUEST'
  | 'UNAUTHORIZED'
  | 'RUNNER_TOKEN_INVALID'
  | 'PIPELINE_INVALID'
  | 'RUN_CREATE_FAILED'
  | 'RUN_NOT_FOUND'
  | 'RUN_ALREADY_FINISHED'
  | 'RUNNER_NOT_FOUND'
  | 'INTERNAL_ERROR';

export interface SuccessEnvelope<T> {
  ok: true;
  data: T;
}

export interface ErrorEnvelope {
  ok: false;
  error: {
    code: ErrorCode;
    message: string;
    details?: Record<string, unknown>;
  };
}

export type Envelope<T> = SuccessEnvelope<T> | ErrorEnvelope;

const errorRegistry = createErrorRegistry([
  { code: 'BAD_REQUEST', httpStatus: 400, retryable: false },
  { code: 'UNAUTHORIZED', httpStatus: 401, retryable: false },
  { code: 'RUNNER_TOKEN_INVALID', httpStatus: 401, retryable: false },
  { code: 'PIPELINE_INVALID', httpStatus: 422, retryable: false },
  { code: 'RUN_CREATE_FAILED', httpStatus: 422, retryable: false },
  { code: 'RUN_NOT_FOUND', httpStatus: 404, retryable: false },
  { code: 'RUN_ALREADY_FINISHED', httpStatus: 409, retryable: false },
  { code: 'RUNNER_NOT_FOUND', httpStatus: 404, retryable: false },
  { code: 'INTERNAL_ERROR', httpStatus: 500, retryable: true },
]);

export function success<T>(data: T): SuccessEnvelope<T> {
  const canonical = createEnvelopeSuccess(data);
  const legacy = toLegacyDataEnvelope(canonical);
  return { ok: true, data: legacy.data };
}

export function error(
  code: ErrorCode,
  message: string,
  details?: Record<string, unknown>,
): ErrorEnvelope {
  const resolved = errorRegistry.resolveOrDefault(code, {
    httpStatus: 500,
    retryable: code === 'INTERNAL_ERROR',
  });
  const canonical = createEnvelopeError({
    code,
    message,
    status: resolved.httpStatus,
    retryable: resolved.retryable,
    details,
  });
  const legacy = toLegacyDataEnvelope(canonical);
  return legacy;
}

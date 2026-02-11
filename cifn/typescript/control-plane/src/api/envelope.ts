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

export function success<T>(data: T): SuccessEnvelope<T> {
  return { ok: true, data };
}

export function error(
  code: ErrorCode,
  message: string,
  details?: Record<string, unknown>,
): ErrorEnvelope {
  return {
    ok: false,
    error: { code, message, ...(details ? { details } : {}) },
  };
}

export const ErrorCode = {
  BAD_REQUEST: 'BAD_REQUEST',
  UNAUTHORIZED: 'UNAUTHORIZED',
  BOT_NOT_FOUND: 'BOT_NOT_FOUND',
  RECORDING_NOT_FOUND: 'RECORDING_NOT_FOUND',
  TRANSCRIPT_NOT_FOUND: 'TRANSCRIPT_NOT_FOUND',
  WEBHOOK_NOT_FOUND: 'WEBHOOK_NOT_FOUND',
  CALENDAR_NOT_FOUND: 'CALENDAR_NOT_FOUND',
  BOT_ALREADY_LEFT: 'BOT_ALREADY_LEFT',
  BOT_STILL_ACTIVE: 'BOT_STILL_ACTIVE',
  TRANSCRIPTION_IN_PROGRESS: 'TRANSCRIPTION_IN_PROGRESS',
  BOT_CREATE_FAILED: 'BOT_CREATE_FAILED',
  ANALYTICS_NOT_READY: 'ANALYTICS_NOT_READY',
  CALENDAR_AUTH_FAILED: 'CALENDAR_AUTH_FAILED',
  PLATFORM_ERROR: 'PLATFORM_ERROR',
  PLATFORM_CAPTURE_UNAVAILABLE: 'PLATFORM_CAPTURE_UNAVAILABLE',
  REALTIME_TRANSCRIPT_UNSUPPORTED: 'REALTIME_TRANSCRIPT_UNSUPPORTED',
  ASR_ERROR: 'ASR_ERROR',
  RECORDING_FINALIZATION_FAILED: 'RECORDING_FINALIZATION_FAILED',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  INVALID_TRANSITION: 'INVALID_TRANSITION',
  RATE_LIMIT_EXCEEDED: 'RATE_LIMIT_EXCEEDED',
} as const;

export type ErrorCodeType = (typeof ErrorCode)[keyof typeof ErrorCode];

export const ErrorHttpStatus: Record<string, number> = {
  [ErrorCode.BAD_REQUEST]: 400,
  [ErrorCode.UNAUTHORIZED]: 401,
  [ErrorCode.BOT_NOT_FOUND]: 404,
  [ErrorCode.RECORDING_NOT_FOUND]: 404,
  [ErrorCode.TRANSCRIPT_NOT_FOUND]: 404,
  [ErrorCode.WEBHOOK_NOT_FOUND]: 404,
  [ErrorCode.CALENDAR_NOT_FOUND]: 404,
  [ErrorCode.BOT_ALREADY_LEFT]: 409,
  [ErrorCode.BOT_STILL_ACTIVE]: 409,
  [ErrorCode.TRANSCRIPTION_IN_PROGRESS]: 409,
  [ErrorCode.BOT_CREATE_FAILED]: 422,
  [ErrorCode.ANALYTICS_NOT_READY]: 422,
  [ErrorCode.CALENDAR_AUTH_FAILED]: 401,
  [ErrorCode.PLATFORM_ERROR]: 502,
  [ErrorCode.PLATFORM_CAPTURE_UNAVAILABLE]: 503,
  [ErrorCode.REALTIME_TRANSCRIPT_UNSUPPORTED]: 422,
  [ErrorCode.ASR_ERROR]: 502,
  [ErrorCode.RECORDING_FINALIZATION_FAILED]: 502,
  [ErrorCode.INTERNAL_ERROR]: 500,
  [ErrorCode.INVALID_TRANSITION]: 400,
  [ErrorCode.RATE_LIMIT_EXCEEDED]: 429,
};

export interface RecFnErrorOptions {
  code: ErrorCodeType;
  message: string;
  details?: Record<string, unknown>;
}

export class RecFnError extends Error {
  readonly code: ErrorCodeType;
  readonly httpStatus: number;
  readonly details?: Record<string, unknown>;

  constructor(opts: RecFnErrorOptions) {
    super(opts.message);
    this.name = 'RecFnError';
    this.code = opts.code;
    this.httpStatus = ErrorHttpStatus[opts.code] ?? 500;
    this.details = opts.details;
  }

  toEnvelope() {
    return {
      ok: false as const,
      error: {
        code: this.code,
        message: this.message,
        details: this.details ?? {},
      },
    };
  }
}

export function createError(
  code: ErrorCodeType,
  message: string,
  details?: Record<string, unknown>,
): RecFnError {
  return new RecFnError({ code, message, details });
}

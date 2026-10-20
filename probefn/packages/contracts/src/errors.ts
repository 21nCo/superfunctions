import { createErrorEnvelope, type ErrorEnvelope, type JsonObject } from './envelopes.js';

export const ERROR_CODES = [
  'E_CONFIG_INVALID',
  'E_SESSION_NOT_FOUND',
  'E_SESSION_START_CANCELLED',
  'E_SESSION_ALREADY_RUNNING',
  'E_DEVSERVER_START_TIMEOUT',
  'E_DEVSERVER_EXIT_EARLY',
  'E_URL_UNREACHABLE',
  'E_BROWSER_LAUNCH_FAILED',
  'E_ACTION_TARGET_NOT_FOUND',
  'E_ACTION_AMBIGUOUS',
  'E_ACTION_NOT_INTERACTABLE',
  'E_CHECKPOINT_CAPTURE_FAILED',
  'E_BASELINE_NOT_FOUND',
  'E_BASELINE_MISMATCH',
  'E_AUTH_PROFILE_NOT_FOUND',
  'E_STORAGE_WRITE_FAILED',
  'E_STORAGE_CAP_EXCEEDED',
  'E_ANALYZER_FAILURE',
  'E_REDACTION_FAILURE',
  'E_MCP_INVALID_ARGS',
  'E_INTERNAL',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export interface ProbefnErrorOptions {
  code: ErrorCode;
  message: string;
  retryable?: boolean;
  details?: JsonObject;
  cause?: unknown;
}

export class ProbefnError extends Error {
  public readonly code: ErrorCode;
  public readonly retryable: boolean;
  public readonly details?: JsonObject;

  public constructor(options: ProbefnErrorOptions) {
    super(options.message, options.cause ? { cause: options.cause } : undefined);
    this.name = 'ProbefnError';
    this.code = options.code;
    this.retryable = options.retryable ?? false;
    if (options.details) {
      this.details = options.details;
    }
  }
}

export function createProbefnError(options: ProbefnErrorOptions): ProbefnError {
  return new ProbefnError(options);
}

export function isProbefnError(value: unknown): value is ProbefnError {
  return value instanceof ProbefnError;
}

export function toErrorEnvelope(error: unknown): ErrorEnvelope {
  if (isProbefnError(error)) {
    const shape = {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
    } satisfies Omit<ErrorEnvelope['error'], 'details'>;

    return createErrorEnvelope({
      ...shape,
      ...(error.details ? { details: error.details } : {}),
    });
  }

  return createErrorEnvelope({
    code: 'E_INTERNAL',
    message: error instanceof Error ? error.message : 'An unknown internal error occurred.',
    retryable: false,
  });
}

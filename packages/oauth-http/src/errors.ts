export type OAuthHttpErrorCode =
  | "OAUTH_TOKEN_EXCHANGE_FAILED"
  | "OAUTH_TOKEN_REFRESH_FAILED"
  | "PROVIDER_RATE_LIMITED"
  | "VALIDATION_ERROR"
  | "INTERNAL_ERROR";

export interface OAuthHttpErrorOptions {
  code: OAuthHttpErrorCode;
  status?: number;
  retryable?: boolean;
  details?: Record<string, unknown>;
}

export class OAuthHttpError extends Error {
  readonly code: OAuthHttpErrorCode;
  readonly status?: number;
  readonly retryable: boolean;
  readonly details?: Record<string, unknown>;

  constructor(message: string, options: OAuthHttpErrorOptions) {
    super(message);
    this.name = "OAuthHttpError";
    this.code = options.code;
    this.status = options.status;
    this.retryable = options.retryable ?? false;
    this.details = options.details;
  }
}

export function unsupportedTokenAuthMethodError(tokenAuthMethod: string): OAuthHttpError {
  return new OAuthHttpError("unsupported token auth method", {
    code: "VALIDATION_ERROR",
    status: 400,
    retryable: false,
    details: { tokenAuthMethod }
  });
}

export function normalizeOAuthErrorBody(rawBody: unknown): { message: string; details?: Record<string, unknown> } {
  if (!rawBody || typeof rawBody !== "object") {
    return { message: "OAuth provider request failed" };
  }

  const payload = rawBody as Record<string, unknown>;
  const description =
    asString(payload.error_description) ??
    asString(payload.message) ??
    asString(payload.error) ??
    asString(payload.detail) ??
    "OAuth provider request failed";

  return {
    message: description,
    details: payload
  };
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

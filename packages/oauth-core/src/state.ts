import type { OAuthStateRecord, OAuthStateStore } from "@superfunctions/oauth-storage";

export type OAuthCoreErrorCode =
  | "OAUTH_STATE_INVALID"
  | "OAUTH_STATE_REPLAYED"
  | "OAUTH_CALLBACK_MISMATCH"
  | "OAUTH_REDIRECT_DISALLOWED"
  | "OAUTH_PROVIDER_UNSUPPORTED"
  | "OAUTH_RUNTIME_CONFIG_INVALID"
  | "VALIDATION_ERROR"
  | "OAUTH_TOKEN_REFRESH_FAILED";

export class OAuthCoreError extends Error {
  readonly code: OAuthCoreErrorCode;
  readonly status: number;
  readonly retryable: boolean;
  readonly details?: Record<string, unknown>;

  constructor(
    code: OAuthCoreErrorCode,
    message: string,
    options?: { status?: number; retryable?: boolean; details?: Record<string, unknown> }
  ) {
    super(message);
    this.name = "OAuthCoreError";
    this.code = code;
    this.status = options?.status ?? 400;
    this.retryable = options?.retryable ?? false;
    this.details = options?.details;
  }
}

export interface CallbackStateMatchInput {
  providerId: string;
  redirectUri: string;
}

export function assertRedirectUriAllowed(redirectUri: string, allowlistedRedirectUris: ReadonlyArray<string>): void {
  if (allowlistedRedirectUris.length === 0) {
    return;
  }

  if (!allowlistedRedirectUris.includes(redirectUri)) {
    throw new OAuthCoreError("OAUTH_REDIRECT_DISALLOWED", "redirect URI not allowed");
  }
}

export function assertCallbackStateMatches(input: CallbackStateMatchInput, state: OAuthStateRecord): void {
  if (input.providerId !== state.providerId) {
    throw new OAuthCoreError("OAUTH_CALLBACK_MISMATCH", "provider mismatch for OAuth callback");
  }

  if (input.redirectUri !== state.redirectUri) {
    throw new OAuthCoreError("OAUTH_CALLBACK_MISMATCH", "redirect URI not allowed");
  }
}

export async function consumeStateOrThrow(
  stateStore: OAuthStateStore,
  stateId: string,
  consumedAt: string
): Promise<OAuthStateRecord> {
  const consumed = await stateStore.consume(stateId, consumedAt);
  if (consumed) {
    if (Date.parse(consumed.expiresAt) <= Date.parse(consumedAt)) {
      throw new OAuthCoreError("OAUTH_STATE_INVALID", "OAuth state is invalid or expired");
    }

    return consumed;
  }

  const existing = await stateStore.get(stateId);
  if (existing?.consumedAt) {
    throw new OAuthCoreError("OAUTH_STATE_REPLAYED", "OAuth state already consumed");
  }

  throw new OAuthCoreError("OAUTH_STATE_INVALID", "OAuth state is invalid or expired");
}

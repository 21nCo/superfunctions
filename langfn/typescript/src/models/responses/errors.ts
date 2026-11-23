import { LangFnError, ProviderAuthError } from "../../core/errors.js";

type ErrorOptions = Omit<ConstructorParameters<typeof LangFnError>[1], "code">;

/**
 * The account's plan or credit quota is used up (OpenAI `insufficient_quota`, a ChatGPT plan's
 * `usage_limit_reached`, OpenRouter's 402). It is not a rate limit: LangFn's retry helper does
 * not retry it by default, and the model never retries it with another credential. `retryAfter`
 * (seconds) is set only when the provider states when the quota resets.
 */
export class QuotaExceededError extends LangFnError {
  readonly retryAfter?: number;

  constructor(message = "Provider quota exhausted", options: ErrorOptions & { retryAfter?: number } = {}) {
    const { retryAfter: stated, ...rest } = options;
    const retryAfter = stated !== undefined && Number.isFinite(stated) && stated >= 0 ? stated : undefined;
    const metadata = { ...(rest.metadata ?? {}), ...(retryAfter !== undefined ? { retry_after: retryAfter } : {}) };
    super(message, { ...rest, metadata, code: "PROVIDER_QUOTA_EXCEEDED" });
    this.retryAfter = retryAfter;
  }
}

/**
 * The credential was rejected and could not be renewed: a refreshed token was rejected again, or
 * the refresh callback reported that the sign-in session ended. The user must sign in again.
 * It is a {@link ProviderAuthError} with its own code, `PROVIDER_REAUTH_REQUIRED`.
 */
export class ReauthRequiredError extends ProviderAuthError {
  override readonly code: string = "PROVIDER_REAUTH_REQUIRED";

  constructor(message = "The credential was rejected and could not be renewed; sign in again", options: ErrorOptions = {}) {
    super(message, options);
  }
}

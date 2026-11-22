import { type ProviderAuthError, ValidationError } from "../../core/errors.js";
import { ReauthRequiredError } from "./errors.js";

/** What a {@link CredentialSource} is told when the provider rejects its token (HTTP 401). */
export interface CredentialAuthErrorContext {
  /** The access token the provider rejected. */
  token: string;
  /** The classified 401. */
  error: ProviderAuthError;
  /**
   * 1 for the request's first rejection; 2 when the token obtained after the first one was
   * rejected too. The model retries a request at most once, so attempt 2 never leads to a retry.
   */
  attempt: number;
}

/**
 * Where a model gets its bearer credential. `getAccessToken()` is asked before every request.
 * When the provider answers HTTP 401, `onAuthError()` decides: true retries the request once
 * with a fresh `getAccessToken()`; false surfaces the 401 unchanged; a thrown error (such as
 * {@link ReauthRequiredError}) surfaces instead. A retried request rejected again fails with
 * {@link ReauthRequiredError}. No other error (a quota, a rate limit) consults the source, and
 * the model never switches to another credential: the caller does that explicitly.
 */
export interface CredentialSource {
  getAccessToken(): string | Promise<string>;
  onAuthError(context: CredentialAuthErrorContext): boolean | Promise<boolean>;
}

/** fetch accepts only Latin-1 (ByteString) header values; CR, LF and NUL are never valid. */
export function isBearerToken(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "" && /^[^\r\n\0\u0100-\uffff]*$/.test(value);
}

/**
 * A fixed API key. A 401 is surfaced unchanged (a key does not renew itself), exactly as the
 * model's `apiKey` option does.
 */
export class StaticApiKeySource implements CredentialSource {
  readonly #apiKey: string;

  constructor(apiKey: string) {
    // Validated without echoing the key.
    if (!isBearerToken(apiKey)) throw new ValidationError("API key must be a non-blank single-line Latin-1 string");
    this.#apiKey = apiKey;
  }

  getAccessToken(): string {
    return this.#apiKey;
  }

  onAuthError(): boolean {
    return false;
  }
}

/** An OAuth access token and, when known, when it expires (epoch milliseconds). */
export interface OAuthToken {
  accessToken: string;
  expiresAt?: number;
}

export interface OAuthRefreshContext {
  /** `initial`: no token yet; `expired`: the token reached its refresh margin; `rejected`: the provider answered 401. */
  reason: "initial" | "expired" | "rejected";
  /** The token being replaced, when there is one. */
  previousToken?: string;
}

export interface OAuthTokenSourceOptions {
  /** The token the app already holds, if any. */
  token?: OAuthToken;
  /**
   * The app's refresh, such as an OAuth refresh-token grant. Return the new token, or null when
   * the sign-in session has ended (the refresh token was revoked or expired): the request then
   * fails with {@link ReauthRequiredError}. A thrown error (a network failure, say) surfaces
   * unchanged and the next request asks again. Concurrent requests share one refresh.
   */
  refresh: (context: OAuthRefreshContext) => OAuthToken | null | Promise<OAuthToken | null>;
  /** Refresh this many milliseconds before `expiresAt`; defaults to 60 seconds. */
  refreshMarginMs?: number;
  /** Clock in epoch milliseconds; defaults to `Date.now`. */
  now?: () => number;
}

/**
 * An OAuth access token (such as Sign in with ChatGPT's) renewed through a caller-supplied
 * refresh callback: before it expires, and once when the provider rejects it. A refreshed token
 * that is rejected again means the user must sign in again ({@link ReauthRequiredError}). The
 * sign-in flow and token storage belong to the app.
 */
export class OAuthTokenSource implements CredentialSource {
  readonly #refresh: OAuthTokenSourceOptions["refresh"];
  readonly #marginMs: number;
  readonly #now: () => number;
  #token?: OAuthToken;
  #pending?: Promise<string>;

  constructor(options: OAuthTokenSourceOptions) {
    if (!options || typeof options.refresh !== "function") throw new ValidationError("OAuthTokenSource requires a refresh function");
    const margin = options.refreshMarginMs ?? 60_000;
    if (!Number.isSafeInteger(margin) || margin < 0) throw new ValidationError("refreshMarginMs must be a nonnegative safe integer");
    if (options.now !== undefined && typeof options.now !== "function") throw new ValidationError("now must be a function");
    this.#refresh = options.refresh;
    this.#marginMs = margin;
    this.#now = options.now ?? Date.now;
    if (options.token !== undefined) this.#token = validToken(options.token);
  }

  async getAccessToken(): Promise<string> {
    if (this.#pending) return await this.#pending;
    const token = this.#token;
    if (token && !this.#expiring(token)) return token.accessToken;
    return await this.#renew(token ? { reason: "expired", previousToken: token.accessToken } : { reason: "initial" });
  }

  async onAuthError({ token, attempt }: CredentialAuthErrorContext): Promise<boolean> {
    if (attempt > 1) {
      // The renewed token was rejected too: drop it, so the next request asks the app again
      // instead of resending a token known to fail.
      if (this.#token?.accessToken === token) this.#token = undefined;
      return false;
    }
    if (this.#pending) {
      await this.#pending;
      return true;
    }
    // Another request already replaced the rejected token: retry with the current one.
    const current = this.#token;
    if (current && current.accessToken !== token && !this.#expiring(current)) return true;
    await this.#renew({ reason: "rejected", previousToken: token });
    return true;
  }

  #expiring(token: OAuthToken): boolean {
    return token.expiresAt !== undefined && this.#now() >= token.expiresAt - this.#marginMs;
  }

  /** One refresh at a time; every caller waiting meanwhile gets its outcome. */
  #renew(context: OAuthRefreshContext): Promise<string> {
    if (this.#pending) return this.#pending;
    const pending = (async () => {
      const next = await this.#refresh(context);
      if (next === null || next === undefined) {
        this.#token = undefined;
        throw new ReauthRequiredError("The sign-in session has ended; sign in again", { metadata: { reason: context.reason } });
      }
      this.#token = validToken(next);
      return this.#token.accessToken;
    })();
    this.#pending = pending;
    const settle = () => {
      if (this.#pending === pending) this.#pending = undefined;
    };
    pending.then(settle, settle);
    return pending;
  }
}

function validToken(token: unknown): OAuthToken {
  if (!token || typeof token !== "object") throw new ValidationError("OAuth token must be an object with an accessToken");
  const { accessToken, expiresAt } = token as Record<string, unknown>;
  // Validated without echoing the token.
  if (!isBearerToken(accessToken)) throw new ValidationError("OAuth accessToken must be a non-blank single-line Latin-1 string");
  if (expiresAt !== undefined && (typeof expiresAt !== "number" || !Number.isFinite(expiresAt))) {
    throw new ValidationError("OAuth expiresAt must be a finite number of epoch milliseconds");
  }
  return Object.freeze({ accessToken, ...(expiresAt !== undefined ? { expiresAt } : {}) });
}

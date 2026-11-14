import type { OAuthProviderUser } from '../types.js';

/** The grant type a device sends to the token endpoint (RFC 8628 3.4). */
export const OAUTH_DEVICE_CODE_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code';

/** User code lookups admitted per window; each lookup counts, found or not. */
export interface OAuthDeviceUserCodeRateLimit {
  /** Per signed-in user. Defaults to 10. */
  perUser?: number;
  /** Across all users. Defaults to 1000. */
  global?: number;
  /** Fixed window length. Defaults to 600 (ten minutes, one code's lifetime). */
  windowSeconds?: number;
}

/** Why the user code on the verification page was not accepted. */
export type OAuthDeviceVerificationError = 'invalid_user_code' | 'expired_user_code' | 'too_many_attempts';

/**
 * What the verification page renders. Without `userCode` it asks for the
 * code. With a `userCode` that names a pending request it shows
 * `authorization` for approval; otherwise `error` says why the code was not
 * accepted.
 */
export interface OAuthDeviceVerificationInput {
  request: Request;
  user: OAuthProviderUser;
  /** The code from the `user_code` query parameter, as `XXXX-XXXX` when well formed. */
  userCode?: string;
  /** The pending request the code names. */
  authorization?: {
    client: { clientId: string; name: string; trusted: boolean };
    resource: string;
    scopes: string[];
  };
  error?: OAuthDeviceVerificationError;
  /** With `too_many_attempts`: seconds until another code can be looked up. */
  retryAfterSeconds?: number;
  /**
   * The code entry form submits `user_code` here with GET, which renders the
   * page again for that code.
   */
  verificationUrl: string;
  /**
   * POST `{ user_code, decision: 'approve' | 'deny' }` as JSON here with the
   * session cookie and the `x-authfn-csrf` header. The response's
   * `data.decision` is `approved` or `denied`.
   */
  decisionUrl: string;
}

/**
 * The device authorization grant (RFC 8628) for CLIs and other devices
 * without a browser. Off unless configured. Configured clients may use it;
 * self-registered clients may not.
 */
export interface OAuthDeviceAuthorizationConfig {
  /**
   * Renders the page at `{basePath}/oauth/device` (the `verification_uri`)
   * where a signed-in user enters the user code and approves or denies the
   * request. A visitor without a session gets `loginRequired` first.
   */
  verification: (input: OAuthDeviceVerificationInput) => Response | Promise<Response>;
  /** Limits user code lookups, the guessing surface for user codes. */
  rateLimit?: OAuthDeviceUserCodeRateLimit;
}

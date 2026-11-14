import type { AuthFnBundledPluginConfig } from 'authfn/plugin-types';

/** Access tokens live one hour. */
export const OAUTH_ACCESS_TOKEN_TTL_SECONDS = 60 * 60;
/** Refresh tokens live 30 days; every use rotates them to a fresh 30-day token. */
export const OAUTH_REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;
/** Authorization codes are single-use and live one minute. */
export const OAUTH_AUTHORIZATION_CODE_TTL_SECONDS = 60;

export type OAuthClientAuthMethod = 'none' | 'client_secret_basic' | 'client_secret_post';

/** A client registered with the authorization server ahead of time. */
export interface OAuthProviderClient {
  /** The `client_id` the client sends. */
  clientId: string;
  /** Shown on the consent page. */
  name: string;
  /**
   * Redirect URIs compared exactly, except that the port of an
   * `http://127.0.0.1` or `http://[::1]` loopback URI may vary (RFC 8252 7.3).
   */
  redirectUris: string[];
  /**
   * A trusted (first-party) client still needs the user's consent once per
   * resource; later authorizations within consented scopes skip the page. An
   * untrusted client shows the consent page on every authorization.
   */
  trusted?: boolean;
  /**
   * Required for `client_secret_basic` and `client_secret_post`. Omit for a
   * public client (`none`), which authenticates only with its `client_id` and
   * PKCE.
   */
  clientSecret?: string;
  /** Defaults to `none` without a secret and `client_secret_basic` with one. */
  tokenEndpointAuthMethod?: OAuthClientAuthMethod;
}

/** A protected resource that tokens can be issued for (RFC 8707). */
export interface OAuthProviderResource {
  /**
   * The resource indicator: an absolute URI without a fragment, compared
   * exactly. Tokens issued for it carry it as their audience.
   */
  resource: string;
  /**
   * Scopes a client may request for this resource, each a registered
   * `<owner>:<action>`, `<owner>:*` or `*` from the AuthFn scope registry.
   * A request without `scope` asks for all of them.
   */
  scopes: string[];
  /**
   * Secret the resource server sends as `Authorization: Bearer <secret>` to
   * the introspection endpoint. Introspection reports only tokens issued for
   * this resource as active. Omit to disable introspection for the resource.
   */
  introspectionSecret?: string;
}

export interface OAuthProviderUser {
  id: string;
  primaryEmail?: string;
}

/** The validated authorization request the consent page posts back. */
export interface OAuthAuthorizationRequestParams {
  response_type: 'code';
  client_id: string;
  redirect_uri: string;
  scope: string;
  state?: string;
  code_challenge: string;
  code_challenge_method: 'S256';
  resource: string;
}

export interface OAuthLoginRequiredInput {
  request: Request;
  /** The authorization URL to return to after sign-in. */
  returnTo: string;
}

export interface OAuthConsentInput {
  request: Request;
  user: OAuthProviderUser;
  client: { clientId: string; name: string; trusted: boolean };
  resource: string;
  scopes: string[];
  /**
   * POST these parameters plus `decision: 'approve' | 'deny'` as JSON to
   * `decisionUrl` with the session cookie and the `x-authfn-csrf` header. The
   * response's `data.redirectTo` is where the browser goes next.
   */
  params: OAuthAuthorizationRequestParams;
  decisionUrl: string;
}

export interface OAuthProviderPluginConfig extends AuthFnBundledPluginConfig {
}

export interface OAuthProviderPluginRuntimeConfig {
  clients: OAuthProviderClient[];
  resources: OAuthProviderResource[];
  /** Renders the sign-in step when the authorization request has no session. */
  loginRequired: (input: OAuthLoginRequiredInput) => Response | Promise<Response>;
  /** Renders the consent page. */
  consent: (input: OAuthConsentInput) => Response | Promise<Response>;
  /** Clock for token, code and consent timestamps; primarily useful for tests. */
  now?: () => Date;
}

export interface OAuthGrantRecord {
  id: string;
  clientId: string;
  userId: string;
  resource: string;
  scopes: string[];
  revokedAt?: Date | null;
  revokedReason?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface OAuthAuthorizationCodeRecord {
  id: string;
  codeHash: string;
  grantId: string;
  clientId: string;
  userId: string;
  resource: string;
  scopes: string[];
  redirectUri: string;
  codeChallenge: string;
  expiresAt: Date;
  consumedAt?: Date | null;
  createdAt: Date;
}

export type OAuthTokenKind = 'access' | 'refresh';

export interface OAuthTokenRecord {
  id: string;
  kind: OAuthTokenKind;
  tokenHash: string;
  grantId: string;
  clientId: string;
  userId: string;
  resource: string;
  scopes: string[];
  expiresAt: Date;
  /** A refresh token is rotated (spent) once it has been exchanged. */
  rotatedAt?: Date | null;
  revokedAt?: Date | null;
  /** The code or refresh token exchanged for this token. */
  sourceId: string;
  /** The claim on `sourceId` that commits this token; valid only once stored there. */
  issuingClaimId: string;
  createdAt: Date;
}

export interface OAuthConsentRecord {
  id: string;
  userId: string;
  clientId: string;
  resource: string;
  scopes: string[];
  /** The disconnect generation of the user, client and resource at this approval. */
  generation: string;
  createdAt: Date;
}

/**
 * An active access token as `verifyOAuthAccessToken` reports it. The
 * introspection endpoint answers with RFC 7662 fields instead.
 */
export interface OAuthAccessTokenInfo {
  tokenId: string;
  grantId: string;
  clientId: string;
  /** The user the token acts for. */
  userId: string;
  /** The resource (audience) the token is bound to. */
  resource: string;
  /** Granted scopes; pass the object to `requireScopes` from `authfn`. */
  scopes: string[];
  issuedAt: Date;
  expiresAt: Date;
}

import type { OAuthClientSecretResolver, OAuthFetchLike, OAuthTokenHttpClient } from '@superfunctions/oauth-http';
import type {
  AuthFnEnvironment,
  AuthFnSocialProfile,
  AuthFnSocialProviderId
} from 'authfn';
import type { AuthFnBundledPluginConfig } from 'authfn/plugin-types';

export type { AuthFnSocialProfile, AuthFnSocialProviderId } from 'authfn';

export type AuthFnSocialHandoffMode = 'none' | 'session-token';

export interface AuthFnSocialProfileResolverInput {
  providerId: AuthFnSocialProviderId;
  tokenSet: {
    accessToken: string;
    refreshToken?: string;
    expiresAt?: string;
    scope?: string;
    tokenType?: string;
    idToken?: string;
  };
  request?: Request;
  environment?: AuthFnEnvironment;
  fetcher?: OAuthFetchLike;
}

export type AuthFnSocialProfileResolver = (
  input: AuthFnSocialProfileResolverInput
) => Promise<AuthFnSocialProfile> | AuthFnSocialProfile;

export interface AuthFnSocialProviderRuntimeConfig {
  clientId: string;
  clientSecret?: string;
  clientSecretResolver?: OAuthClientSecretResolver;
  allowlistedRedirectUris?: string[];
  allowlistedReturnTo?: string[];
  scopes?: string[];
  nativeClientIds?: string[];
}

export interface AuthFnSocialProviderConfig extends Partial<AuthFnSocialProviderRuntimeConfig> {
  linkByVerifiedEmail?: boolean;
  profileResolver?: AuthFnSocialProfileResolver;
}

export interface SocialOAuthPluginConfig extends AuthFnBundledPluginConfig {
  defaultHandoffMode?: AuthFnSocialHandoffMode;
  /**
   * Binds cookie-session redirect sign-ins to the browser that started them:
   * `/social/start` sets a short-lived HttpOnly binding cookie and the callback
   * refuses a state whose binding cookie is missing or different. Stops a
   * callback URL completed by someone else from signing this browser in.
   */
  bindBrowserState?: boolean;
  /**
   * Allows `handoffMode: "session-token"` with an http(s) `returnTo`, which puts
   * a session token in a web URL fragment. Defaults to true for compatibility;
   * set false so only native (non-http) return targets can receive a handoff.
   */
  allowWebSessionTokenHandoff?: boolean;
  /**
   * Requires native session-token handoffs to send `handoffChallenge` (the
   * base64url SHA-256 of a client-held verifier). The callback then returns a
   * one-time code instead of a session token, and only the holder of the
   * verifier can exchange it at `/social/handoff/exchange`.
   */
  requireHandoffChallenge?: boolean;
  /** Lifetime of a one-time social handoff code, in seconds (default 60). */
  handoffCodeTtlSeconds?: number;
}

export interface SocialOAuthPluginRuntimeConfig {
  providers: Partial<Record<AuthFnSocialProviderId, AuthFnSocialProviderConfig>>;
  fetcher?: OAuthFetchLike;
  tokenHttpClient?: OAuthTokenHttpClient;
  diagnostics?: false | SocialOAuthDiagnosticsConfig;
  now?: () => Date;
}

export interface OAuthTokenExchangeDiagnostic {
  provider: AuthFnSocialProviderId;
  ok: boolean;
  status: number;
  request: Record<string, unknown>;
  response: Record<string, unknown>;
}

export interface OAuthTokenExchangeDiagnosticsConfig {
  includeSuccessful?: boolean;
  sink?: (diagnostic: OAuthTokenExchangeDiagnostic) => Promise<void> | void;
}

export interface SocialOAuthDiagnosticsConfig {
  tokenExchange?: false | OAuthTokenExchangeDiagnosticsConfig;
}

export type AuthFnSocialOAuthEnvironment = AuthFnEnvironment & {
  oauth?: Partial<Record<AuthFnSocialProviderId, AuthFnSocialProviderRuntimeConfig>>;
};

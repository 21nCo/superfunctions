import type { OAuthStateStore } from "@superfunctions/oauth-storage";
import type {
  AuthorizationRequest,
  AuthorizationResult,
  OAuthCallbackInput,
  OAuthProviderDescriptor,
  OAuthService,
  OAuthTokenSet
} from "./index.js";
import { generateNonce, generatePkcePair, generateStateId } from "./pkce.js";
import { OAuthCoreError, assertCallbackStateMatches, assertRedirectUriAllowed, consumeStateOrThrow } from "./state.js";

export interface OAuthProviderRuntimeConfig {
  clientId: string;
  allowlistedRedirectUris?: string[];
}

export interface OAuthCodeExchangeInput {
  provider: OAuthProviderDescriptor;
  code: string;
  redirectUri: string;
  codeVerifier?: string;
  scopes?: string[];
}

export interface OAuthRefreshInput {
  provider: OAuthProviderDescriptor;
  refreshToken: string;
  redirectUri: string;
  scopes?: string[];
}

export interface OAuthRevokeInput {
  provider: OAuthProviderDescriptor;
  token: string;
  tokenTypeHint?: "access_token" | "refresh_token";
}

export interface OAuthServiceDependencies {
  providers: Record<string, OAuthProviderDescriptor>;
  providerRuntimeConfig: Record<string, OAuthProviderRuntimeConfig>;
  stateStore: OAuthStateStore;
  exchangeCodeForToken: (input: OAuthCodeExchangeInput) => Promise<OAuthTokenSet>;
  refreshToken?: (input: OAuthRefreshInput) => Promise<OAuthTokenSet>;
  revokeToken?: (input: OAuthRevokeInput) => Promise<void>;
  stateTtlMs?: number;
  now?: () => Date;
}

export class DefaultOAuthService implements OAuthService {
  private readonly providers: Record<string, OAuthProviderDescriptor>;
  private readonly providerRuntimeConfig: Record<string, OAuthProviderRuntimeConfig>;
  private readonly stateStore: OAuthStateStore;
  private readonly exchangeCodeForToken: (input: OAuthCodeExchangeInput) => Promise<OAuthTokenSet>;
  private readonly refreshTokenHandler?: (input: OAuthRefreshInput) => Promise<OAuthTokenSet>;
  private readonly revokeTokenHandler?: (input: OAuthRevokeInput) => Promise<void>;
  private readonly stateTtlMs: number;
  private readonly now: () => Date;

  constructor(dependencies: OAuthServiceDependencies) {
    this.providers = dependencies.providers;
    this.providerRuntimeConfig = dependencies.providerRuntimeConfig;
    this.stateStore = dependencies.stateStore;
    this.exchangeCodeForToken = dependencies.exchangeCodeForToken;
    this.refreshTokenHandler = dependencies.refreshToken;
    this.revokeTokenHandler = dependencies.revokeToken;
    this.stateTtlMs = dependencies.stateTtlMs ?? 10 * 60 * 1000;
    this.now = dependencies.now ?? (() => new Date());
  }

  async createAuthorizationRequest(input: AuthorizationRequest): Promise<AuthorizationResult> {
    const provider = this.getProvider(input.providerId);
    const runtime = this.getProviderRuntimeConfig(input.providerId);
    assertRedirectUriAllowed(input.redirectUri, runtime.allowlistedRedirectUris ?? []);

    const issuedAt = this.now();
    const createdAt = issuedAt.toISOString();
    const expiresAt = new Date(issuedAt.getTime() + this.stateTtlMs).toISOString();
    const stateId = generateStateId();
    const nonce = generateNonce();
    const scopes = input.scopes && input.scopes.length > 0 ? input.scopes : provider.defaultScopes;
    const pkce = provider.supportsPkce ? generatePkcePair() : undefined;

    await this.stateStore.put({
      stateId,
      tenantId: input.tenantId,
      userId: input.userId,
      providerId: provider.id,
      redirectUri: input.redirectUri,
      requestedScopes: [...scopes],
      codeVerifier: pkce?.codeVerifier,
      nonce,
      createdAt,
      expiresAt
    });

    const authorizationUrl = new URL(provider.authorizationUrl);
    authorizationUrl.searchParams.set("response_type", "code");
    authorizationUrl.searchParams.set("client_id", runtime.clientId);
    authorizationUrl.searchParams.set("redirect_uri", input.redirectUri);
    authorizationUrl.searchParams.set("state", stateId);
    authorizationUrl.searchParams.set("nonce", nonce);

    if (scopes.length > 0) {
      authorizationUrl.searchParams.set("scope", scopes.join(provider.scopeSeparator ?? " "));
    }

    if (pkce) {
      authorizationUrl.searchParams.set("code_challenge", pkce.codeChallenge);
      authorizationUrl.searchParams.set("code_challenge_method", pkce.codeChallengeMethod);
    }

    if (input.prompt) {
      authorizationUrl.searchParams.set("prompt", input.prompt);
    }

    if (input.loginHint) {
      authorizationUrl.searchParams.set("login_hint", input.loginHint);
    }

    for (const [key, value] of Object.entries(provider.extraAuthParams ?? {})) {
      if (!authorizationUrl.searchParams.has(key)) {
        authorizationUrl.searchParams.set(key, value);
      }
    }

    return {
      authorizationUrl: authorizationUrl.toString(),
      stateId,
      expiresAt
    };
  }

  async handleCallback(input: OAuthCallbackInput): Promise<OAuthTokenSet> {
    const provider = this.getProvider(input.providerId);
    const consumedAt = this.now().toISOString();
    const consumedState = await consumeStateOrThrow(this.stateStore, input.state, consumedAt);
    assertCallbackStateMatches(
      {
        providerId: input.providerId,
        redirectUri: input.redirectUri
      },
      consumedState
    );

    return this.exchangeCodeForToken({
      provider,
      code: input.code,
      redirectUri: input.redirectUri,
      codeVerifier: consumedState.codeVerifier,
      scopes: consumedState.requestedScopes
    });
  }

  async refresh(input: {
    providerId: string;
    refreshToken: string;
    redirectUri: string;
    scopes?: string[];
  }): Promise<OAuthTokenSet> {
    const provider = this.getProvider(input.providerId);
    if (!this.refreshTokenHandler) {
      throw new OAuthCoreError("OAUTH_TOKEN_REFRESH_FAILED", "OAuth refresh handler is not configured", { status: 500 });
    }

    return this.refreshTokenHandler({
      provider,
      refreshToken: input.refreshToken,
      redirectUri: input.redirectUri,
      scopes: input.scopes
    });
  }

  async revoke(input: {
    providerId: string;
    token: string;
    tokenTypeHint?: "access_token" | "refresh_token";
  }): Promise<void> {
    const provider = this.getProvider(input.providerId);
    if (!provider.revocationUrl || !this.revokeTokenHandler) {
      return;
    }

    await this.revokeTokenHandler({
      provider,
      token: input.token,
      tokenTypeHint: input.tokenTypeHint
    });
  }

  private getProvider(providerId: string): OAuthProviderDescriptor {
    const provider = this.providers[providerId];
    if (!provider) {
      throw new OAuthCoreError("VALIDATION_ERROR", `Unknown OAuth provider: ${providerId}`);
    }

    return provider;
  }

  private getProviderRuntimeConfig(providerId: string): OAuthProviderRuntimeConfig {
    const runtime = this.providerRuntimeConfig[providerId];
    if (!runtime) {
      throw new OAuthCoreError("VALIDATION_ERROR", `Missing runtime OAuth config for provider: ${providerId}`);
    }

    return runtime;
  }
}

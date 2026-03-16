import {
  DefaultOAuthService,
  type OAuthProviderDescriptor,
  type OAuthTokenSet,
} from '@superfunctions/oauth-core';
import {
  DefaultOAuthTokenHttpClient,
  type OAuthTokenEndpointResponse,
  type OAuthTokenHttpClient,
} from '@superfunctions/oauth-http';
import {
  MemoryOAuthStateStore,
  type OAuthStateStore,
} from '@superfunctions/oauth-storage';
import type { OAuth2Config, OAuth2RuntimeConfig, TokenResponse } from '../types/provider.js';
import type { OAuthState } from './types.js';

const LEGACY_PROVIDER_ID = 'legacy-oauth-provider';
const LEGACY_PATH_WARNING_CODE = 'DEPRECATED_PATH' as const;
const LEGACY_PATH_WARNING_MESSAGE =
  '[DEPRECATED_PATH] plugfn/auth/oauth-flow is deprecated and will be removed in plugfn@0.2.0. ' +
  'Use @superfunctions/oauth-flow (+ @superfunctions/oauth-http/@superfunctions/oauth-storage) instead.';
let warnedLegacyPath = false;

function warnLegacyPath(): void {
  if (warnedLegacyPath) {
    return;
  }
  warnedLegacyPath = true;
  process.emitWarning(LEGACY_PATH_WARNING_MESSAGE, LEGACY_PATH_WARNING_CODE);
}

warnLegacyPath();

export class OAuthFlowHandler {
  private readonly stateStore: OAuthStateStore;
  private readonly tokenClient: OAuthTokenHttpClient;

  constructor(
    stateStore: OAuthStateStore = new MemoryOAuthStateStore(),
    private readonly stateTimeout = 600000,
    tokenClient: OAuthTokenHttpClient = new DefaultOAuthTokenHttpClient()
  ) {
    this.stateStore = stateStore;
    this.tokenClient = tokenClient;
  }

  async getAuthorizationUrl(
    config: OAuth2Config,
    runtimeConfig: OAuth2RuntimeConfig
  ): Promise<{ url: string; state: string }> {
    const provider = toOAuthProviderDescriptor(config);
    const service = this.createOAuthService(provider, runtimeConfig);

    const result = await service.createAuthorizationRequest({
      providerId: LEGACY_PROVIDER_ID,
      tenantId: '',
      userId: '',
      redirectUri: runtimeConfig.redirectUri,
      scopes: runtimeConfig.scopes,
    });

    return {
      url: result.authorizationUrl,
      state: result.stateId,
    };
  }

  async exchangeCodeForToken(
    config: OAuth2Config,
    runtimeConfig: OAuth2RuntimeConfig,
    code: string
  ): Promise<TokenResponse> {
    const provider = toOAuthProviderDescriptor(config);
    const response = await this.tokenClient.exchangeToken({
      provider,
      grantType: 'authorization_code',
      clientId: runtimeConfig.clientId,
      clientSecret: runtimeConfig.clientSecret,
      redirectUri: runtimeConfig.redirectUri,
      code,
      scopes: runtimeConfig.scopes,
    });

    return toLegacyTokenResponse(response);
  }

  async refreshAccessToken(
    config: OAuth2Config,
    runtimeConfig: OAuth2RuntimeConfig,
    refreshToken: string
  ): Promise<TokenResponse> {
    const provider = toOAuthProviderDescriptor(config);
    const response = await this.tokenClient.exchangeToken({
      provider,
      grantType: 'refresh_token',
      clientId: runtimeConfig.clientId,
      clientSecret: runtimeConfig.clientSecret,
      redirectUri: runtimeConfig.redirectUri,
      refreshToken,
      scopes: runtimeConfig.scopes,
    });

    return toLegacyTokenResponse(response);
  }

  async verifyState(state: string): Promise<OAuthState | null> {
    const consumed = await this.stateStore.consume(state, new Date().toISOString());
    if (!consumed) {
      return null;
    }

    return {
      userId: consumed.userId,
      provider: consumed.providerId,
      redirectUri: consumed.redirectUri,
      scopes: [...consumed.requestedScopes],
      timestamp: Date.parse(consumed.createdAt),
    };
  }

  private createOAuthService(
    provider: OAuthProviderDescriptor,
    runtimeConfig: OAuth2RuntimeConfig
  ): DefaultOAuthService {
    return new DefaultOAuthService({
      providers: {
        [LEGACY_PROVIDER_ID]: provider,
      },
      providerRuntimeConfig: {
        [LEGACY_PROVIDER_ID]: {
          clientId: runtimeConfig.clientId,
          allowlistedRedirectUris: [runtimeConfig.redirectUri],
        },
      },
      stateStore: this.stateStore,
      stateTtlMs: this.stateTimeout,
      exchangeCodeForToken: async ({ provider: currentProvider, code, redirectUri, codeVerifier, scopes }) => {
        const response = await this.tokenClient.exchangeToken({
          provider: currentProvider,
          grantType: 'authorization_code',
          clientId: runtimeConfig.clientId,
          clientSecret: runtimeConfig.clientSecret,
          redirectUri,
          code,
          codeVerifier,
          scopes,
        });

        return toOAuthTokenSet(response);
      },
      refreshToken: async ({ provider: currentProvider, refreshToken, redirectUri, scopes }) => {
        const response = await this.tokenClient.exchangeToken({
          provider: currentProvider,
          grantType: 'refresh_token',
          clientId: runtimeConfig.clientId,
          clientSecret: runtimeConfig.clientSecret,
          redirectUri,
          refreshToken,
          scopes,
        });

        return toOAuthTokenSet(response);
      },
    });
  }
}

export function getLegacyOAuthFlowDeprecationNotice(): {
  code: 'DEPRECATED_PATH';
  message: string;
  replacement: '@superfunctions/oauth-flow';
  removalTarget: 'plugfn@0.2.0';
} {
  return {
    code: LEGACY_PATH_WARNING_CODE,
    message: LEGACY_PATH_WARNING_MESSAGE,
    replacement: '@superfunctions/oauth-flow',
    removalTarget: 'plugfn@0.2.0',
  };
}

function toOAuthProviderDescriptor(config: OAuth2Config): OAuthProviderDescriptor {
  const rawConfig = config as unknown as Record<string, unknown>;
  const rawTokenAuthMethod = rawConfig.tokenAuthMethod;
  const tokenAuthMethod =
    rawTokenAuthMethod === 'client_secret_basic' || rawTokenAuthMethod === 'client_secret_post'
      ? rawTokenAuthMethod
      : 'client_secret_post';

  return {
    id: LEGACY_PROVIDER_ID,
    authorizationUrl: config.authorizationUrl,
    tokenUrl: config.tokenUrl,
    defaultScopes: [...config.scopes],
    supportsPkce: true,
    supportsRefreshToken: true,
    scopeSeparator: config.scopeSeparator === ',' ? ',' : ' ',
    tokenAuthMethod,
  };
}

function toLegacyTokenResponse(response: OAuthTokenEndpointResponse): TokenResponse {
  return {
    access_token: response.accessToken,
    refresh_token: response.refreshToken,
    expires_in: response.expiresIn,
    token_type: response.tokenType,
    scope: response.scope,
  };
}

function toOAuthTokenSet(response: OAuthTokenEndpointResponse): OAuthTokenSet {
  const now = Date.now();
  return {
    accessToken: response.accessToken,
    refreshToken: response.refreshToken,
    expiresAt:
      response.expiresIn !== undefined
        ? new Date(now + response.expiresIn * 1000).toISOString()
        : undefined,
    scope: response.scope,
    tokenType: response.tokenType,
    idToken: response.idToken,
  };
}

import { createHash, randomBytes } from 'node:crypto';
import type { OAuthTokenSet } from '@superfunctions/oauth-core';
import {
  DefaultOAuthTokenHttpClient,
  type OAuthTokenHttpClient,
} from '@superfunctions/oauth-http';
import {
  createOAuthFlowService,
  type OAuthFlowError,
} from '@superfunctions/oauth-flow';
import {
  AesGcmTokenCipher,
  EncryptedTokenVault,
  MemoryOAuthStateStore,
  MemoryTokenVault,
  type OAuthStateStore,
  type TokenKeyResolver,
  type TokenVault,
} from '@superfunctions/oauth-storage';
import {
  createSocialProviderMap,
  resolveSocialProviderId,
} from './provider-map.js';
import {
  InMemorySocialIdentityStore,
  SocialOAuthError,
  type SocialAuthCallbackInput,
  type SocialAuthCallbackResult,
  type SocialAuthDisconnectInput,
  type SocialAuthLoginInput,
  type SocialAuthLoginResult,
  type SocialAuthService,
  type SocialIdentityRecord,
  type SocialIdentityStore,
  type SocialOAuthCallbackInput,
  type SocialOAuthCallbackResult,
  type SocialOAuthDisconnectInput,
  type SocialOAuthDisconnectResult,
  type SocialOAuthLoginInput,
  type SocialOAuthLoginResult,
  type SocialOAuthProviderRuntimeConfig,
  type SocialProviderId,
  type SocialRevocationFailureRecord,
} from './types.js';

export interface CreateSocialOAuthServiceConfig {
  providers: Partial<Record<SocialProviderId, SocialOAuthProviderRuntimeConfig>>;
  providerIds?: SocialProviderId[];
  stateStore?: OAuthStateStore;
  tokenVault?: TokenVault;
  identityStore?: SocialIdentityStore;
  tokenHttpClient?: OAuthTokenHttpClient;
  encryptionKey?: string;
  keyRef?: string;
  stateTtlMs?: number;
  now?: () => Date;
}

const DEFAULT_KEY_REF = 'authfn-social-key-v1';

export function createSocialOAuthService(config: CreateSocialOAuthServiceConfig): SocialAuthService {
  const now = config.now ?? (() => new Date());
  const stateStore = config.stateStore ?? new MemoryOAuthStateStore();
  const tokenVaultStore = config.tokenVault ?? new MemoryTokenVault();
  const identityStore = config.identityStore ?? new InMemorySocialIdentityStore();
  const baseTokenHttpClient = config.tokenHttpClient ?? new DefaultOAuthTokenHttpClient();
  const providersMap = createSocialProviderMap(config.providerIds);
  const runtimeConfigMap = buildRuntimeConfigMap(config.providers);
  const keyRef = config.keyRef ?? DEFAULT_KEY_REF;
  const tokenVault = new EncryptedTokenVault(
    tokenVaultStore,
    new AesGcmTokenCipher(createDefaultTokenKeyResolver(config.encryptionKey)),
    () => now().toISOString()
  );
  const revocationFailures = new Map<string, SocialRevocationFailureRecord[]>();
  const pendingScopesByConnection = new Map<string, string[]>();
  const revocationContextByToken = new Map<
    string,
    { tenantId: string; userId: string; providerId: SocialProviderId; connectionId: string }
  >();

  const recordRevocationFailure = (
    context: { tenantId: string; userId: string; providerId: SocialProviderId; connectionId: string },
    error: unknown
  ): void => {
    const key = scopeKey(context.tenantId, context.userId);
    const existing = revocationFailures.get(key) ?? [];
    const errorDetails = readErrorDetails(error);
    revocationFailures.set(key, [
      ...existing,
      {
        tenantId: context.tenantId,
        userId: context.userId,
        providerId: context.providerId,
        connectionId: context.connectionId,
        code: errorDetails.code,
        message: errorDetails.message,
        recordedAt: now().toISOString(),
      },
    ]);
  };

  const tokenHttpClient: OAuthTokenHttpClient = {
    exchangeToken: async (input) => baseTokenHttpClient.exchangeToken(input),
    revokeToken: async (input) => {
      try {
        await baseTokenHttpClient.revokeToken(input);
      } catch (error) {
        const context = revocationContextByToken.get(input.token);
        if (context) {
          recordRevocationFailure(context, error);
        }
        throw error;
      }
    },
  };

  const oauthFlowService = createOAuthFlowService({
    providers: providersMap.providers,
    providerRuntimeConfig: runtimeConfigMap,
    stateStore,
    tokenVault,
    tokenHttpClient,
    keyRef,
    now,
    identityHooks: {
      onConnected: async (result) => {
        const providerId = resolveSocialProviderId(result.providerId);
        const claims = parseIdTokenClaims(result.tokenSet.idToken);
        const scoped = pendingScopesByConnection.get(result.connectionId);
        pendingScopesByConnection.delete(result.connectionId);

        const identity: SocialIdentityRecord = {
          id: buildIdentityId(providerId, result.subject.tenantId, result.subject.userId),
          tenantId: result.subject.tenantId,
          userId: result.subject.userId,
          providerId,
          providerUserId: claims.sub,
          email: claims.email,
          displayName: claims.name,
          connectionId: result.connectionId,
          scopes: scoped ?? parseScopes(result.tokenSet.scope),
          createdAt: now().toISOString(),
          updatedAt: now().toISOString(),
        };

        await identityStore.upsert(identity);
      },
      onDisconnected: async (input) => {
        await identityStore.deleteByConnection(input.connectionId);
      },
    },
  });

  const createLoginUrl = async (input: SocialOAuthLoginInput): Promise<SocialOAuthLoginResult> => {
    assertLoginInput(input);
    const providerId = resolveSocialProviderId(input.providerId);
    const provider = providersMap.providers[providerId];
    const configuredScopes =
      config.providers[providerId]?.scopes && config.providers[providerId]?.scopes?.length
        ? [...(config.providers[providerId]?.scopes ?? [])]
        : [...provider.defaultScopes];
    const effectiveScopes = input.scopes && input.scopes.length > 0 ? [...input.scopes] : configuredScopes;
    const connectionId = buildConnectionId(providerId, input.tenantId, input.userId);

    const result = await oauthFlowService.start({
      providerId,
      tenantId: input.tenantId,
      userId: input.userId,
      connectionId,
      redirectUri: input.redirectUri,
      scopes: effectiveScopes,
      prompt: input.prompt,
      loginHint: input.loginHint,
    });

    pendingScopesByConnection.set(connectionId, [...effectiveScopes]);

    return {
      authorizationUrl: result.authorizationUrl,
      stateId: result.stateId,
      expiresAt: result.expiresAt,
    };
  };

  const handleCallback = async (input: SocialOAuthCallbackInput): Promise<SocialOAuthCallbackResult> => {
    assertCallbackInput(input);
    const providerId = resolveSocialProviderId(input.providerId);

    let callback;
    try {
      callback = await oauthFlowService.handleCallback({
        providerId,
        code: input.code,
        state: input.state,
        redirectUri: input.redirectUri,
      });
    } catch (error) {
      throw mapToSocialOAuthError(error);
    }

    const identity = await identityStore.get(callback.subject.tenantId, callback.subject.userId, providerId);
    if (!identity) {
      throw new SocialOAuthError('INTERNAL_ERROR', 'social identity not found after oauth callback');
    }

    return {
      identity,
      tokenSet: toSocialTokenSet(callback.tokenSet),
    };
  };

  const listLinkedIdentities = async (input: {
    tenantId: string;
    userId: string;
  }): Promise<SocialIdentityRecord[]> => {
    assertScope(input.tenantId, input.userId);
    return identityStore.list(input.tenantId, input.userId);
  };

  const disconnectByIdentity = async (
    identity: SocialIdentityRecord
  ): Promise<SocialOAuthDisconnectResult> => {
    const providerId = resolveSocialProviderId(identity.providerId);
    const storedToken = await tokenVault.getTokenSetByConnection(identity.connectionId);
    const revokeToken = storedToken?.tokenSet.refreshToken ?? storedToken?.tokenSet.accessToken;
    if (revokeToken) {
      revocationContextByToken.set(revokeToken, {
        tenantId: identity.tenantId,
        userId: identity.userId,
        providerId,
        connectionId: identity.connectionId,
      });
    }

    try {
      const disconnected = await oauthFlowService.disconnect({
        connectionId: identity.connectionId,
        providerId,
        revokeRemote: true,
        tokenTypeHint: 'access_token',
      });

      return {
        disconnected: disconnected.disconnected,
        remoteRevokeAttempted: disconnected.remoteRevokeAttempted,
        localTokenDeleted: disconnected.localTokenDeleted,
        identityDeleted: disconnected.connectionDeleted,
        revocationFailureRecorded: hasRevocationFailure(
          revocationFailures,
          identity.tenantId,
          identity.userId,
          identity.connectionId
        ),
      };
    } catch (error) {
      throw mapToSocialOAuthError(error);
    } finally {
      if (revokeToken) {
        revocationContextByToken.delete(revokeToken);
      }
    }
  };

  const disconnect = async (input: SocialOAuthDisconnectInput): Promise<SocialOAuthDisconnectResult> => {
    assertScope(input.tenantId, input.userId);
    const providerId = resolveSocialProviderId(input.providerId);
    const identity = await identityStore.get(input.tenantId, input.userId, providerId);
    if (!identity) {
      return {
        disconnected: false,
        remoteRevokeAttempted: false,
        localTokenDeleted: false,
        identityDeleted: false,
        revocationFailureRecorded: false,
      };
    }

    return disconnectByIdentity(identity);
  };

  const getRevocationFailures = async (input: {
    tenantId: string;
    userId: string;
  }): Promise<SocialRevocationFailureRecord[]> => {
    assertScope(input.tenantId, input.userId);
    return [...(revocationFailures.get(scopeKey(input.tenantId, input.userId)) ?? [])];
  };

  return {
    async getLoginUrl(input: SocialAuthLoginInput): Promise<SocialAuthLoginResult> {
      assertTenant(input.tenantId);
      assertProvider(input.provider);
      assertRedirectUri(input.redirectUri);

      const result = await createLoginUrl({
        providerId: resolveSocialProviderId(input.provider),
        tenantId: input.tenantId,
        userId: resolveUserIdHint(input.userIdHint),
        redirectUri: input.redirectUri,
      });

      return {
        url: result.authorizationUrl,
        stateId: result.stateId,
      };
    },

    async handleLoginCallback(input: SocialAuthCallbackInput): Promise<SocialAuthCallbackResult> {
      assertProvider(input.provider);
      const result = await handleCallback({
        providerId: resolveSocialProviderId(input.provider),
        code: input.code,
        state: input.state,
        redirectUri: input.redirectUri,
      });

      return {
        identityId: result.identity.id,
        email: result.identity.email,
        profile: buildSocialProfile(result.identity),
      };
    },

    async disconnectIdentity(input: SocialAuthDisconnectInput): Promise<void> {
      assertTenant(input.tenantId);
      assertIdentityId(input.identityId);
      const identity = await identityStore.getByIdentityId(input.tenantId, input.identityId);
      if (!identity) {
        return;
      }

      await disconnectByIdentity(identity);
    },

    createLoginUrl,
    handleCallback,
    listLinkedIdentities,
    disconnect,
    getRevocationFailures,
  };
}

function buildRuntimeConfigMap(
  providers: Partial<Record<SocialProviderId, SocialOAuthProviderRuntimeConfig>>
): Record<SocialProviderId, { clientId: string; clientSecret: string; allowlistedRedirectUris: string[] }> {
  const entries = Object.entries(providers) as Array<[SocialProviderId, SocialOAuthProviderRuntimeConfig]>;
  if (entries.length === 0) {
    throw new SocialOAuthError('VALIDATION_ERROR', 'at least one social provider config is required');
  }

  const map: Partial<
    Record<SocialProviderId, { clientId: string; clientSecret: string; allowlistedRedirectUris: string[] }>
  > = {};

  for (const [providerId, provider] of entries) {
    if (!provider.clientId || !provider.clientSecret || !provider.redirectUris?.length) {
      throw new SocialOAuthError(
        'VALIDATION_ERROR',
        `social provider config invalid for ${providerId}`
      );
    }
    map[providerId] = {
      clientId: provider.clientId,
      clientSecret: provider.clientSecret,
      allowlistedRedirectUris: [...provider.redirectUris],
    };
  }

  return map as Record<
    SocialProviderId,
    { clientId: string; clientSecret: string; allowlistedRedirectUris: string[] }
  >;
}

function assertScope(tenantId: string, userId: string): void {
  assertTenant(tenantId);
  if (!userId || userId.trim().length === 0) {
    throw new SocialOAuthError('VALIDATION_ERROR', 'userId is required');
  }
}

function assertTenant(tenantId: string): void {
  if (!tenantId || tenantId.trim().length === 0) {
    throw new SocialOAuthError('VALIDATION_ERROR', 'tenantId is required');
  }
}

function assertProvider(provider: string): void {
  if (!provider || provider.trim().length === 0) {
    throw new SocialOAuthError('VALIDATION_ERROR', 'provider is required');
  }
}

function assertRedirectUri(redirectUri: string): void {
  if (!redirectUri || redirectUri.trim().length === 0) {
    throw new SocialOAuthError('VALIDATION_ERROR', 'redirectUri is required');
  }
}

function assertIdentityId(identityId: string): void {
  if (!identityId || identityId.trim().length === 0) {
    throw new SocialOAuthError('VALIDATION_ERROR', 'identityId is required');
  }
}

function assertLoginInput(input: SocialOAuthLoginInput): void {
  assertScope(input.tenantId, input.userId);
  assertRedirectUri(input.redirectUri);
}

function assertCallbackInput(input: SocialOAuthCallbackInput): void {
  if (!input.code || input.code.trim().length === 0) {
    throw new SocialOAuthError('VALIDATION_ERROR', 'code is required');
  }
  if (!input.state || input.state.trim().length === 0) {
    throw new SocialOAuthError('VALIDATION_ERROR', 'state is required');
  }
  assertRedirectUri(input.redirectUri);
}

function toSocialTokenSet(tokenSet: OAuthTokenSet) {
  return {
    accessToken: tokenSet.accessToken,
    refreshToken: tokenSet.refreshToken,
    expiresAt: tokenSet.expiresAt,
    scope: tokenSet.scope,
    tokenType: tokenSet.tokenType,
    idToken: tokenSet.idToken,
  };
}

function parseIdTokenClaims(idToken: string | undefined): {
  sub?: string;
  email?: string;
  name?: string;
} {
  if (!idToken) {
    return {};
  }

  const parts = idToken.split('.');
  if (parts.length < 2) {
    return {};
  }

  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >;
    return {
      sub: asOptionalString(payload.sub),
      email: asOptionalString(payload.email),
      name: asOptionalString(payload.name),
    };
  } catch {
    return {};
  }
}

function parseScopes(scope: string | undefined): string[] {
  if (!scope || scope.trim().length === 0) {
    return [];
  }

  return scope
    .split(/[,\s]+/)
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function resolveUserIdHint(userIdHint: string | undefined): string {
  const normalized = asOptionalString(userIdHint);
  if (normalized) {
    return normalized;
  }

  return `hint_${randomBytes(8).toString('hex')}`;
}

function buildSocialProfile(identity: SocialIdentityRecord): Record<string, unknown> {
  return {
    tenantId: identity.tenantId,
    userId: identity.userId,
    providerId: identity.providerId,
    providerUserId: identity.providerUserId,
    displayName: identity.displayName,
    connectionId: identity.connectionId,
    scopes: [...identity.scopes],
  };
}

function buildConnectionId(providerId: string, tenantId: string, userId: string): string {
  const entropy = randomBytes(4).toString('hex');
  return `soc_${providerId}_${tenantId}_${userId}_${entropy}`;
}

function buildIdentityId(providerId: string, tenantId: string, userId: string): string {
  const input = `${providerId}:${tenantId}:${userId}`;
  const digest = createHash('sha256').update(input).digest('hex').slice(0, 16);
  return `sid_${digest}`;
}

function scopeKey(tenantId: string, userId: string): string {
  return `${tenantId}:${userId}`;
}

function readErrorDetails(error: unknown): { code: string; message: string } {
  if (error && typeof error === 'object') {
    const raw = error as { code?: unknown; message?: unknown };
    return {
      code: typeof raw.code === 'string' && raw.code.length > 0 ? raw.code : 'INTERNAL_ERROR',
      message: typeof raw.message === 'string' && raw.message.length > 0 ? raw.message : 'unknown error',
    };
  }

  if (error instanceof Error) {
    return {
      code: 'INTERNAL_ERROR',
      message: error.message,
    };
  }

  return {
    code: 'INTERNAL_ERROR',
    message: 'unknown error',
  };
}

function mapToSocialOAuthError(error: unknown): SocialOAuthError {
  if (error instanceof SocialOAuthError) {
    return error;
  }

  const flowError = error as Partial<OAuthFlowError> & { code?: string; message?: string };
  const message =
    typeof flowError.message === 'string' && flowError.message.trim().length > 0
      ? flowError.message
      : 'unexpected oauth flow error';

  if (
    flowError.code === 'OAUTH_STATE_INVALID' ||
    flowError.code === 'OAUTH_STATE_REPLAYED' ||
    flowError.code === 'OAUTH_CALLBACK_MISMATCH'
  ) {
    return new SocialOAuthError('OAUTH_STATE_INVALID', 'oauth state is invalid or expired');
  }

  if (flowError.code === 'VALIDATION_ERROR') {
    return new SocialOAuthError('VALIDATION_ERROR', message);
  }

  return new SocialOAuthError('INTERNAL_ERROR', message);
}

function hasRevocationFailure(
  revocationFailures: Map<string, SocialRevocationFailureRecord[]>,
  tenantId: string,
  userId: string,
  connectionId: string
): boolean {
  const failures = revocationFailures.get(scopeKey(tenantId, userId)) ?? [];
  return failures.some((failure) => failure.connectionId === connectionId);
}

function createDefaultTokenKeyResolver(encryptionKey?: string): TokenKeyResolver {
  const raw = encryptionKey ?? process.env.AUTHFN_SOCIAL_OAUTH_ENCRYPTION_KEY ?? 'authfn-social-dev-key';
  const material = createHash('sha256').update(raw, 'utf8').digest();
  return async () => material;
}

export * from './types.js';
export * from './provider-map.js';

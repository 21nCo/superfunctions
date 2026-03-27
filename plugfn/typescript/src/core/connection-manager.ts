import type { Adapter as DbAdapter } from '@superfunctions/db';
import type {
  Connection,
  Credentials,
  DisconnectOptions,
  EncryptedCredentials,
  GetAuthUrlOptions,
  HandleCallbackOptions,
  ListConnectionsOptions,
  OAuth2Credentials,
} from '../types/connection.js';
import { ConnectionStatus } from '../types/connection.js';
import type { Provider, OAuth2Config } from '../types/provider.js';
import { AuthType } from '../types/provider.js';
import type { Logger } from '../types/action.js';
import { ConnectionStorage } from '../storage/connection-storage.js';
import { SecureTokenStorage } from '../storage/token-storage.js';
import {
  type OAuthProviderDescriptor,
  type OAuthTokenSet,
} from '@superfunctions/oauth-core';
import {
  DefaultOAuthTokenHttpClient,
  type OAuthTokenHttpClient,
} from '@superfunctions/oauth-http';
import { createOAuthFlowService, type OAuthFlowService } from '@superfunctions/oauth-flow';
import {
  type OAuthStateStore,
  type TokenRecord,
  EncryptedTokenVault,
} from '@superfunctions/oauth-storage';
import { oauthProviderDescriptors } from '@superfunctions/oauth-providers';
import { ensurePlugFnDatabaseAdapter } from '../storage/adapters/database.js';
import { createPlugFnOAuthStateStore } from '../storage/oauth-state-store.js';
import {
  createPlugFnEncryptedTokenVault,
  DEFAULT_TOKEN_KEY_REF,
} from '../storage/oauth-token-vault.js';

interface OAuthClientConfig {
  clientId: string;
  clientSecret: string;
  redirectUris: string[];
}

export interface ConnectionManagerOAuthDependencies {
  oauthFlowService: OAuthFlowService;
  oauthStateStore: OAuthStateStore;
  encryptedTokenVault: EncryptedTokenVault;
  keyRef: string;
}

interface CreateConnectionManagerOAuthDependenciesInput {
  database: DbAdapter;
  providers: Map<string, Provider>;
  integrationConfigs: Map<string, any>;
  baseUrl: string;
  encryptionKey: string;
  tokenHttpClient?: OAuthTokenHttpClient;
  now?: () => Date;
}

export class ConnectionSelectionError extends Error {
  readonly code = 'CONNECTION_AMBIGUOUS';
  readonly status = 409;

  constructor(message = 'multiple active connections require explicit connectionId') {
    super(message);
    this.name = 'ConnectionSelectionError';
  }
}

export function createConnectionManagerOAuthDependencies(
  input: CreateConnectionManagerOAuthDependenciesInput
): ConnectionManagerOAuthDependencies {
  const now = input.now ?? (() => new Date());
  const tokenHttpClient = input.tokenHttpClient ?? new DefaultOAuthTokenHttpClient();
  const runtimeStorage = ensurePlugFnDatabaseAdapter(input.database);
  const stateStore = createPlugFnOAuthStateStore(input.database);
  const { encryptedTokenVault } = createPlugFnEncryptedTokenVault({
    database: input.database,
    encryptionKey: input.encryptionKey,
    now: () => now().toISOString(),
  });

  const oauthProviderMap = createProviderDescriptorRegistry(input.providers);
  const oauthClientConfigMap = createOAuthClientConfigMap(input.integrationConfigs, input.baseUrl);
  const oauthRuntimeConfigMap = createDynamicOAuthRuntimeConfigMap(oauthClientConfigMap);
  const oauthFlowService = createOAuthFlowService({
    providers: oauthProviderMap,
    providerRuntimeConfig: oauthRuntimeConfigMap,
    stateStore,
    tokenVault: encryptedTokenVault,
    tokenHttpClient,
    keyRef: DEFAULT_TOKEN_KEY_REF,
    now,
    identityHooks: {
      onDisconnected: async ({ connectionId }) => {
        await runtimeStorage.deleteConnection(connectionId);
        return {
          attempted: true,
          deleted: true,
          reason: 'deleted',
        };
      },
    },
  });

  return {
    oauthFlowService,
    oauthStateStore: stateStore,
    encryptedTokenVault,
    keyRef: DEFAULT_TOKEN_KEY_REF,
  };
}

export class ConnectionManager {
  private readonly tokenStorage: SecureTokenStorage;
  private readonly oauthFlowService: OAuthFlowService;
  private readonly oauthStateStore: OAuthStateStore;
  private readonly encryptedTokenVault: EncryptedTokenVault;
  private readonly keyRef: string;

  constructor(
    private connectionStorage: ConnectionStorage,
    private providers: Map<string, Provider>,
    private integrationConfigs: Map<string, any>,
    private baseUrl: string,
    encryptionKey: string,
    private logger: Logger,
    oauthDependencies: ConnectionManagerOAuthDependencies
  ) {
    this.tokenStorage = new SecureTokenStorage(encryptionKey);
    this.oauthFlowService = oauthDependencies.oauthFlowService;
    this.oauthStateStore = oauthDependencies.oauthStateStore;
    this.encryptedTokenVault = oauthDependencies.encryptedTokenVault;
    this.keyRef = oauthDependencies.keyRef;
  }

  async getAuthUrl(options: GetAuthUrlOptions): Promise<string> {
    const provider = this.providers.get(options.provider);
    if (!provider) {
      throw new Error(`Provider ${options.provider} not found`);
    }

    if (provider.auth.type !== AuthType.OAuth2) {
      throw new Error(`Provider ${options.provider} does not support OAuth`);
    }

    const oauthConfig = provider.auth.config as OAuth2Config;
    const result = await this.oauthFlowService.start({
      providerId: options.provider,
      tenantId: options.userId,
      userId: options.userId,
      redirectUri: options.redirectUri,
      scopes: options.scopes ?? oauthConfig.scopes,
    });

    this.logger.info(`Generated auth URL for ${options.provider}`, { userId: options.userId });
    return result.authorizationUrl;
  }

  async handleCallback(options: HandleCallbackOptions): Promise<Connection> {
    const statePreview = await this.oauthStateStore.get(options.state);
    if (!statePreview) {
      throw new Error('OAuth state is invalid or expired');
    }

    const providerId = options.provider ?? statePreview.providerId;
    const redirectUri = options.redirectUri ?? statePreview.redirectUri;
    if (!providerId || !redirectUri) {
      throw new Error('OAuth state is invalid or expired');
    }

    const callbackResult = await this.oauthFlowService.handleCallback({
      providerId,
      code: options.code,
      state: options.state,
      redirectUri,
    });
    const subjectUserId = callbackResult.subject.userId ?? statePreview.userId;
    const callbackConnectionId = callbackResult.connectionId;
    if (!subjectUserId || !callbackConnectionId) {
      throw new Error('OAuth callback did not resolve a stable connection subject');
    }

    const credentials = this.toOAuth2Credentials(callbackResult.tokenSet);
    const pendingTokenEntry = await this.encryptedTokenVault.getTokenSetByConnection(
      callbackConnectionId
    );
    if (!pendingTokenEntry) {
      throw new Error(`OAuth token record missing for connection ${callbackConnectionId}`);
    }

    const connection = await this.connectionStorage.create({
      userId: subjectUserId,
      provider: providerId,
      name: options.connectionName,
      status: ConnectionStatus.Active,
      credentials: toEncryptedCredentials(pendingTokenEntry.record),
      scopes: statePreview.requestedScopes,
      expiresAt: credentials.expiresAt,
      connectedAt: new Date(),
    });

    const persistedTokenRecord = await this.rebindTokenConnection(
      callbackConnectionId,
      connection.id
    );

    const updatedConnection = await this.connectionStorage.update(connection.id, {
      credentials: toEncryptedCredentials(persistedTokenRecord),
      expiresAt: credentials.expiresAt,
      status: ConnectionStatus.Active,
    });

    this.logger.info(`Connection created: ${providerId}`, {
      userId: subjectUserId,
      connectionId: updatedConnection.id,
    });

    return updatedConnection;
  }

  async list(options: ListConnectionsOptions): Promise<Connection[]> {
    return this.connectionStorage.list(options.userId, options.provider, options.status);
  }

  async get(id: string): Promise<Connection> {
    const connection = await this.connectionStorage.get(id);
    if (!connection) {
      throw new Error(`Connection ${id} not found`);
    }
    return connection;
  }

  async getByUserAndProvider(userId: string, provider: string): Promise<Connection | null> {
    return this.connectionStorage.getByUserAndProvider(userId, provider);
  }

  async resolveConnectionForAction(options: {
    userId: string;
    provider: string;
    connectionId?: string;
  }): Promise<Connection | null> {
    if (options.connectionId) {
      return this.get(options.connectionId);
    }

    const activeConnections = await this.connectionStorage.list(
      options.userId,
      options.provider,
      ConnectionStatus.Active
    );

    if (activeConnections.length === 0) {
      return null;
    }

    if (activeConnections.length === 1) {
      return activeConnections[0];
    }

    const sortedConnections = [...activeConnections].sort(compareConnectionPriority);
    if (compareConnectionPriority(sortedConnections[0], sortedConnections[1]) === 0) {
      throw new ConnectionSelectionError();
    }

    return sortedConnections[0];
  }

  async disconnect(options: DisconnectOptions): Promise<void> {
    const targetConnection = options.connectionId
      ? await this.connectionStorage.get(options.connectionId)
      : await this.connectionStorage.getByUserAndProvider(options.userId, options.provider);

    if (!targetConnection) {
      return;
    }

    const provider = this.providers.get(targetConnection.provider);
    if (!provider || provider.auth.type !== AuthType.OAuth2) {
      await this.connectionStorage.delete(targetConnection.id);
      this.logger.info(`Connection deleted: ${targetConnection.id}`);
      return;
    }

    try {
      await this.oauthFlowService.disconnect({
        connectionId: targetConnection.id,
        providerId: targetConnection.provider,
        revokeRemote: true,
        tokenTypeHint: 'access_token',
      });
      this.logger.info(`Connection deleted: ${targetConnection.id}`);
    } catch (error) {
      this.logger.warn('Disconnect completed with remote revoke failure', {
        provider: targetConnection.provider,
        connectionId: targetConnection.id,
        error: (error as Error).message,
      });
      throw error;
    }
  }

  async refresh(connectionId: string): Promise<Connection> {
    const connection = await this.get(connectionId);
    const provider = this.providers.get(connection.provider);

    if (!provider || provider.auth.type !== AuthType.OAuth2) {
      throw new Error('Token refresh not supported for this provider');
    }

    const refreshedTokenSet = await this.oauthFlowService.refresh({
      connectionId: connection.id,
      providerId: connection.provider,
      redirectUri: this.resolveRefreshRedirectUri(connection.provider),
      scopes: connection.scopes ?? [],
    });
    const mergedCredentials = this.toOAuth2Credentials(refreshedTokenSet);
    const tokenRecordEntry = await this.encryptedTokenVault.getTokenSetByConnection(connection.id);
    if (!tokenRecordEntry) {
      throw new Error(`OAuth token record missing for connection ${connection.id}`);
    }

    const updated = await this.connectionStorage.update(connection.id, {
      credentials: toEncryptedCredentials(tokenRecordEntry.record),
      expiresAt: mergedCredentials.expiresAt,
      status: ConnectionStatus.Active,
    });

    this.logger.info(`Connection refreshed: ${connection.id}`);
    return updated;
  }

  async getCredentials(connectionId: string): Promise<Credentials> {
    const connection = await this.get(connectionId);
    const provider = this.providers.get(connection.provider);

    if (provider?.auth.type === AuthType.OAuth2) {
      if (
        connection.status === ConnectionStatus.Active &&
        connection.expiresAt &&
        new Date() >= connection.expiresAt
      ) {
        const refreshedConnection = await this.refresh(connectionId);
        const refreshedToken = await this.encryptedTokenVault.getTokenSetByConnection(refreshedConnection.id);
        if (refreshedToken) {
          return this.toOAuth2Credentials(refreshedToken.tokenSet);
        }
        return this.decryptLegacyCredentials(refreshedConnection);
      }

      const storedToken = await this.encryptedTokenVault.getTokenSetByConnection(connection.id);
      if (storedToken) {
        return this.toOAuth2Credentials(storedToken.tokenSet);
      }

      return this.decryptLegacyCredentials(connection);
    }

    return this.decryptNonOAuthCredentials(connection);
  }

  async markUsed(connectionId: string): Promise<void> {
    await this.connectionStorage.updateLastUsed(connectionId);
  }

  async isValid(connectionId: string): Promise<boolean> {
    try {
      const connection = await this.get(connectionId);
      if (connection.status !== ConnectionStatus.Active) {
        return false;
      }

      if (connection.expiresAt && new Date() >= connection.expiresAt) {
        try {
          await this.refresh(connectionId);
          return true;
        } catch {
          return false;
        }
      }

      return true;
    } catch {
      return false;
    }
  }

  private resolveRefreshRedirectUri(providerId: string): string {
    const integrationConfig = this.integrationConfigs.get(providerId);
    if (integrationConfig && Array.isArray(integrationConfig.redirectUris) && integrationConfig.redirectUris[0]) {
      return integrationConfig.redirectUris[0];
    }

    return `${this.baseUrl}/api/plugfn/callback`;
  }

  private toOAuth2Credentials(tokenSet: OAuthTokenSet): OAuth2Credentials {
    return {
      type: 'oauth2',
      accessToken: tokenSet.accessToken,
      refreshToken: tokenSet.refreshToken,
      expiresAt: tokenSet.expiresAt ? new Date(tokenSet.expiresAt) : undefined,
      tokenType: tokenSet.tokenType,
      scope: tokenSet.scope,
    };
  }

  private async rebindTokenConnection(
    fromConnectionId: string,
    toConnectionId: string
  ): Promise<TokenRecord> {
    const existing = await this.encryptedTokenVault.getTokenSetByConnection(fromConnectionId);
    if (!existing) {
      throw new Error(`OAuth token record missing for connection ${fromConnectionId}`);
    }

    const rewritten = await this.encryptedTokenVault.putTokenSet({
      tokenId: existing.record.tokenId,
      tenantId: existing.record.tenantId,
      userId: existing.record.userId,
      providerId: existing.record.providerId,
      connectionId: toConnectionId,
      tokenSet: existing.tokenSet,
      keyRef: existing.record.keyRef || this.keyRef,
      createdAt: existing.record.createdAt,
      updatedAt: existing.record.updatedAt,
      expiresAt: existing.record.expiresAt,
    });

    if (fromConnectionId !== toConnectionId) {
      await this.encryptedTokenVault.deleteByConnection(fromConnectionId);
    }

    return rewritten;
  }

  private decryptLegacyCredentials(connection: Connection): Credentials {
    return this.tokenStorage.decryptCredentials(connection.credentials);
  }

  private decryptNonOAuthCredentials(connection: Connection): Credentials {
    try {
      return this.tokenStorage.decryptCredentials(connection.credentials);
    } catch (error) {
      const integrationConfig = this.integrationConfigs.get(connection.provider);
      if (integrationConfig?.type === 'api-key' && integrationConfig.apiKey) {
        return {
          type: 'api-key',
          apiKey: integrationConfig.apiKey,
        };
      }

      if (integrationConfig?.type === 'basic' && integrationConfig.username && integrationConfig.password) {
        return {
          type: 'basic',
          username: integrationConfig.username,
          password: integrationConfig.password,
        };
      }

      if (integrationConfig?.type === 'jwt' && integrationConfig.privateKey) {
        return {
          type: 'jwt',
          token: integrationConfig.privateKey,
        };
      }

      throw error;
    }
  }
}

function createProviderDescriptorRegistry(
  providers: Map<string, Provider>
): Record<string, OAuthProviderDescriptor> {
  return new Proxy(
    {},
    {
      get: (_target, property) => {
        if (typeof property !== 'string') {
          return undefined;
        }
        const provider = providers.get(property);
        if (!provider || provider.auth.type !== AuthType.OAuth2) {
          return undefined;
        }
        return buildOAuthProviderDescriptor(property, provider);
      },
      has: (_target, property) => {
        if (typeof property !== 'string') {
          return false;
        }
        const provider = providers.get(property);
        return Boolean(provider && provider.auth.type === AuthType.OAuth2);
      },
      ownKeys: () => {
        return [...providers.values()]
          .filter((provider) => provider.auth.type === AuthType.OAuth2)
          .map((provider) => provider.name);
      },
      getOwnPropertyDescriptor: (_target, property) => {
        if (typeof property !== 'string') {
          return undefined;
        }
        const provider = providers.get(property);
        if (!provider || provider.auth.type !== AuthType.OAuth2) {
          return undefined;
        }
        return {
          configurable: true,
          enumerable: true,
          value: buildOAuthProviderDescriptor(property, provider),
        };
      },
    }
  ) as Record<string, OAuthProviderDescriptor>;
}

function createOAuthClientConfigMap(
  integrationConfigs: Map<string, any>,
  baseUrl: string
): Record<string, OAuthClientConfig> {
  const oauthClientConfigMap: Record<string, OAuthClientConfig> = {};

  for (const [providerId, rawConfig] of integrationConfigs.entries()) {
    if (
      !rawConfig ||
      typeof rawConfig.clientId !== 'string' ||
      rawConfig.clientId.length === 0 ||
      typeof rawConfig.clientSecret !== 'string' ||
      rawConfig.clientSecret.length === 0
    ) {
      continue;
    }

    const configuredRedirectUris = Array.isArray(rawConfig.redirectUris)
      ? rawConfig.redirectUris.filter((value: unknown): value is string => {
          return typeof value === 'string' && value.length > 0;
        })
      : [];

    const redirectUris =
      configuredRedirectUris.length > 0
        ? configuredRedirectUris
        : [`${baseUrl}/api/plugfn/callback`];

    oauthClientConfigMap[providerId] = {
      clientId: rawConfig.clientId,
      clientSecret: rawConfig.clientSecret,
      redirectUris,
    };
  }

  return oauthClientConfigMap;
}

function createDynamicOAuthRuntimeConfigMap(
  oauthClientConfigMap: Record<string, OAuthClientConfig>
): Record<string, { clientId: string; clientSecret: string; allowlistedRedirectUris?: string[] }> {
  return new Proxy(
    {},
    {
      get: (_target, property) => {
        if (typeof property !== 'string') {
          return undefined;
        }
        const config = oauthClientConfigMap[property];
        if (!config) {
          return undefined;
        }
        return {
          clientId: config.clientId,
          clientSecret: config.clientSecret,
          allowlistedRedirectUris: [...config.redirectUris],
        };
      },
      has: (_target, property) => {
        if (typeof property !== 'string') {
          return false;
        }
        return Boolean(oauthClientConfigMap[property]);
      },
      ownKeys: () => {
        return Object.keys(oauthClientConfigMap);
      },
      getOwnPropertyDescriptor: (_target, property) => {
        if (typeof property !== 'string') {
          return undefined;
        }
        const config = oauthClientConfigMap[property];
        if (!config) {
          return undefined;
        }
        return {
          configurable: true,
          enumerable: true,
          value: {
            clientId: config.clientId,
            clientSecret: config.clientSecret,
            allowlistedRedirectUris: [...config.redirectUris],
          },
        };
      },
    }
  ) as Record<string, { clientId: string; clientSecret: string; allowlistedRedirectUris?: string[] }>;
}

function buildOAuthProviderDescriptor(providerId: string, provider: Provider): OAuthProviderDescriptor {
  const sharedDescriptor = (oauthProviderDescriptors as Record<string, OAuthProviderDescriptor | undefined>)[
    providerId
  ];
  if (sharedDescriptor) {
    return {
      ...sharedDescriptor,
      defaultScopes: [...sharedDescriptor.defaultScopes],
      extraAuthParams: sharedDescriptor.extraAuthParams
        ? { ...sharedDescriptor.extraAuthParams }
        : undefined,
    };
  }

  const oauthConfig = provider.auth.config as OAuth2Config;
  const rawOAuthConfig = oauthConfig as unknown as Record<string, unknown>;
  const rawTokenAuthMethod = rawOAuthConfig.tokenAuthMethod;
  const tokenAuthMethod =
    rawTokenAuthMethod === 'client_secret_basic' || rawTokenAuthMethod === 'client_secret_post'
      ? rawTokenAuthMethod
      : 'client_secret_post';

  return {
    id: providerId,
    authorizationUrl: oauthConfig.authorizationUrl,
    tokenUrl: oauthConfig.tokenUrl,
    revocationUrl:
      typeof rawOAuthConfig.revocationUrl === 'string'
        ? (rawOAuthConfig.revocationUrl as string)
        : undefined,
    defaultScopes: [...oauthConfig.scopes],
    supportsPkce: true,
    supportsRefreshToken: true,
    scopeSeparator: oauthConfig.scopeSeparator === ',' ? ',' : ' ',
    tokenAuthMethod,
  };
}

function toEncryptedCredentials(record: TokenRecord): EncryptedCredentials {
  return {
    encrypted: record.encryptedPayload,
    encryptedPayload: record.encryptedPayload,
    keyRef: record.keyRef,
    tokenId: record.tokenId,
    schemaVersion: 'oauth-v1',
    algorithm: 'aes-256-gcm',
  };
}

function compareConnectionPriority(a: Connection, b: Connection): number {
  // Deterministic ordering: newest lastUsedAt, then newest connectedAt, then newest createdAt.
  // Final tie-breaker is lexical connection id.
  const priorityFields: Array<keyof Connection> = ['lastUsedAt', 'connectedAt', 'createdAt'];

  for (const field of priorityFields) {
    const timeDiff = toTimestamp(b[field]) - toTimestamp(a[field]);
    if (timeDiff !== 0) {
      return timeDiff;
    }
  }

  if (a.id !== b.id) {
    return a.id.localeCompare(b.id);
  }

  return 0;
}

function toTimestamp(value: unknown): number {
  if (!value) {
    return 0;
  }

  if (value instanceof Date) {
    return value.getTime();
  }

  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? 0 : parsed;
  }

  return 0;
}

import type {
  Connection,
  GetAuthUrlOptions,
  HandleCallbackOptions,
  ListConnectionsOptions,
  DisconnectOptions,
  OAuth2Credentials,
  Credentials,
} from '../types/connection.js';
import { ConnectionStatus } from '../types/connection.js';
import type { Provider, OAuth2Config } from '../types/provider.js';
import { AuthType } from '../types/provider.js';
import type { Logger } from '../types/action.js';
import { ConnectionStorage } from '../storage/connection-storage.js';
import { SecureTokenStorage } from '../storage/token-storage.js';
import { OAuthFlowHandler } from '../auth/oauth-flow.js';
import { MemoryTokenStore } from '../auth/token-store.js';

/**
 * Connection manager handles user connections to providers
 */
export class ConnectionManager {
  private oauthHandler: OAuthFlowHandler;
  private tokenStorage: SecureTokenStorage;

  constructor(
    private connectionStorage: ConnectionStorage,
    private providers: Map<string, Provider>,
    private integrationConfigs: Map<string, any>,
    private baseUrl: string,
    encryptionKey: string,
    private logger: Logger
  ) {
    this.tokenStorage = new SecureTokenStorage(encryptionKey);
    this.oauthHandler = new OAuthFlowHandler(new MemoryTokenStore());
  }

  /**
   * Get OAuth authorization URL
   */
  async getAuthUrl(options: GetAuthUrlOptions): Promise<string> {
    const provider = this.providers.get(options.provider);
    if (!provider) {
      throw new Error(`Provider ${options.provider} not found`);
    }

    if (provider.auth.type !== AuthType.OAuth2) {
      throw new Error(`Provider ${options.provider} does not support OAuth`);
    }

    const config = this.integrationConfigs.get(options.provider);
    if (!config) {
      throw new Error(`Provider ${options.provider} not configured`);
    }

    const { url, state } = await this.oauthHandler.getAuthorizationUrl(
      provider.auth.config as OAuth2Config,
      {
        clientId: config.clientId,
        clientSecret: config.clientSecret,
        redirectUri: options.redirectUri,
        scopes: options.scopes || provider.auth.config.scopes,
        state: options.state,
      }
    );

    // Store state with user info
    const stateData = {
      userId: options.userId,
      provider: options.provider,
      redirectUri: options.redirectUri,
      scopes: options.scopes,
      connectionName: options.connectionName,
      timestamp: Date.now(),
    };
    
    await this.oauthHandler['tokenStore'].set(
      `oauth:state:${state}`,
      JSON.stringify(stateData),
      600000
    );

    this.logger.info(`Generated auth URL for ${options.provider}`, { userId: options.userId });
    return url;
  }

  /**
   * Handle OAuth callback and create connection
   */
  async handleCallback(options: HandleCallbackOptions): Promise<Connection> {
    // Verify state
    const stateDataStr = await this.oauthHandler['tokenStore'].get(`oauth:state:${options.state}`);
    if (!stateDataStr) {
      throw new Error('Invalid or expired OAuth state');
    }

    const stateData = JSON.parse(stateDataStr);
    await this.oauthHandler['tokenStore'].delete(`oauth:state:${options.state}`);

    const provider = this.providers.get(stateData.provider);
    if (!provider) {
      throw new Error(`Provider ${stateData.provider} not found`);
    }

    const config = this.integrationConfigs.get(stateData.provider);
    if (!config) {
      throw new Error(`Provider ${stateData.provider} not configured`);
    }

    // Exchange code for token
    const tokenResponse = await this.oauthHandler.exchangeCodeForToken(
      provider.auth.config as OAuth2Config,
      {
        clientId: config.clientId,
        clientSecret: config.clientSecret,
        redirectUri: stateData.redirectUri,
        scopes: stateData.scopes,
      },
      options.code
    );

    // Create credentials
    const credentials: OAuth2Credentials = {
      type: 'oauth2',
      accessToken: tokenResponse.access_token,
      refreshToken: tokenResponse.refresh_token,
      expiresAt: tokenResponse.expires_in
        ? new Date(Date.now() + tokenResponse.expires_in * 1000)
        : undefined,
      tokenType: tokenResponse.token_type,
      scope: tokenResponse.scope,
    };

    // Encrypt and store connection
    const connection = await this.connectionStorage.create({
      userId: stateData.userId,
      provider: stateData.provider,
      name: stateData.connectionName,
      status: ConnectionStatus.Active,
      credentials: this.tokenStorage.encryptCredentials(credentials),
      scopes: stateData.scopes,
      expiresAt: credentials.expiresAt,
      connectedAt: new Date(),
    });

    this.logger.info(`Connection created: ${stateData.provider}`, {
      userId: stateData.userId,
      connectionId: connection.id,
    });

    return connection;
  }

  /**
   * List user connections
   */
  async list(options: ListConnectionsOptions): Promise<Connection[]> {
    return this.connectionStorage.list(options.userId, options.provider, options.status);
  }

  /**
   * Get a specific connection
   */
  async get(id: string): Promise<Connection> {
    const connection = await this.connectionStorage.get(id);
    if (!connection) {
      throw new Error(`Connection ${id} not found`);
    }
    return connection;
  }

  /**
   * Get connection by user and provider
   */
  async getByUserAndProvider(userId: string, provider: string): Promise<Connection | null> {
    return this.connectionStorage.getByUserAndProvider(userId, provider);
  }

  /**
   * Disconnect (delete connection)
   */
  async disconnect(options: DisconnectOptions): Promise<void> {
    if (options.connectionId) {
      await this.connectionStorage.delete(options.connectionId);
      this.logger.info(`Connection deleted: ${options.connectionId}`);
    } else {
      const connection = await this.connectionStorage.getByUserAndProvider(
        options.userId,
        options.provider
      );
      if (connection) {
        await this.connectionStorage.delete(connection.id);
        this.logger.info(`Connection deleted: ${connection.id}`);
      }
    }
  }

  /**
   * Refresh OAuth token
   */
  async refresh(connectionId: string): Promise<Connection> {
    const connection = await this.get(connectionId);
    const provider = this.providers.get(connection.provider);

    if (!provider || provider.auth.type !== AuthType.OAuth2) {
      throw new Error('Token refresh not supported for this provider');
    }

    const credentials = this.tokenStorage.decryptCredentials(
      connection.credentials
    ) as OAuth2Credentials;

    if (!credentials.refreshToken) {
      throw new Error('No refresh token available');
    }

    const config = this.integrationConfigs.get(connection.provider);
    if (!config) {
      throw new Error(`Provider ${connection.provider} not configured`);
    }

    // Refresh the token
    const tokenResponse = await this.oauthHandler.refreshAccessToken(
      provider.auth.config as OAuth2Config,
      {
        clientId: config.clientId,
        clientSecret: config.clientSecret,
        redirectUri: `${this.baseUrl}/api/plugfn/callback`,
        scopes: connection.scopes || [],
      },
      credentials.refreshToken
    );

    // Update credentials
    const newCredentials: OAuth2Credentials = {
      type: 'oauth2',
      accessToken: tokenResponse.access_token,
      refreshToken: tokenResponse.refresh_token || credentials.refreshToken,
      expiresAt: tokenResponse.expires_in
        ? new Date(Date.now() + tokenResponse.expires_in * 1000)
        : undefined,
      tokenType: tokenResponse.token_type,
      scope: tokenResponse.scope,
    };

    // Update connection
    const updated = await this.connectionStorage.update(connection.id, {
      credentials: this.tokenStorage.encryptCredentials(newCredentials),
      expiresAt: newCredentials.expiresAt,
      status: ConnectionStatus.Active,
    });

    this.logger.info(`Connection refreshed: ${connection.id}`);
    return updated;
  }

  /**
   * Get decrypted credentials for a connection
   */
  async getCredentials(connectionId: string): Promise<Credentials> {
    const connection = await this.get(connectionId);
    
    // Check if expired and auto-refresh if needed
    if (
      connection.status === ConnectionStatus.Active &&
      connection.expiresAt &&
      new Date() >= connection.expiresAt
    ) {
      const refreshed = await this.refresh(connectionId);
      return this.tokenStorage.decryptCredentials(refreshed.credentials);
    }

    return this.tokenStorage.decryptCredentials(connection.credentials);
  }

  /**
   * Mark connection as used (update lastUsedAt)
   */
  async markUsed(connectionId: string): Promise<void> {
    await this.connectionStorage.updateLastUsed(connectionId);
  }

  /**
   * Check connection validity
   */
  async isValid(connectionId: string): Promise<boolean> {
    try {
      const connection = await this.get(connectionId);
      
      if (connection.status !== ConnectionStatus.Active) {
        return false;
      }

      if (connection.expiresAt && new Date() >= connection.expiresAt) {
        // Try to refresh
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
}


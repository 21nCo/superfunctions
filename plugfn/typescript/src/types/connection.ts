/**
 * Connection status
 */
export enum ConnectionStatus {
  Active = 'active',
  Expired = 'expired',
  Revoked = 'revoked',
  Error = 'error',
}

/**
 * User connection to a provider
 */
export interface Connection {
  id: string;
  userId: string;
  provider: string;
  name?: string;
  status: ConnectionStatus;
  credentials: EncryptedCredentials;
  scopes?: string[];
  metadata?: Record<string, any>;
  expiresAt?: Date;
  connectedAt: Date;
  lastUsedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Encrypted credentials stored in database
 */
export interface EncryptedCredentials {
  encrypted: string;
  algorithm: string;
  iv?: string;
}

/**
 * Decrypted credentials for runtime use
 */
export type Credentials =
  | OAuth2Credentials
  | ApiKeyCredentials
  | JWTCredentials
  | BasicAuthCredentials;

export interface OAuth2Credentials {
  type: 'oauth2';
  accessToken: string;
  refreshToken?: string;
  expiresAt?: Date;
  tokenType?: string;
  scope?: string;
}

export interface ApiKeyCredentials {
  type: 'api-key';
  apiKey: string;
}

export interface JWTCredentials {
  type: 'jwt';
  token: string;
}

export interface BasicAuthCredentials {
  type: 'basic';
  username: string;
  password: string;
}

/**
 * Get auth URL options
 */
export interface GetAuthUrlOptions {
  userId: string;
  provider: string;
  redirectUri: string;
  state: string;
  scopes?: string[];
  connectionName?: string;
}

/**
 * Handle OAuth callback options
 */
export interface HandleCallbackOptions {
  code: string;
  state: string;
}

/**
 * List connections options
 */
export interface ListConnectionsOptions {
  userId: string;
  provider?: string;
  status?: ConnectionStatus;
}

/**
 * Disconnect options
 */
export interface DisconnectOptions {
  userId: string;
  provider: string;
  connectionId?: string;
}


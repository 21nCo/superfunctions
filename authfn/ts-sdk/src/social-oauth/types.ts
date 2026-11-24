import type { OAuthProviderId } from '@superfunctions/oauth-providers';

export type SocialProviderId = OAuthProviderId;

export interface SocialOAuthProviderRuntimeConfig {
  clientId: string;
  clientSecret: string;
  redirectUris: string[];
  scopes?: string[];
}

export interface SocialAuthLoginInput {
  tenantId: string;
  userIdHint?: string;
  provider: string;
  redirectUri: string;
}

export interface SocialAuthLoginResult {
  url: string;
  stateId: string;
}

export interface SocialAuthCallbackInput {
  provider: string;
  code: string;
  state: string;
  redirectUri: string;
}

export interface SocialAuthCallbackResult {
  identityId: string;
  email?: string;
  profile: Record<string, unknown>;
}

export interface SocialAuthDisconnectInput {
  tenantId: string;
  identityId: string;
}

export interface SocialOAuthLoginInput {
  providerId: SocialProviderId;
  tenantId: string;
  userId: string;
  redirectUri: string;
  scopes?: string[];
  prompt?: string;
  loginHint?: string;
}

export interface SocialOAuthLoginResult {
  authorizationUrl: string;
  stateId: string;
  expiresAt: string;
}

export interface SocialOAuthCallbackInput {
  providerId: SocialProviderId;
  code: string;
  state: string;
  redirectUri: string;
}

export interface SocialOAuthTokenSet {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: string;
  scope?: string;
  tokenType?: string;
  idToken?: string;
}

export interface SocialIdentityRecord {
  id: string;
  tenantId: string;
  userId: string;
  providerId: SocialProviderId;
  providerUserId?: string;
  email?: string;
  displayName?: string;
  connectionId: string;
  scopes: string[];
  createdAt: string;
  updatedAt: string;
}

export interface SocialOAuthCallbackResult {
  identity: SocialIdentityRecord;
  tokenSet: SocialOAuthTokenSet;
}

export interface SocialOAuthDisconnectInput {
  tenantId: string;
  userId: string;
  providerId: SocialProviderId;
}

export interface SocialOAuthDisconnectResult {
  disconnected: boolean;
  remoteRevokeAttempted: boolean;
  localTokenDeleted: boolean;
  identityDeleted: boolean;
  revocationFailureRecorded: boolean;
}

export interface SocialRevocationFailureRecord {
  tenantId: string;
  userId: string;
  providerId: SocialProviderId;
  connectionId: string;
  code: string;
  message: string;
  recordedAt: string;
}

export interface SocialIdentityStore {
  upsert(record: SocialIdentityRecord): Promise<SocialIdentityRecord>;
  get(tenantId: string, userId: string, providerId: SocialProviderId): Promise<SocialIdentityRecord | null>;
  getByIdentityId(tenantId: string, identityId: string): Promise<SocialIdentityRecord | null>;
  list(tenantId: string, userId: string): Promise<SocialIdentityRecord[]>;
  deleteByConnection(connectionId: string): Promise<void>;
}

export class InMemorySocialIdentityStore implements SocialIdentityStore {
  private readonly records = new Map<string, SocialIdentityRecord>();
  private readonly keyByConnection = new Map<string, string>();
  private readonly keyByIdentityId = new Map<string, string>();

  async upsert(record: SocialIdentityRecord): Promise<SocialIdentityRecord> {
    const key = buildIdentityKey(record.tenantId, record.userId, record.providerId);
    const previous = this.records.get(key);

    if (previous) {
      this.keyByConnection.delete(previous.connectionId);
      this.keyByIdentityId.delete(previous.id);
    }

    this.records.set(key, { ...record, scopes: [...record.scopes] });
    this.keyByConnection.set(record.connectionId, key);
    this.keyByIdentityId.set(record.id, key);
    return { ...record, scopes: [...record.scopes] };
  }

  async get(
    tenantId: string,
    userId: string,
    providerId: SocialProviderId
  ): Promise<SocialIdentityRecord | null> {
    const key = buildIdentityKey(tenantId, userId, providerId);
    const value = this.records.get(key);
    if (!value) {
      return null;
    }
    return { ...value, scopes: [...value.scopes] };
  }

  async getByIdentityId(tenantId: string, identityId: string): Promise<SocialIdentityRecord | null> {
    const key = this.keyByIdentityId.get(identityId);
    if (!key) {
      return null;
    }

    if (!key.startsWith(`${tenantId}:`)) {
      return null;
    }

    const value = this.records.get(key);
    if (!value) {
      return null;
    }

    return { ...value, scopes: [...value.scopes] };
  }

  async list(tenantId: string, userId: string): Promise<SocialIdentityRecord[]> {
    const prefix = `${tenantId}:${userId}:`;
    return [...this.records.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([, record]) => ({ ...record, scopes: [...record.scopes] }));
  }

  async deleteByConnection(connectionId: string): Promise<void> {
    const key = this.keyByConnection.get(connectionId);
    if (!key) {
      return;
    }

    const record = this.records.get(key);
    if (record) {
      this.keyByIdentityId.delete(record.id);
    }

    this.keyByConnection.delete(connectionId);
    this.records.delete(key);
  }
}

export class SocialOAuthError extends Error {
  readonly code:
    | 'VALIDATION_ERROR'
    | 'OAUTH_STATE_INVALID'
    | 'TENANT_ACCESS_DENIED'
    | 'INTERNAL_ERROR';
  readonly status: number;

  constructor(
    code: 'VALIDATION_ERROR' | 'OAUTH_STATE_INVALID' | 'TENANT_ACCESS_DENIED' | 'INTERNAL_ERROR',
    message: string
  ) {
    super(message);
    this.name = 'SocialOAuthError';
    this.code = code;
    this.status = code === 'TENANT_ACCESS_DENIED' ? 403 : code === 'OAUTH_STATE_INVALID' ? 401 : 400;
  }
}

export interface SocialAuthService {
  getLoginUrl(input: SocialAuthLoginInput): Promise<SocialAuthLoginResult>;
  handleLoginCallback(input: SocialAuthCallbackInput): Promise<SocialAuthCallbackResult>;
  disconnectIdentity(input: SocialAuthDisconnectInput): Promise<void>;

  // Extensions for callers that need richer OAuth and lifecycle details.
  createLoginUrl(input: SocialOAuthLoginInput): Promise<SocialOAuthLoginResult>;
  handleCallback(input: SocialOAuthCallbackInput): Promise<SocialOAuthCallbackResult>;
  listLinkedIdentities(input: { tenantId: string; userId: string }): Promise<SocialIdentityRecord[]>;
  disconnect(input: SocialOAuthDisconnectInput): Promise<SocialOAuthDisconnectResult>;
  getRevocationFailures(input: { tenantId: string; userId: string }): Promise<SocialRevocationFailureRecord[]>;
}

export type SocialOAuthService = SocialAuthService;

export function buildIdentityKey(
  tenantId: string,
  userId: string,
  providerId: SocialProviderId
): string {
  return `${tenantId}:${userId}:${providerId}`;
}

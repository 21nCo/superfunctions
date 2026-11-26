import { describe, it, expect, vi } from 'vitest';
import type { OAuthTokenEndpointRequest, OAuthTokenHttpClient } from '@superfunctions/oauth-http';
import { ConnectionManager, createConnectionManagerOAuthDependencies } from '../src/core/connection-manager.js';
import { AdapterConnectionStorage } from '../src/storage/connection-storage.js';
import { MemoryAdapter } from '../src/storage/adapters/memory.js';
import { DEFAULT_PLUGFN_STORAGE_MODELS } from '../src/storage/adapters/database.js';
import { NoopLogger } from '../src/utils/logger.js';
import type { Provider } from '../src/types/provider.js';
import { AuthType } from '../src/types/provider.js';
import { ConnectionStatus } from '../src/types/connection.js';

const BASE_URL = 'https://app.21n.co';
const REDIRECT_URI = 'https://app.21n.co/oauth/callback';
const ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

describe('ConnectionManager OAuth shared integration', () => {
  it('persists state in adapter storage and consumes callback from another manager instance', async () => {
    const adapter = new MemoryAdapter();
    const tokenClient = createTokenHttpClient();

    const envA = createManagerEnvironment(adapter, tokenClient);
    const envB = createManagerEnvironment(adapter, tokenClient);

    const authUrl = await envA.manager.getAuthUrl({
      userId: 'user-1',
      provider: 'google',
      redirectUri: REDIRECT_URI,
    });

    const url = new URL(authUrl);
    const state = url.searchParams.get('state');
    expect(state).toBeTruthy();
    expect(url.searchParams.get('code_challenge')).toBeTruthy();
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');

    const { connection } = await envB.manager.handleCallback({
      code: 'auth-code-1',
      state: state!,
      provider: 'google',
      redirectUri: REDIRECT_URI,
    });

    expect(connection.provider).toBe('google');
    expect(connection.credentials.keyRef).toBe('plugfn-key-v1');
  });

  it('rejects callback replay with OAUTH_STATE_REPLAYED', async () => {
    const adapter = new MemoryAdapter();
    const tokenClient = createTokenHttpClient();

    const env = createManagerEnvironment(adapter, tokenClient);

    const authUrl = await env.manager.getAuthUrl({
      userId: 'user-1',
      provider: 'google',
      redirectUri: REDIRECT_URI,
    });
    const state = new URL(authUrl).searchParams.get('state');
    expect(state).toBeTruthy();

    await env.manager.handleCallback({
      code: 'auth-code-1',
      state: state!,
      provider: 'google',
      redirectUri: REDIRECT_URI,
    });

    await expect(
      env.manager.handleCallback({
        code: 'auth-code-2',
        state: state!,
        provider: 'google',
        redirectUri: REDIRECT_URI,
      })
    ).rejects.toMatchObject({
      code: 'OAUTH_STATE_REPLAYED',
    });
  });

  it('rejects callback redirect mismatch with OAUTH_CALLBACK_MISMATCH', async () => {
    const adapter = new MemoryAdapter();
    const tokenClient = createTokenHttpClient();

    const env = createManagerEnvironment(adapter, tokenClient);

    const authUrl = await env.manager.getAuthUrl({
      userId: 'user-1',
      provider: 'google',
      redirectUri: REDIRECT_URI,
    });
    const state = new URL(authUrl).searchParams.get('state');
    expect(state).toBeTruthy();

    await expect(
      env.manager.handleCallback({
        code: 'auth-code-1',
        state: state!,
        provider: 'google',
        redirectUri: 'https://evil.example/callback',
      })
    ).rejects.toMatchObject({
      code: 'OAUTH_CALLBACK_MISMATCH',
    });
  });

  it('rejects a callback owner mismatch before exchanging the authorization code', async () => {
    const adapter = new MemoryAdapter();
    const tokenClient = createTokenHttpClient();
    const env = createManagerEnvironment(adapter, tokenClient);
    const authUrl = await env.manager.getAuthUrl({
      userId: 'user-1',
      provider: 'google',
      redirectUri: REDIRECT_URI,
      owner: { kind: 'user', userId: 'user-1', tenantId: 'workspace-1' },
    });
    const state = new URL(authUrl).searchParams.get('state')!;

    await expect(
      env.manager.handleCallback({
        code: 'auth-code-1',
        state,
        expectedOwner: { kind: 'user', userId: 'user-1', tenantId: 'workspace-2' },
        actor: { userId: 'user-1', tenantId: 'workspace-2' },
      })
    ).rejects.toMatchObject({ code: 'TENANT_ACCESS_DENIED' });
    await expect(
      env.manager.handleCallback({
        code: 'auth-code-1',
        state,
        actor: { userId: 'user-2', tenantId: 'workspace-1' },
      })
    ).rejects.toMatchObject({ code: 'TENANT_ACCESS_DENIED' });
    expect(tokenClient.exchangeToken).not.toHaveBeenCalled();

    // The rejected attempts leave the state unconsumed for the owner it was issued to.
    const result = await env.manager.handleCallback({
      code: 'auth-code-1',
      state,
      expectedOwner: { kind: 'user', userId: 'user-1', tenantId: 'workspace-1' },
      actor: { userId: 'user-1', tenantId: 'workspace-1' },
    });
    expect(result.connection).toMatchObject({
      ownerKind: 'user',
      ownerId: 'user-1',
      tenantId: 'workspace-1',
    });
    expect(tokenClient.exchangeToken).toHaveBeenCalledTimes(1);
  });

  it('binds every delegated owner field before exchanging the authorization code', async () => {
    const adapter = new MemoryAdapter();
    const tokenClient = createTokenHttpClient();
    const env = createManagerEnvironment(adapter, tokenClient);
    const owner = {
      kind: 'delegated',
      organizationId: 'org-1',
      delegatedToUserId: 'delegate-a',
      installedByUserId: 'admin-1',
      grants: ['read', 'write'],
      tenantId: 'workspace-1',
    } as const;
    const authUrl = await env.manager.getAuthUrl({
      userId: 'admin-1',
      provider: 'google',
      redirectUri: REDIRECT_URI,
      owner: { ...owner, grants: [...owner.grants] },
    });
    const state = new URL(authUrl).searchParams.get('state')!;

    for (const expectedOwner of [
      { ...owner, grants: [...owner.grants], delegatedToUserId: 'delegate-b' },
      { ...owner, grants: [...owner.grants], installedByUserId: 'admin-2' },
      { ...owner, grants: ['read'] },
      { ...owner, grants: ['read', 'write', 'admin'] },
    ]) {
      await expect(
        env.manager.handleCallback({ code: 'auth-code-1', state, expectedOwner })
      ).rejects.toMatchObject({ code: 'TENANT_ACCESS_DENIED' });
    }
    expect(tokenClient.exchangeToken).not.toHaveBeenCalled();

    // Grants compare as a set, so their order does not matter.
    const result = await env.manager.handleCallback({
      code: 'auth-code-1',
      state,
      expectedOwner: { ...owner, grants: ['write', 'read'] },
      actor: { userId: 'admin-1', tenantId: 'workspace-1', organizationId: 'org-1' },
    });
    expect(result.connection).toMatchObject({
      ownerKind: 'delegated',
      delegatedToUserId: 'delegate-a',
      installedByUserId: 'admin-1',
    });
    expect(tokenClient.exchangeToken).toHaveBeenCalledTimes(1);
  });

  it('rejects a tenant-scoped callback actor for an unscoped owner state', async () => {
    const adapter = new MemoryAdapter();
    const tokenClient = createTokenHttpClient();
    const env = createManagerEnvironment(adapter, tokenClient);
    const authUrl = await env.manager.getAuthUrl({
      userId: 'user-1',
      provider: 'google',
      redirectUri: REDIRECT_URI,
    });
    const state = new URL(authUrl).searchParams.get('state')!;

    await expect(
      env.manager.handleCallback({
        code: 'auth-code-1',
        state,
        actor: { userId: 'user-1', tenantId: 'workspace-1' },
      })
    ).rejects.toMatchObject({ code: 'TENANT_ACCESS_DENIED' });
    expect(tokenClient.exchangeToken).not.toHaveBeenCalled();

    const result = await env.manager.handleCallback({
      code: 'auth-code-1',
      state,
      actor: { userId: 'user-1' },
    });
    expect(result.connection.tenantId).toBeUndefined();
  });

  it('keeps existing token material when refresh fails', async () => {
    const adapter = new MemoryAdapter();
    const tokenClient = createTokenHttpClient({
      refreshError: new Error('refresh failed'),
    });

    const env = createManagerEnvironment(adapter, tokenClient);

    const authUrl = await env.manager.getAuthUrl({
      userId: 'user-1',
      provider: 'google',
      redirectUri: REDIRECT_URI,
    });
    const state = new URL(authUrl).searchParams.get('state');
    expect(state).toBeTruthy();

    const { connection } = await env.manager.handleCallback({
      code: 'auth-code-1',
      state: state!,
      provider: 'google',
      redirectUri: REDIRECT_URI,
    });

    const beforeRefresh = await readTokenRecord(adapter, connection.id);
    expect(beforeRefresh).not.toBeNull();

    await expect(env.manager.refresh(connection.id)).rejects.toMatchObject({
      code: 'INTERNAL_ERROR',
    });

    const afterRefresh = await readTokenRecord(adapter, connection.id);
    expect(afterRefresh?.encrypted_payload).toBe(beforeRefresh?.encrypted_payload);

    const credentials = await env.manager.getCredentials(connection.id);
    expect(credentials.type).toBe('oauth2');
    if (credentials.type === 'oauth2') {
      expect(credentials.accessToken).toBe('access-token-1');
      expect(credentials.refreshToken).toBe('refresh-token-1');
    }
  });

  it('rotates token key and preserves token semantics', async () => {
    const adapter = new MemoryAdapter();
    const tokenClient = createTokenHttpClient();

    const env = createManagerEnvironment(adapter, tokenClient);

    const authUrl = await env.manager.getAuthUrl({
      userId: 'user-1',
      provider: 'google',
      redirectUri: REDIRECT_URI,
    });
    const state = new URL(authUrl).searchParams.get('state');
    expect(state).toBeTruthy();

    const { connection } = await env.manager.handleCallback({
      code: 'auth-code-1',
      state: state!,
      provider: 'google',
      redirectUri: REDIRECT_URI,
    });

    const tokenBefore = await readTokenRecord(adapter, connection.id);
    expect(tokenBefore?.key_ref).toBe('plugfn-key-v1');

    await env.oauthDependencies.encryptedTokenVault.rotateKey(tokenBefore!.token_id, 'plugfn-key-v2');

    const tokenAfter = await readTokenRecord(adapter, connection.id);
    expect(tokenAfter?.key_ref).toBe('plugfn-key-v2');
    expect(tokenAfter?.encrypted_payload).not.toBe(tokenBefore?.encrypted_payload);

    const credentials = await env.manager.getCredentials(connection.id);
    expect(credentials.type).toBe('oauth2');
    if (credentials.type === 'oauth2') {
      expect(credentials.accessToken).toBe('access-token-1');
      expect(credentials.refreshToken).toBe('refresh-token-1');
    }
  });

  it('fails safely when token key reference is unavailable', async () => {
    const adapter = new MemoryAdapter();
    const tokenClient = createTokenHttpClient();

    const env = createManagerEnvironment(adapter, tokenClient);

    const authUrl = await env.manager.getAuthUrl({
      userId: 'user-1',
      provider: 'google',
      redirectUri: REDIRECT_URI,
    });
    const state = new URL(authUrl).searchParams.get('state');
    expect(state).toBeTruthy();

    const { connection } = await env.manager.handleCallback({
      code: 'auth-code-1',
      state: state!,
      provider: 'google',
      redirectUri: REDIRECT_URI,
    });

    const tokenEntry = await readTokenEntryByConnection(adapter, connection.id);
    expect(tokenEntry?.record).toBeTruthy();
    await adapter.update({
      model: DEFAULT_PLUGFN_STORAGE_MODELS.oauthTokens,
      where: [{ field: 'token_id', operator: 'eq', value: tokenEntry!.id }],
      data: {
        key_ref: '',
      },
    });

    await expect(env.manager.getCredentials(connection.id)).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
  });

  it('purges expired OAuth state records through shared state store cleanup', async () => {
    const adapter = new MemoryAdapter();
    const tokenClient = createTokenHttpClient();

    const env = createManagerEnvironment(adapter, tokenClient);

    const authUrl = await env.manager.getAuthUrl({
      userId: 'user-1',
      provider: 'google',
      redirectUri: REDIRECT_URI,
    });
    const state = new URL(authUrl).searchParams.get('state');
    expect(state).toBeTruthy();

    const deleted = await env.oauthDependencies.oauthStateStore.deleteExpired(
      new Date(Date.now() + 20 * 60 * 1000).toISOString()
    );
    expect(deleted).toBe(1);

    await expect(
      env.manager.handleCallback({
        code: 'auth-code-1',
        state: state!,
        provider: 'google',
        redirectUri: REDIRECT_URI,
      })
    ).rejects.toThrow('OAuth state is invalid or expired');
  });

  it('selects connection deterministically by id when priority timestamps are tied', async () => {
    const adapter = new MemoryAdapter();
    const tokenClient = createTokenHttpClient();
    const env = createManagerEnvironment(adapter, tokenClient);
    const tiedAt = new Date('2026-03-11T00:00:00.000Z');

    await adapter.createConnection({
      id: 'conn_b',
      userId: 'user-1',
      provider: 'google',
      name: 'Google B',
      status: ConnectionStatus.Active,
      credentials: {
        encrypted: 'encrypted',
        algorithm: 'aes-256-gcm',
      },
      connectedAt: tiedAt,
      createdAt: tiedAt,
      updatedAt: tiedAt,
      lastUsedAt: tiedAt,
    });
    await adapter.createConnection({
      id: 'conn_a',
      userId: 'user-1',
      provider: 'google',
      name: 'Google A',
      status: ConnectionStatus.Active,
      credentials: {
        encrypted: 'encrypted',
        algorithm: 'aes-256-gcm',
      },
      connectedAt: tiedAt,
      createdAt: tiedAt,
      updatedAt: tiedAt,
      lastUsedAt: tiedAt,
    });

    const selected = await env.manager.resolveConnectionForAction({
      userId: 'user-1',
      provider: 'google',
    });

    expect(selected?.id).toBe('conn_a');
  });

  it('rejects an explicit connection belonging to another provider', async () => {
    const adapter = new MemoryAdapter();
    const env = createManagerEnvironment(adapter, createTokenHttpClient());
    const now = new Date('2026-03-11T00:00:00.000Z');
    await adapter.createConnection({
      id: 'conn_google',
      userId: 'user-1',
      provider: 'google',
      status: ConnectionStatus.Active,
      credentials: { encrypted: 'encrypted', algorithm: 'aes-256-gcm' },
      connectedAt: now,
      createdAt: now,
      updatedAt: now,
    });

    await expect(
      env.manager.resolveConnectionForAction({
        userId: 'user-1',
        provider: 'github',
        connectionId: 'conn_google',
      })
    ).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      message: 'connection provider mismatch',
    });
  });

  it('passes OAuth prompt and loginHint into authorization URLs', async () => {
    const adapter = new MemoryAdapter();
    const tokenClient = createTokenHttpClient();
    const env = createManagerEnvironment(adapter, tokenClient);

    const authUrl = await env.manager.getAuthUrl({
      userId: 'user-1',
      provider: 'google',
      redirectUri: REDIRECT_URI,
      prompt: 'select_account',
      loginHint: 'user@example.com',
    });

    const url = new URL(authUrl);
    expect(url.searchParams.get('prompt')).toBe('select_account');
    expect(url.searchParams.get('login_hint')).toBe('user@example.com');
  });

  it('completes disconnect locally when remote revoke fails after cleanup', async () => {
    const adapter = new MemoryAdapter();
    const tokenClient = createTokenHttpClient({
      revokeError: new Error('upstream revoke failed'),
    });
    const env = createManagerEnvironment(adapter, tokenClient);

    const authUrl = await env.manager.getAuthUrl({
      userId: 'user-1',
      provider: 'google',
      redirectUri: REDIRECT_URI,
    });
    const state = new URL(authUrl).searchParams.get('state');
    expect(state).toBeTruthy();

    const { connection } = await env.manager.handleCallback({
      code: 'auth-code-1',
      state: state!,
      provider: 'google',
      redirectUri: REDIRECT_URI,
    });

    const result = await env.manager.disconnect({
        userId: 'user-1',
        provider: 'google',
        connectionId: connection.id,
      });

    expect(result.disconnected).toBe(true);
    expect(result.remoteRevokeAttempted).toBe(true);
    expect(result.remoteRevokeSucceeded).toBe(false);
    expect(result.localDeleted).toBe(true);
    expect(result.revokeError).toBeDefined();

    await expect(env.manager.get(connection.id)).rejects.toThrow();
    expect(await readTokenRecord(adapter, connection.id)).toBeNull();
  });

  it.each([
    [
      'another user',
      {
        userId: 'attacker',
        provider: 'google',
        actor: { userId: 'attacker', tenantId: 'tenant-1' },
      },
      'TENANT_ACCESS_DENIED',
    ],
    [
      'another provider',
      {
        userId: 'owner',
        provider: 'slack',
        actor: { userId: 'owner', tenantId: 'tenant-1' },
      },
      'VALIDATION_ERROR',
    ],
    [
      'another tenant',
      {
        userId: 'owner',
        provider: 'google',
        actor: { userId: 'owner', tenantId: 'tenant-2' },
      },
      'TENANT_ACCESS_DENIED',
    ],
  ])('rejects disconnecting a connection belonging to %s', async (_label, options, code) => {
    const adapter = new MemoryAdapter();
    const tokenClient = createTokenHttpClient();
    const env = createManagerEnvironment(adapter, tokenClient);
    const now = new Date();
    await adapter.createConnection({
      id: 'conn-protected',
      userId: 'owner',
      provider: 'google',
      tenantId: 'tenant-1',
      ownerKind: 'user',
      ownerId: 'owner',
      status: ConnectionStatus.Active,
      credentials: { encrypted: '{}', algorithm: 'none' },
      connectedAt: now,
      createdAt: now,
      updatedAt: now,
    });

    await expect(
      env.manager.disconnect({ ...options, connectionId: 'conn-protected' })
    ).rejects.toMatchObject({ code });
    await expect(env.manager.get('conn-protected')).resolves.toMatchObject({
      id: 'conn-protected',
    });
    expect(tokenClient.revokeToken).not.toHaveBeenCalled();
  });

  it('rejects disconnect for a delegate with only a sync grant', async () => {
    const adapter = new MemoryAdapter();
    const tokenClient = createTokenHttpClient();
    const env = createManagerEnvironment(adapter, tokenClient);
    const now = new Date();
    await adapter.createConnection({
      id: 'conn-delegated-sync',
      userId: 'installer',
      provider: 'google',
      ownerKind: 'delegated',
      ownerId: 'delegate',
      organizationId: 'org-1',
      installedByUserId: 'installer',
      delegatedToUserId: 'delegate',
      grants: ['sync'],
      tenantId: 'tenant-1',
      status: ConnectionStatus.Active,
      credentials: { encrypted: '{}', algorithm: 'none' },
      connectedAt: now,
      createdAt: now,
      updatedAt: now,
    });

    await expect(
      env.manager.disconnect({
        userId: 'delegate',
        provider: 'google',
        connectionId: 'conn-delegated-sync',
        actor: { userId: 'delegate', tenantId: 'tenant-1' },
      })
    ).rejects.toMatchObject({ code: 'TENANT_ACCESS_DENIED' });
    await expect(env.manager.get('conn-delegated-sync')).resolves.toBeDefined();
    expect(tokenClient.revokeToken).not.toHaveBeenCalled();
  });

  it('resolves a shared connection for an authorized organization action actor', async () => {
    const adapter = new MemoryAdapter();
    const env = createManagerEnvironment(adapter, createTokenHttpClient());
    const now = new Date();
    await adapter.createConnection({
      id: 'conn-org-action',
      userId: 'installer',
      provider: 'google',
      ownerKind: 'organization',
      ownerId: 'org-1',
      organizationId: 'org-1',
      installedByUserId: 'installer',
      tenantId: 'tenant-1',
      status: ConnectionStatus.Active,
      credentials: { encrypted: '{}', algorithm: 'none' },
      connectedAt: now,
      createdAt: now,
      updatedAt: now,
    });

    await expect(
      env.manager.resolveConnectionForAction({
        userId: 'admin',
        provider: 'google',
        connectionId: 'conn-org-action',
        actor: {
          userId: 'admin',
          tenantId: 'tenant-1',
          organizationId: 'org-1',
          roles: ['org:admin'],
        },
      })
    ).resolves.toMatchObject({ id: 'conn-org-action' });
  });

  it('rejects a tenant-mismatched actor for an implicitly selected action connection', async () => {
    const adapter = new MemoryAdapter();
    const env = createManagerEnvironment(adapter, createTokenHttpClient());
    const now = new Date();
    await adapter.createConnection({
      id: 'conn-implicit-tenant',
      userId: 'user-1',
      provider: 'google',
      tenantId: 'tenant-1',
      ownerKind: 'user',
      ownerId: 'user-1',
      status: ConnectionStatus.Active,
      credentials: { encrypted: '{}', algorithm: 'none' },
      connectedAt: now,
      createdAt: now,
      updatedAt: now,
    });

    await expect(
      env.manager.resolveConnectionForAction({
        userId: 'user-1',
        provider: 'google',
        actor: { userId: 'user-1', tenantId: 'tenant-2' },
      })
    ).rejects.toMatchObject({ code: 'TENANT_ACCESS_DENIED' });
  });

  it('applies custom authorization to implicitly selected action connections', async () => {
    const adapter = new MemoryAdapter();
    const authorizeConnection = vi.fn(async () => false);
    const env = createManagerEnvironment(adapter, createTokenHttpClient(), {
      authorizeConnection,
    });
    const now = new Date();
    await adapter.createConnection({
      id: 'conn-implicit-custom',
      userId: 'user-1',
      provider: 'google',
      tenantId: 'tenant-1',
      ownerKind: 'user',
      ownerId: 'user-1',
      status: ConnectionStatus.Active,
      credentials: { encrypted: '{}', algorithm: 'none' },
      connectedAt: now,
      createdAt: now,
      updatedAt: now,
    });

    await expect(
      env.manager.resolveConnectionForAction({
        userId: 'user-1',
        provider: 'google',
        actor: { userId: 'user-1', tenantId: 'tenant-1' },
      })
    ).rejects.toMatchObject({ code: 'TENANT_ACCESS_DENIED' });
    expect(authorizeConnection).toHaveBeenCalledWith(
      expect.objectContaining({ operation: 'action' })
    );
  });

  it('lists organization-owned connections independently of the installer user', async () => {
    const adapter = new MemoryAdapter();
    const env = createManagerEnvironment(adapter, createTokenHttpClient());
    const now = new Date();
    await adapter.createConnection({
      id: 'conn-org-1',
      userId: 'installer-user',
      provider: 'google',
      ownerKind: 'organization',
      ownerId: 'org-1',
      organizationId: 'org-1',
      installedByUserId: 'installer-user',
      tenantId: 'tenant-1',
      status: ConnectionStatus.Active,
      credentials: { encrypted: '{}', algorithm: 'none' },
      connectedAt: now,
      createdAt: now,
      updatedAt: now,
    });
    await adapter.createConnection({
      id: 'conn-org-other-tenant',
      userId: 'other-installer',
      provider: 'google',
      ownerKind: 'organization',
      ownerId: 'org-1',
      organizationId: 'org-1',
      installedByUserId: 'other-installer',
      tenantId: 'tenant-2',
      status: ConnectionStatus.Active,
      credentials: { encrypted: '{}', algorithm: 'none' },
      connectedAt: now,
      createdAt: now,
      updatedAt: now,
    });

    const connections = await env.manager.list({
      userId: 'different-admin',
      provider: 'google',
      owner: {
        kind: 'organization',
        organizationId: 'org-1',
        installedByUserId: 'different-admin',
        tenantId: 'tenant-1',
      },
    });

    expect(connections.map((connection) => connection.id)).toEqual(['conn-org-1']);
  });

  it('creates encrypted API-key connections for an authorized owner', async () => {
    const adapter = new MemoryAdapter();
    const env = createManagerEnvironment(adapter, createTokenHttpClient());
    env.providers.set('linear', createApiKeyProvider());

    const connection = await env.manager.connect({
      userId: 'user-1',
      provider: 'linear',
      credentials: { type: 'api-key', apiKey: 'test-linear-api-key' },
      connectionName: 'Linear workspace',
      owner: { kind: 'user', userId: 'user-1', tenantId: 'workspace-1' },
      actor: { userId: 'user-1', tenantId: 'workspace-1' },
    });

    expect(connection).toMatchObject({
      provider: 'linear',
      ownerKind: 'user',
      ownerId: 'user-1',
      tenantId: 'workspace-1',
      status: ConnectionStatus.Active,
    });
    expect(connection.credentials.encrypted).not.toContain('test-linear-api-key');
    await expect(env.manager.getCredentials(connection.id)).resolves.toEqual({
      type: 'api-key',
      apiKey: 'test-linear-api-key',
    });
  });

  it('rejects direct credentials for OAuth and cross-tenant owners', async () => {
    const adapter = new MemoryAdapter();
    const env = createManagerEnvironment(adapter, createTokenHttpClient());

    await expect(
      env.manager.connect({
        userId: 'user-1',
        provider: 'google',
        credentials: { type: 'api-key', apiKey: 'test-api-key' },
      })
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });

    env.providers.set('linear', createApiKeyProvider());
    await expect(
      env.manager.connect({
        userId: 'user-1',
        provider: 'linear',
        credentials: { type: 'api-key', apiKey: '   ' },
      })
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(
      env.manager.connect({
        userId: 'user-1',
        provider: 'linear',
        credentials: { type: 'api-key', apiKey: 'test-api-key' },
        owner: { kind: 'user', userId: 'user-1', tenantId: 'workspace-1' },
        actor: { userId: 'user-1', tenantId: 'workspace-2' },
      })
    ).rejects.toMatchObject({ code: 'TENANT_ACCESS_DENIED' });
    expect(await adapter.listConnections('user-1', 'linear')).toEqual([]);
  });

  it('scopes a direct connection to the actor tenant when no owner is given', async () => {
    const adapter = new MemoryAdapter();
    const env = createManagerEnvironment(adapter, createTokenHttpClient());
    env.providers.set('linear', createApiKeyProvider());

    const connection = await env.manager.connect({
      userId: 'user-1',
      provider: 'linear',
      credentials: { type: 'api-key', apiKey: 'test-linear-api-key' },
      actor: { userId: 'user-1', tenantId: 'workspace-1' },
    });
    expect(connection).toMatchObject({ ownerKind: 'user', ownerId: 'user-1', tenantId: 'workspace-1' });

    await expect(
      env.manager.connect({
        userId: 'user-1',
        provider: 'linear',
        credentials: { type: 'api-key', apiKey: 'test-linear-api-key' },
        owner: { kind: 'user', userId: 'user-1' },
        actor: { userId: 'user-1', tenantId: 'workspace-1' },
      })
    ).rejects.toMatchObject({ code: 'TENANT_ACCESS_DENIED' });
    expect(await adapter.listConnections('user-1', 'linear')).toHaveLength(1);
  });

  it.each([
    ['missing credentials', 'linear', undefined],
    ['a non-string API key', 'linear', { type: 'api-key', apiKey: 12345 }],
    ['a non-string JWT token', 'jwt-service', { type: 'jwt', token: { value: 'test-token' } }],
    ['a non-string Basic username', 'basic-service', { type: 'basic', username: 7, password: 'test-password' }],
    ['a non-string Basic password', 'basic-service', { type: 'basic', username: 'test-user', password: 12345 }],
  ])('rejects %s with a validation error before storing', async (_label, provider, credentials) => {
    const adapter = new MemoryAdapter();
    const env = createManagerEnvironment(adapter, createTokenHttpClient());
    env.providers.set('linear', createApiKeyProvider());
    env.providers.set('jwt-service', { ...createApiKeyProvider(), name: 'jwt-service', auth: { type: AuthType.JWT, config: {} } } as Provider);
    env.providers.set('basic-service', { ...createApiKeyProvider(), name: 'basic-service', auth: { type: AuthType.Basic, config: {} } } as Provider);

    await expect(
      env.manager.connect({ userId: 'user-1', provider, credentials: credentials as any })
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR', status: 400 });
    expect(await adapter.listConnections('user-1', provider)).toEqual([]);
  });

  it.each([
    ['JWT', 'jwt-service', AuthType.JWT, { type: 'jwt', token: 'test-service-token' }],
    ['Basic', 'basic-service', AuthType.Basic, { type: 'basic', username: 'test-user', password: 'test-password' }],
  ] as const)('round-trips valid %s credentials through encrypted storage', async (_label, provider, authType, credentials) => {
    const adapter = new MemoryAdapter();
    const env = createManagerEnvironment(adapter, createTokenHttpClient());
    env.providers.set(provider, { ...createApiKeyProvider(), name: provider, auth: { type: authType, config: {} } } as Provider);

    const connection = await env.manager.connect({ userId: 'user-1', provider, credentials: { ...credentials } });
    await expect(env.manager.getCredentials(connection.id)).resolves.toEqual(credentials);
  });

  it('stores only the validated values of a credential object with prototype getters', async () => {
    const adapter = new MemoryAdapter();
    const env = createManagerEnvironment(adapter, createTokenHttpClient());
    env.providers.set('basic-service', { ...createApiKeyProvider(), name: 'basic-service', auth: { type: AuthType.Basic, config: {} } } as Provider);
    class BasicCredentialSource {
      readonly type = 'basic';
      readonly extra = 'not-a-credential-field';
      get username() { return 'test-user'; }
      get password() { return 'test-password'; }
    }

    const connection = await env.manager.connect({
      userId: 'user-1',
      provider: 'basic-service',
      credentials: new BasicCredentialSource() as any,
    });
    await expect(env.manager.getCredentials(connection.id)).resolves.toEqual({
      type: 'basic',
      username: 'test-user',
      password: 'test-password',
    });
  });

  it('stores the validated values of a credential object with a custom toJSON', async () => {
    const adapter = new MemoryAdapter();
    const env = createManagerEnvironment(adapter, createTokenHttpClient());
    env.providers.set('linear', createApiKeyProvider());
    const credentials = {
      type: 'api-key' as const,
      apiKey: 'test-linear-api-key',
      toJSON: () => ({ type: 'api-key', apiKey: 'test-replaced-api-key' }),
    };

    const connection = await env.manager.connect({ userId: 'user-1', provider: 'linear', credentials });
    await expect(env.manager.getCredentials(connection.id)).resolves.toEqual({
      type: 'api-key',
      apiKey: 'test-linear-api-key',
    });
  });

  it.each([
    ['an organization owner without organizationId', { kind: 'organization', installedByUserId: 'user-1' }],
    ['a delegated owner without grants', {
      kind: 'delegated',
      organizationId: 'org-1',
      delegatedToUserId: 'delegate-a',
      installedByUserId: 'user-1',
    }],
  ])('rejects %s on connect with a validation error before storing', async (_label, owner) => {
    const adapter = new MemoryAdapter();
    const env = createManagerEnvironment(adapter, createTokenHttpClient());
    env.providers.set('linear', createApiKeyProvider());

    await expect(
      env.manager.connect({
        userId: 'user-1',
        provider: 'linear',
        credentials: { type: 'api-key', apiKey: 'test-linear-api-key' },
        owner: owner as any,
        actor: { userId: 'user-1', organizationId: 'org-1' },
      })
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR', status: 400 });
    expect(await adapter.listConnections('user-1', 'linear')).toEqual([]);
  });

  it.each([
    ['an organization owner without organizationId', { kind: 'organization', installedByUserId: 'admin-1' }],
    ['a delegated owner without grants', {
      kind: 'delegated',
      organizationId: 'org-1',
      delegatedToUserId: 'delegate-a',
      installedByUserId: 'admin-1',
    }],
  ])('rejects %s as expectedOwner before the code exchange and keeps the state', async (_label, expectedOwner) => {
    const adapter = new MemoryAdapter();
    const tokenClient = createTokenHttpClient();
    const env = createManagerEnvironment(adapter, tokenClient);
    const owner = { kind: 'organization', organizationId: 'org-1', installedByUserId: 'admin-1' } as const;
    const authUrl = await env.manager.getAuthUrl({
      userId: 'admin-1',
      provider: 'google',
      redirectUri: REDIRECT_URI,
      owner,
    });
    const state = new URL(authUrl).searchParams.get('state')!;

    await expect(
      env.manager.handleCallback({ code: 'auth-code-1', state, expectedOwner: expectedOwner as any })
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR', status: 400 });
    expect(tokenClient.exchangeToken).not.toHaveBeenCalled();

    const result = await env.manager.handleCallback({ code: 'auth-code-1', state, expectedOwner: owner });
    expect(result.connection).toMatchObject({ ownerKind: 'organization', ownerId: 'org-1' });
  });
});

function createManagerEnvironment(
  adapter: MemoryAdapter,
  tokenClient: OAuthTokenHttpClient,
  options: {
    authorizeConnection?: (input: any) => boolean | Promise<boolean>;
  } = {}
) {
  const providers = new Map<string, Provider>([['google', createGoogleProvider()]]);
  const integrationConfigs = new Map<string, any>([
    [
      'google',
      {
        type: 'oauth2',
        clientId: 'google-client-id',
        clientSecret: 'google-client-secret',
        redirectUris: [REDIRECT_URI],
      },
    ],
  ]);

  const oauthDependencies = createConnectionManagerOAuthDependencies({
    database: adapter,
    providers,
    integrationConfigs,
    baseUrl: BASE_URL,
    encryptionKey: ENCRYPTION_KEY,
    tokenHttpClient: tokenClient,
  });

  const manager = new ConnectionManager(
    new AdapterConnectionStorage(adapter),
    providers,
    integrationConfigs,
    BASE_URL,
    ENCRYPTION_KEY,
    new NoopLogger(),
    oauthDependencies,
    options.authorizeConnection
  );

  return {
    manager,
    oauthDependencies,
    providers,
  };
}

function createApiKeyProvider(): Provider {
  return {
    name: 'linear',
    displayName: 'Linear',
    version: '1.0.0',
    description: 'Linear API-key provider',
    baseUrl: 'https://api.linear.app',
    auth: { type: AuthType.ApiKey, config: { headerName: 'Authorization' } },
    actions: {},
  };
}

function createGoogleProvider(): Provider {
  return {
    name: 'google',
    displayName: 'Google',
    version: '1.0.0',
    description: 'Google OAuth provider',
    baseUrl: 'https://www.googleapis.com',
    auth: {
      type: AuthType.OAuth2,
      config: {
        authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
        tokenUrl: 'https://oauth2.googleapis.com/token',
        scopes: ['openid', 'email', 'profile'],
        scopeSeparator: ' ',
      },
    },
    actions: {},
  };
}

function createTokenHttpClient(options?: { refreshError?: Error; revokeError?: Error }): OAuthTokenHttpClient {
  return {
    exchangeToken: vi.fn(async (input: OAuthTokenEndpointRequest) => {
      if (input.grantType === 'authorization_code') {
        return {
          accessToken: 'access-token-1',
          refreshToken: 'refresh-token-1',
          expiresIn: 3600,
          tokenType: 'Bearer',
          scope: 'openid email profile',
        };
      }

      if (input.grantType === 'refresh_token') {
        if (options?.refreshError) {
          throw options.refreshError;
        }

        return {
          accessToken: 'access-token-2',
          refreshToken: 'refresh-token-2',
          expiresIn: 3600,
          tokenType: 'Bearer',
          scope: 'openid email profile',
        };
      }

      throw new Error(`Unsupported grant type: ${input.grantType}`);
    }),
    revokeToken: vi.fn(async () => {
      if (options?.revokeError) {
        throw options.revokeError;
      }
    }),
  };
}

async function readTokenRecord(adapter: MemoryAdapter, connectionId: string): Promise<any | null> {
  const tokenEntry = await readTokenEntryByConnection(adapter, connectionId);
  return tokenEntry?.record ?? null;
}

async function readTokenEntryByConnection(
  adapter: MemoryAdapter,
  connectionId: string
): Promise<{ id: string; record: any } | null> {
  const record = await adapter.findOne<any>({
    model: DEFAULT_PLUGFN_STORAGE_MODELS.oauthTokens,
    where: [{ field: 'connection_id', operator: 'eq', value: connectionId }],
  });
  if (!record) {
    return null;
  }

  return {
    id: record.token_id,
    record,
  };
}

// SFNS-107 architecture reset: connect() and handleCallback() read every
// caller-supplied authorization input once, before the first await, so a
// change to the caller's objects later cannot alter the decision or the
// stored owner.
describe('ConnectionManager caller input snapshots', () => {
  const delegated = {
    kind: 'delegated',
    organizationId: 'org-1',
    delegatedToUserId: 'delegate-a',
    installedByUserId: 'admin-1',
    grants: ['read', 'write'],
    tenantId: 'workspace-1',
  } as const;

  async function pendingDelegatedState() {
    const adapter = new MemoryAdapter();
    const tokenClient = createTokenHttpClient();
    const env = createManagerEnvironment(adapter, tokenClient);
    const authUrl = await env.manager.getAuthUrl({
      userId: 'admin-1',
      provider: 'google',
      redirectUri: REDIRECT_URI,
      owner: { ...delegated, grants: [...delegated.grants] },
    });
    const state = new URL(authUrl).searchParams.get('state')!;
    const stateStore = (env.manager as any).oauthStateStore;
    const originalGet = stateStore.get.bind(stateStore);
    const duringStateLookup = (mutate: () => void) => {
      vi.spyOn(stateStore, 'get').mockImplementation(async (...args: unknown[]) => {
        const result = await originalGet(...args);
        mutate();
        return result;
      });
    };
    return { env, tokenClient, state, duringStateLookup };
  }

  it('decides the callback on expectedOwner grants as passed, not as changed during the state lookup', async () => {
    const { env, tokenClient, state, duringStateLookup } = await pendingDelegatedState();
    const expectedOwner = { ...delegated, grants: ['read'] };
    duringStateLookup(() => { expectedOwner.grants.push('write'); });

    await expect(
      env.manager.handleCallback({ code: 'auth-code-1', state, expectedOwner })
    ).rejects.toMatchObject({ code: 'TENANT_ACCESS_DENIED' });
    expect(tokenClient.exchangeToken).not.toHaveBeenCalled();
  });

  it('decides the callback on the expectedOwner delegate as passed', async () => {
    const { env, tokenClient, state, duringStateLookup } = await pendingDelegatedState();
    const expectedOwner: Record<string, unknown> = { ...delegated, grants: [...delegated.grants], delegatedToUserId: 'delegate-b' };
    duringStateLookup(() => { expectedOwner.delegatedToUserId = 'delegate-a'; });

    await expect(
      env.manager.handleCallback({ code: 'auth-code-1', state, expectedOwner: expectedOwner as any })
    ).rejects.toMatchObject({ code: 'TENANT_ACCESS_DENIED' });
    expect(tokenClient.exchangeToken).not.toHaveBeenCalled();
  });

  it('decides the callback on the actor tenant as passed', async () => {
    const { env, tokenClient, state, duringStateLookup } = await pendingDelegatedState();
    const actor = { userId: 'admin-1', tenantId: 'workspace-2', organizationId: 'org-1' };
    duringStateLookup(() => { actor.tenantId = 'workspace-1'; });

    await expect(
      env.manager.handleCallback({ code: 'auth-code-1', state, actor })
    ).rejects.toMatchObject({ code: 'TENANT_ACCESS_DENIED' });
    expect(tokenClient.exchangeToken).not.toHaveBeenCalled();
  });

  it('completes a matching callback even when the caller objects change during the state lookup', async () => {
    const { env, tokenClient, state, duringStateLookup } = await pendingDelegatedState();
    const expectedOwner = { ...delegated, grants: ['read', 'write'] };
    const actor = { userId: 'admin-1', tenantId: 'workspace-1', organizationId: 'org-1' };
    duringStateLookup(() => {
      expectedOwner.grants.push('admin');
      actor.tenantId = 'workspace-2';
    });

    const result = await env.manager.handleCallback({ code: 'auth-code-1', state, expectedOwner, actor });
    expect(result.connection).toMatchObject({ ownerKind: 'delegated', delegatedToUserId: 'delegate-a' });
    expect(tokenClient.exchangeToken).toHaveBeenCalledTimes(1);
  });

  it('authorizes and stores a direct connection owner from a single read of each field', async () => {
    const adapter = new MemoryAdapter();
    const env = createManagerEnvironment(adapter, createTokenHttpClient());
    env.providers.set('linear', createApiKeyProvider());
    let organizationReads = 0;
    const owner = {
      kind: 'organization',
      installedByUserId: 'admin-1',
      get organizationId() {
        organizationReads += 1;
        return organizationReads === 1 ? 'org-1' : 'org-other';
      },
    };

    const connection = await env.manager.connect({
      userId: 'admin-1',
      provider: 'linear',
      credentials: { type: 'api-key', apiKey: 'test-linear-api-key' },
      owner: owner as any,
      actor: { userId: 'admin-1', organizationId: 'org-1' },
    });

    expect(organizationReads).toBe(1);
    expect(connection).toMatchObject({ ownerKind: 'organization', ownerId: 'org-1', organizationId: 'org-1' });
  });

  it('rejects a malformed actor with VALIDATION_ERROR before anything is stored', async () => {
    const adapter = new MemoryAdapter();
    const env = createManagerEnvironment(adapter, createTokenHttpClient());
    env.providers.set('linear', createApiKeyProvider());

    await expect(
      env.manager.connect({
        userId: 'user-1',
        provider: 'linear',
        credentials: { type: 'api-key', apiKey: 'test-linear-api-key' },
        actor: { userId: 'user-1', grants: 'read' } as any,
      })
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR', status: 400 });
    expect(await adapter.listConnections('user-1', 'linear')).toEqual([]);
  });
});

// SFNS-107 architecture reset: a connection is created only for the exact
// OAuth state that passed authorization. If oauth-flow consumes a state whose
// subject differs from the previewed one, the callback fails before any
// connection write and the pending token record is removed.
describe('ConnectionManager OAuth callback subject binding', () => {
  const owner = {
    kind: 'delegated',
    organizationId: 'org-1',
    delegatedToUserId: 'delegate-a',
    installedByUserId: 'admin-1',
    grants: ['read', 'write'],
    tenantId: 'workspace-1',
  } as const;

  async function pendingState(replace?: (subject: Record<string, unknown>) => Record<string, unknown>) {
    const adapter = new MemoryAdapter();
    const env = createManagerEnvironment(adapter, createTokenHttpClient());
    const authUrl = await env.manager.getAuthUrl({
      userId: 'admin-1',
      provider: 'google',
      redirectUri: REDIRECT_URI,
      owner: { ...owner, grants: [...owner.grants] },
      scopes: ['scope-a', 'scope-b'],
    });
    const state = new URL(authUrl).searchParams.get('state')!;
    const flow = (env.manager as any).oauthFlowService;
    const consumed: { connectionId?: string } = {};
    const originalCallback = flow.handleCallback.bind(flow);
    vi.spyOn(flow, 'handleCallback').mockImplementation(async (...args: unknown[]) => {
      const result = await originalCallback(...args);
      consumed.connectionId = result.connectionId;
      // Model a state row that was replaced between the preview and consume.
      return replace ? { ...result, subject: replace({ ...result.subject }) } : result;
    });
    const storage = (env.manager as any).connectionStorage;
    const create = vi.spyOn(storage, 'create');
    return { env, adapter, state, consumed, create };
  }

  it.each([
    ['another user', (subject: Record<string, unknown>) => ({ ...subject, userId: 'intruder-1' })],
    ['another tenant', (subject: Record<string, unknown>) => ({ ...subject, tenantId: 'workspace-2' })],
    ['no tenant', (subject: Record<string, unknown>) => ({ ...subject, tenantId: undefined })],
    ['a browser-auth subject', (subject: Record<string, unknown>) => ({ ...subject, kind: 'browser-auth' })],
  ])('rejects a consumed state for %s before any connection write', async (_label, replace) => {
    const { env, adapter, state, consumed, create } = await pendingState(replace);

    await expect(env.manager.handleCallback({ code: 'auth-code-1', state })).rejects.toMatchObject({
      code: 'TENANT_ACCESS_DENIED',
      message: 'OAuth state changed during callback',
    });
    expect(create).not.toHaveBeenCalled();
    expect(consumed.connectionId).toBeTruthy();
    expect(await readTokenEntryByConnection(adapter, consumed.connectionId!)).toBeNull();
  });

  it('creates a matching callback with the previewed user, owner and fallback scopes', async () => {
    const { env, adapter, state, consumed, create } = await pendingState();

    const { connection } = await env.manager.handleCallback({ code: 'auth-code-1', state });
    expect(create).toHaveBeenCalledTimes(1);
    expect(connection).toMatchObject({
      userId: 'admin-1',
      ownerKind: 'delegated',
      organizationId: 'org-1',
      delegatedToUserId: 'delegate-a',
      tenantId: 'workspace-1',
    });
    expect(await readTokenEntryByConnection(adapter, connection.id)).not.toBeNull();
    expect(consumed.connectionId).toBeTruthy();
  });
});

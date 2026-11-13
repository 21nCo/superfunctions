import { describe, expect, it } from 'vitest';
import { authFnApiKeyPlugin } from '@authfn/api-keys';
import { authFnPasswordPlugin } from '@authfn/password';
import { wrapWithRowLevelNamespace } from '../../../../packages/db/src/adapter/row-level-namespace.js';
import { memoryAdapter } from '../../../../packages/db/src/testing/index.js';
import type { AuthFnRuntimeConfig, AuthFnServer, AuthFnSession } from '../index.js';
import {
  authenticateApiKey,
  createApiKey,
  findApiKeyById,
  revokeApiKeyById
} from '../core/api-keys.js';
import { issueSession } from '../core/sessions.js';
import { createUser, findUserById } from '../core/users.js';
import { createTestServer } from './test-server.js';

const NOW = new Date('2026-11-13T00:00:00.000Z');

function createConfig(overrides: Partial<AuthFnRuntimeConfig> = {}): AuthFnRuntimeConfig {
  return {
    database: memoryAdapter({ debug: false }),
    namespace: 'authfn',
    scopes: { memotron: ['read', 'write'] },
    plugins: [authFnApiKeyPlugin(), authFnPasswordPlugin()],
    ...overrides
  };
}

function bearer(secret: string, init: RequestInit = {}, path = '/auth/session'): Request {
  return new Request(`https://account.example.com${path}`, {
    ...init,
    headers: { ...(init.headers as Record<string, string> | undefined), authorization: `Bearer ${secret}` }
  });
}

async function setUserMetadata(
  config: AuthFnRuntimeConfig,
  userId: string,
  metadata: Record<string, unknown>
): Promise<void> {
  await config.database.update({
    model: 'users',
    where: [{ field: 'id', operator: 'eq', value: userId }],
    data: { metadata },
    namespace: 'authfn'
  });
}

/**
 * A host that stores records under the authenticated actor's ID and serves
 * them only to user actors, the way Memotron/Pointron key data by `actorId`.
 */
function createNotesHost(auth: AuthFnServer) {
  const notesByActor = new Map<string, string[]>();
  async function actor(request: Request): Promise<AuthFnSession | Response> {
    const session = await auth.provider.authenticate(request);
    if (!session || session.actorType !== 'user') {
      return Response.json({ error: 'unauthorized' }, { status: 401 });
    }
    return session;
  }
  return {
    async write(request: Request, note: string): Promise<Response> {
      const session = await actor(request);
      if (session instanceof Response) return session;
      notesByActor.set(session.actorId, [...(notesByActor.get(session.actorId) ?? []), note]);
      return Response.json({ ok: true });
    },
    async read(request: Request): Promise<Response> {
      const session = await actor(request);
      if (session instanceof Response) return session;
      return Response.json({ notes: notesByActor.get(session.actorId) ?? [] });
    }
  };
}

describe('AUTH-5: API-key sessions act as their owning user', () => {
  it('authenticates an owned key as its owner with the key as the credential', async () => {
    const config = createConfig();
    const owner = await createUser(config, { primaryEmail: 'owner@example.com' });
    const key = await createApiKey(config, {
      userId: owner.id,
      name: 'cli',
      scopes: ['memotron:read'],
      // Caller-supplied metadata cannot redirect the actor or forge the owner.
      metadata: { ownerUserId: 'forged-user', actorId: 'forged-user', client: 'cli' }
    });

    const session = await authenticateApiKey(config, key.secret, { now: () => NOW });

    expect(session).toEqual({
      id: key.keyId,
      type: 'api-key',
      actorType: 'user',
      actorId: owner.id,
      subject: { actorType: 'user', actorId: owner.id },
      credential: { type: 'api-key', id: key.keyId },
      resourceIds: [],
      methods: ['api-key'],
      scopes: ['memotron:read'],
      expiresAt: undefined,
      metadata: {
        actorId: 'forged-user',
        client: 'cli',
        ownerUserId: owner.id,
        scopes: ['memotron:read']
      }
    });
    expect((await findApiKeyById(config, key.keyId))?.lastUsedAt).toEqual(NOW);
  });

  it('lets a host that namespaces by actorId read the owner records with the key', async () => {
    const config = createConfig();
    const auth = createTestServer(config);
    const host = createNotesHost(auth);
    const owner = await createUser(config, { primaryEmail: 'owner@example.com' });
    const other = await createUser(config, { primaryEmail: 'other@example.com' });
    const ownerSession = await issueSession(config, {}, { userId: owner.id, methods: ['password'] });
    const otherSession = await issueSession(config, {}, { userId: other.id, methods: ['password'] });
    expect((await host.write(bearer(ownerSession.sessionToken), 'owner note')).status).toBe(200);
    expect((await host.write(bearer(otherSession.sessionToken), 'other note')).status).toBe(200);

    const ownerKey = await createApiKey(config, { userId: owner.id, name: 'cli' });
    const ownerRead = await host.read(bearer(ownerKey.secret));
    expect(ownerRead.status).toBe(200);
    expect(await ownerRead.json()).toEqual({ notes: ['owner note'] });

    const otherKey = await createApiKey(config, { userId: other.id, name: 'cli' });
    expect(await (await host.read(bearer(otherKey.secret))).json()).toEqual({ notes: ['other note'] });

    // An unowned service key keeps its key actor and is rejected by user-scoped routes.
    const serviceKey = await createApiKey(config, { userId: null, name: 'worker' });
    expect(await auth.provider.authenticate(bearer(serviceKey.secret))).toMatchObject({
      type: 'api-key',
      actorType: 'api-key',
      actorId: serviceKey.keyId,
      subject: { actorType: 'api-key', actorId: serviceKey.keyId },
      credential: { type: 'api-key', id: serviceKey.keyId },
      metadata: { ownerUserId: undefined, scopes: [] }
    });
    expect((await host.read(bearer(serviceKey.secret))).status).toBe(401);
  });

  it('rejects a revoked owned key', async () => {
    const config = createConfig();
    const auth = createTestServer(config);
    const host = createNotesHost(auth);
    const owner = await createUser(config, { primaryEmail: 'owner@example.com' });
    const key = await createApiKey(config, { userId: owner.id, name: 'cli' });
    await revokeApiKeyById(config, key.keyId, { userId: owner.id });

    await expect(host.read(bearer(key.secret))).rejects.toMatchObject({ code: 'AUTHFN_API_KEY_REVOKED' });
    const viaRoute = await auth.router.handle(bearer(key.secret, {}, '/auth/account'));
    expect(viaRoute.status).toBe(401);
    expect((await viaRoute.json()).error.code).toBe('AUTHFN_API_KEY_REVOKED');
  });

  it('rejects an owned key at and after its expiry', async () => {
    const config = createConfig();
    const owner = await createUser(config, { primaryEmail: 'owner@example.com' });
    const expiresAt = new Date(NOW.getTime() + 1_000);
    const key = await createApiKey(config, { userId: owner.id, name: 'cli', expiresAt });

    await expect(authenticateApiKey(config, key.secret, { now: () => NOW })).resolves.toMatchObject({
      actorId: owner.id,
      expiresAt
    });
    await expect(authenticateApiKey(config, key.secret, { now: () => expiresAt })).resolves.toBeNull();
  });

  it('authenticates a key whose owner is disabled as no one until the owner is re-enabled', async () => {
    const config = createConfig();
    const auth = createTestServer(config);
    const host = createNotesHost(auth);
    const owner = await createUser(config, { primaryEmail: 'owner@example.com', metadata: { plan: 'pro' } });
    const key = await createApiKey(config, { userId: owner.id, name: 'cli' });

    await setUserMetadata(config, owner.id, { plan: 'pro', disabled: true });
    await expect(authenticateApiKey(config, key.secret, { now: () => NOW })).resolves.toBeNull();
    expect((await host.read(bearer(key.secret))).status).toBe(401);
    // A rejected attempt does not record use of the key.
    expect((await findApiKeyById(config, key.keyId))?.lastUsedAt).toBeNull();

    await setUserMetadata(config, owner.id, { plan: 'pro', disabled: false });
    await expect(authenticateApiKey(config, key.secret)).resolves.toMatchObject({ actorId: owner.id });
  });

  it('authenticates a key whose owner was deleted as no one, even if the key row survives', async () => {
    const config = createConfig();
    const owner = await createUser(config, { primaryEmail: 'owner@example.com' });
    const key = await createApiKey(config, { userId: owner.id, name: 'cli' });

    // Account deletion is not transactional; simulate a user removed before its keys.
    await config.database.delete({
      model: 'users',
      where: [{ field: 'id', operator: 'eq', value: owner.id }],
      namespace: 'authfn'
    });
    expect(await findUserById(config, owner.id)).toBeNull();
    expect(await findApiKeyById(config, key.keyId)).not.toBeNull();

    await expect(authenticateApiKey(config, key.secret, { now: () => NOW })).resolves.toBeNull();
    expect((await findApiKeyById(config, key.keyId))?.lastUsedAt).toBeNull();
  });

  it('does not authenticate a key from another tenant or one whose owner lives in another tenant', async () => {
    // Tenants share one store and are isolated by AuthFn's namespace.
    const database = wrapWithRowLevelNamespace(memoryAdapter({ debug: false }), {
      enabled: true,
      columnName: '__ns',
      mandatory: true
    });
    const tenantA = createConfig({ database, namespace: 'tenant-a' });
    const tenantB = createConfig({ database, namespace: 'tenant-b' });
    const ownerB = await createUser(tenantB, { id: 'user_shared', primaryEmail: 'b@example.com' });
    const keyB = await createApiKey(tenantB, { userId: ownerB.id, name: 'b-cli' });

    await expect(authenticateApiKey(tenantB, keyB.secret)).resolves.toMatchObject({ actorId: ownerB.id });
    await expect(authenticateApiKey(tenantA, keyB.secret)).resolves.toBeNull();

    // A tenant-A key naming a user ID that exists only in tenant B has no owner in tenant A.
    const crossOwnerKey = await createApiKey(tenantA, { userId: ownerB.id, name: 'cross' });
    await expect(authenticateApiKey(tenantA, crossOwnerKey.secret)).resolves.toBeNull();
  });

  it('keeps account management and password linking closed to an owned key', async () => {
    const config = createConfig({ accountLinking: { passwordForAuthenticatedUser: true } });
    const auth = createTestServer(config);
    const owner = await createUser(config, {
      primaryEmail: 'owner@example.com',
      emailVerifiedAt: NOW
    });
    const key = await createApiKey(config, { userId: owner.id, name: 'cli' });

    const session = await auth.router.handle(bearer(key.secret));
    expect((await session.json()).data.session).toBeNull();
    expect((await auth.router.handle(bearer(key.secret, {}, '/auth/account'))).status).toBe(401);
    const deletion = await auth.router.handle(bearer(key.secret, { method: 'DELETE' }, '/auth/account'));
    expect(deletion.status).toBe(401);
    expect(await findUserById(config, owner.id)).not.toBeNull();

    const linking = await auth.router.handle(bearer(key.secret, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'owner@example.com', password: 'Sup3rSecurePassphrase!' })
    }, '/auth/sign-up/password'));
    expect(linking.status).toBe(409);
    expect((await linking.json()).error.details.linking.required).toBe('authenticated-session');
    const credential = await config.database.findOne({
      model: 'password_credentials',
      where: [{ field: 'userId', operator: 'eq', value: owner.id }],
      namespace: 'authfn'
    });
    expect(credential).toBeNull();
  });
});

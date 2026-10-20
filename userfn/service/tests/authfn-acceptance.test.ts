import { it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { Kysely, SqliteDialect } from 'kysely';
import { kyselyAdapter } from '@superfunctions/db/adapters';
import { memoryAdapter } from '@superfunctions/db/adapters/memory';
import { wrapWithSchema } from '@superfunctions/db';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { authfn } from '../../../authfn/core/src/index.js';
import { authFnApiKeyPlugin } from '../../../authfn/api-keys/src/index.js';
import { createUser } from '../../../authfn/core/src/core/users.js';
import { issueSession } from '../../../authfn/core/src/core/sessions.js';
import { issueSessionCookies } from '../../../authfn/core/src/core/cookies.js';
import { createUserFnService, getUserFnSchema } from '../src/index.js';

it('accepts actual AuthFn-issued keys, preserves tenant/actor authority, and rejects revoked credentials', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'userfn-authfn-'));
  const connect = () => {
    const sql = new Kysely<any>({ dialect: new SqliteDialect({ database: new Database(join(directory, 'feedback.sqlite')) }) });
    return { sql, adapter: kyselyAdapter({ db: sql, dialect: 'sqlite', schema: { userfn_feedback: 'userfn_feedback' } }) };
  };
  let { sql, adapter } = connect();
  try {
    let migration = sql.schema.createTable('userfn_feedback');
    for (const [name, field] of Object.entries(getUserFnSchema().userfn_feedback.fields)) {
      migration = migration.addColumn(name, field.type === 'number' ? 'integer' : 'text', column => {
        if (field.required) column = column.notNull();
        if (name === 'id') column = column.primaryKey();
        return column;
      });
    }
    await migration.execute();
    const app = authfn({ plugins: [authFnApiKeyPlugin()] });
    const authDatabase = memoryAdapter(); // Real AuthFn logic, but no claim of durable AuthFn key storage.
    const auth = app.createServer({ database: authDatabase });
    const config = { ...app.config, database: wrapWithSchema(authDatabase, app.getSchema()) };
    const user = await createUser(config, { primaryEmail: 'owner@example.test' });
    const issued = await issueSession(config, {}, {
      request: new Request('https://account.example.test/auth/session'), userId: user.id,
      primaryEmail: user.primaryEmail, methods: ['password'],
    });
    const cookie = Object.values(issueSessionCookies(issued.cookiePolicy!, issued.sessionToken, issued.csrfToken))
      .map(value => value.slice(0, value.indexOf(';'))).join('; ');
    const adminHeaders = { cookie, 'x-authfn-csrf': issued.csrfToken, 'content-type': 'application/json' };
    const mint = async (name: string, scopes = ['userfn:feedback:write', 'userfn:feedback:read']) => {
      const response = await auth.router.handle(new Request('https://account.example.test/auth/api-keys', {
        method: 'POST', headers: adminHeaders,
        body: JSON.stringify({ name, scopes, metadata: { tenantId: 'untrusted-metadata-tenant' } }),
      }));
      expect(response.status).toBe(201);
      return (await response.json()).data as { keyId: string; secret: string };
    };
    const keyA = await mint('tenant-a');
    const keyB = await mint('tenant-b');
    const readOnly = await mint('read-only', ['userfn:feedback:read']);
    const unmapped = await mint('no-tenant');
    const bindings = new Map([[keyA.keyId, 'tenant-a'], [keyB.keyId, 'tenant-b'], [readOnly.keyId, 'tenant-a']]);
    const resolveAccess = async (session: import('@superfunctions/auth').AuthSession) => {
      const tenantId = bindings.get(session.subject.actorId);
      return tenantId ? { tenantId, scopes: session.metadata.scopes } : null;
    };
    let service = createUserFnService({ database: adapter, auth: auth.provider, resolveAccess });
    const payload = { feedback: { title: 'Actual key', body: 'Stored from AuthFn', category: 'general' }, context: { source: 'in_app', user: { id: 'pretend-admin', traits: { tenantId: 'tenant-b', scopes: ['*'] } } } };
    const post = (secret: string, body = payload, key = 'stable') => service.router.handle(new Request('https://feedback.example.test/feedback', {
      method: 'POST', headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json', 'idempotency-key': key, 'x-tenant-id': 'tenant-b', 'x-actor-id': 'pretend-admin', cookie },
      body: JSON.stringify(body),
    }));
    const created = await post(keyA.secret);
    expect(created.status).toBe(201);
    const { id } = await created.json();
    const get = (secret: string) => service.router.handle(new Request(`https://feedback.example.test/feedback/${id}`, { headers: { authorization: `Bearer ${secret}` } }));
    expect(await (await get(keyA.secret)).json()).toMatchObject({ tenantId: 'tenant-a', actorId: keyA.keyId, payload });
    expect((await get(keyB.secret)).status).toBe(404);
    expect((await post(keyB.secret)).status).toBe(201); // Same key is separate within another tenant.
    expect((await post(readOnly.secret)).status).toBe(403);
    expect((await post(unmapped.secret)).status).toBe(403);
    expect((await post('invalid-token')).status).toBe(401);
    expect((await post(keyA.secret, { ...payload, tenantId: 'tenant-b' } as typeof payload)).status).toBe(400);
    const storedKey = await config.database.findOne<any>({ model: 'api_keys', where: [{ field: 'id', operator: 'eq', value: keyA.keyId }], namespace: 'authfn' });
    expect(storedKey.secretHash).not.toBe(keyA.secret);
    expect(storedKey.lastUsedAt).toBeInstanceOf(Date);

    // Recreate only UserFn's SQLite connection/service. AuthFn's memory store deliberately stays live.
    await adapter.close();
    ({ sql, adapter } = connect());
    service = createUserFnService({ database: adapter, auth: auth.provider, resolveAccess });
    expect((await get(keyA.secret)).status).toBe(200);
    expect((await post(keyA.secret)).status).toBe(200);
    const revoked = await auth.router.handle(new Request(`https://account.example.test/auth/api-keys/${keyA.keyId}`, { method: 'DELETE', headers: adminHeaders }));
    expect(revoked.status).toBe(200);
    expect((await revoked.json()).data.revoked).toBe(true);
    expect((await post(keyA.secret, payload, 'after-revocation')).status).toBe(401);
    expect((await get(keyA.secret)).status).toBe(401);
    expect((await post(keyB.secret)).status).toBe(200);
    expect(await adapter.count({ model: 'userfn_feedback' })).toBe(2);
  } finally {
    await adapter.close();
    await rm(directory, { recursive: true, force: true });
  }
});

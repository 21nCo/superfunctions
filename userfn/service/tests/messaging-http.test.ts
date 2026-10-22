import { it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { Kysely, SqliteDialect } from 'kysely';
import { kyselyAdapter } from '@superfunctions/db/adapters';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AuthProvider, AuthSession } from '@superfunctions/auth';
import { createUserFnService, getUserFnSchema } from '../src/index.js';

it('enforces verified user/session caps under concurrent HTTP requests and reconciles SQLite restart receipts', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'userfn-messages-'));
  const connect = () => {
    const native = new Database(join(directory, 'state.sqlite')); native.pragma('busy_timeout = 0');
    const sql = new Kysely<Record<string, never>>({ dialect: new SqliteDialect({ database: native }) });
    const adapter = kyselyAdapter({ db: sql, dialect: 'sqlite', schema: Object.fromEntries(Object.keys(getUserFnSchema()).map(key => [key, key])) });
    return { sql, adapter };
  };
  let { sql, adapter } = connect();
  let secondary = connect().adapter;
  const auth: AuthProvider = { async authenticate(request) {
    const token = request.headers.get('authorization')?.replace('Bearer ', '');
    if (!token || token === 'bad') return null;
    const [tenantId, actorId, appSession] = token.split(':');
    return { id: actorId, type: 'session', subject: { tenantId, actorId, actorType: 'user' }, scopes: ['userfn:messages:write'], metadata: { appSession } };
  } };
  const retired = new Set<string>();
  const options = { auth, messaging: { resolveSession: (session: AuthSession) => session.metadata.appSession as string,
    resolvePolicy: (_session: AuthSession, campaign: string) => campaign === 'missing' || retired.has(campaign) ? null : ({ enabled: campaign !== 'disabled', perUser: campaign === 'zero' ? 0 : 3, perSession: 2 }) } };
  let services = [createUserFnService({ database: adapter, ...options }), createUserFnService({ database: secondary, ...options })];
  let next = 0;
  const server = createServer(async (incoming, outgoing) => {
    try {
      const chunks: Buffer[] = []; for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
      const headers = new Headers(); for (const [key, value] of Object.entries(incoming.headers)) if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(',') : value);
      const result = await services[next++ % 2].router.handle(new Request('http://localhost' + incoming.url, { method: incoming.method, headers, body: Buffer.concat(chunks) }));
      outgoing.writeHead(result.status, Object.fromEntries(result.headers)); outgoing.end(Buffer.from(await result.arrayBuffer()));
    } catch { outgoing.writeHead(500); outgoing.end(); }
  });
  try {
    for (const table of Object.values(getUserFnSchema()).filter(table => table.modelName.startsWith('userfn_message_'))) {
      let migration = sql.schema.createTable(table.modelName);
      for (const [name, field] of Object.entries(table.fields)) migration = migration.addColumn(name, field.type === 'number' || field.type === 'boolean' ? 'integer' : 'text', column => name === 'id' ? column.primaryKey() : column.notNull());
      await migration.execute();
    }
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('address');
    const send = (key: string, identity = 'a:user:session-1', action = 'reserve', campaign = 'campaign', body = '{}') => fetch(`http://127.0.0.1:${address.port}/messages/${campaign}/${action}`, { method: 'POST', headers: { authorization: 'Bearer ' + identity, 'idempotency-key': key }, body });
    expect((await send('invalid', 'bad')).status).toBe(401);
    expect((await send('missing', undefined, 'reserve', 'missing')).status).toBe(404);
    expect((await (await send('zero', undefined, 'reserve', 'zero')).json()).allowed).toBe(false);
    expect((await (await send('disabled', undefined, 'reserve', 'disabled')).json()).allowed).toBe(false);
    expect((await send('large', undefined, 'reserve', 'campaign', 'x'.repeat(65537))).status).toBe(413);
    expect((await (await send('retired-receipt', 'a:retired:session', 'reserve', 'retired')).json()).allowed).toBe(true);
    retired.add('retired');
    expect((await send('new-retired', 'a:retired:session', 'reserve', 'retired')).status).toBe(404);
    const retiredShown = await send('retired-receipt', 'a:retired:session', 'shown', 'retired');
    expect(retiredShown.status).toBe(200);
    expect(await retiredShown.json()).toMatchObject({ allowed: true, shown: true });
    const duplicate = await Promise.all(Array.from({ length: 6 }, () => send('same', 'a:duplicate:session').then(response => response.json())));
    expect(duplicate.every(value => value.allowed)).toBe(true);
    expect(new Set(duplicate.map(value => value.id)).size).toBe(1);
    expect((await (await send('second', 'a:duplicate:session')).json()).allowed).toBe(true);
    expect((await (await send('third', 'a:duplicate:session')).json()).allowed).toBe(false);
    expect((await send('spoof', undefined, 'reserve', 'campaign', '{"user":"other","caps":100}')).status).toBe(400);
    const results = await Promise.all(Array.from({ length: 12 }, (_, index) => send('race-' + index).then(response => { expect(response.ok).toBe(true); return response.json(); })));
    expect(results.filter(value => value.allowed)).toHaveLength(2);
    const winning = results.findIndex(value => value.allowed);
    const replay = await (await send('race-' + winning)).json();
    expect(replay.allowed).toBe(true);
    expect((await (await send('new-session', 'a:user:session-2')).json()).allowed).toBe(true);
    expect((await (await send('user-max', 'a:user:session-3')).json()).allowed).toBe(false);
    expect((await (await send('other-user', 'a:other:session-1')).json()).allowed).toBe(true);
    expect((await (await send('other-tenant', 'b:user:session-1')).json()).allowed).toBe(true);
    expect((await send('race-' + winning, 'a:user:session-2')).status).toBe(409);
    expect((await send('race-' + winning, undefined, 'reserve', 'other')).status).toBe(409);
    expect((await (await send('race-' + winning, undefined, 'shown')).json()).shown).toBe(true);
    await secondary.close(); await adapter.close(); ({ sql, adapter } = connect()); secondary = connect().adapter;
    services = [createUserFnService({ database: adapter, ...options }), createUserFnService({ database: secondary, ...options })];
    expect(await (await send('race-' + winning)).json()).toMatchObject({ allowed: true, shown: true });
    expect((await (await send('after-restart', 'a:user:session-4')).json()).allowed).toBe(false);
  } finally {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    await secondary.close(); await adapter.close(); await rm(directory, { recursive: true, force: true });
  }
});

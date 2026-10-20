import { it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { Kysely, SqliteDialect } from 'kysely';
import { kyselyAdapter } from '@superfunctions/db/adapters';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { AuthProvider } from '@superfunctions/auth';
import { createUserFnService, getUserFnSchema, backfillFeedbackFilters } from '../src/index.js';
import { UserFnClient } from '../../typescript/src/index';

it('serves paginated boards, actor-owned votes and scoped status over both SDKs with SQLite reopen', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'userfn-board-'));
  const connect = () => {
    const sql = new Kysely<any>({ dialect: new SqliteDialect({ database: new Database(join(directory, 'board.sqlite')) }) });
    return { sql, adapter: kyselyAdapter({ db: sql, dialect: 'sqlite', schema: Object.fromEntries(Object.keys(getUserFnSchema()).map(key => [key, key])) }) };
  };
  let { sql, adapter } = connect();
  const auth: AuthProvider = { async authenticate(request) {
    const actorId = request.headers.get('authorization')?.replace('Bearer ', '');
    if (!actorId) return null;
    return { id: actorId, type: 'api-key', subject: { actorId, actorType: 'api-key', tenantId: actorId === 'tenant-b' ? 'b' : 'a' }, scopes: actorId === 'read-only' ? ['userfn:feedback:read'] : ['userfn:feedback:read', 'userfn:feedback:write', 'userfn:feedback:vote', 'userfn:feedback:moderate'] };
  } };
  let service = createUserFnService({ database: adapter, auth });
  const server = createServer(async (incoming, outgoing) => {
    try {
      const chunks: Buffer[] = []; for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
      const headers = new Headers();
      for (const [key, value] of Object.entries(incoming.headers)) if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(',') : value);
      const response = await service.router.handle(new Request(`http://localhost${incoming.url}`, { method: incoming.method, headers, ...(['POST', 'PATCH'].includes(incoming.method ?? '') ? { body: Buffer.concat(chunks) } : {}) }));
      outgoing.writeHead(response.status, Object.fromEntries(response.headers)); outgoing.end(Buffer.from(await response.arrayBuffer()));
    } catch { outgoing.writeHead(500); outgoing.end(); }
  });
  try {
    for (const table of Object.values(getUserFnSchema())) {
      let migration = sql.schema.createTable(table.modelName);
      for (const [name, field] of Object.entries(table.fields)) migration = migration.addColumn(name, field.type === 'number' ? 'integer' : 'text', column => {
        if (field.required) column = column.notNull(); if (name === 'id') column = column.primaryKey(); return column;
      });
      await migration.execute();
    }
    await backfillFeedbackFilters(adapter);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('No address');
    const endpoint = `http://127.0.0.1:${address.port}`;
    const client = (actor: string) => new UserFnClient({ endpoint, apiKey: actor, feedbackMaxAttempts: 1 });
    const owner = client('owner');
    for (let i = 0; i < 5; i++) await owner.submitFeedback({ title: `Item ${i}`, body: 'Details', category: 'general', tags: i === 0 ? ['UI', ' UI ', 'Cafe\u0301'] : ['misc'], ...(i === 0 ? { productArea: ' Search ' } : {}) }, { idempotencyKey: `item-${i}` });
    const filtered = await owner.getFeedbackBoard({ tag: ' UI ', productArea: 'Search', status: 'open', limit: 1 });
    expect((await owner.getFeedbackBoard({ tag: 'Café' })).items).toHaveLength(1);
    expect(filtered.items).toHaveLength(1); expect(filtered.items[0].productArea).toBe('Search');
    expect((await owner.getFeedbackBoard({ tag: 'UI', productArea: 'Other' })).items).toEqual([]);
    const first = await owner.getFeedbackBoard({ limit: 2 });
    const second = await owner.getFeedbackBoard({ limit: 2, after: first.nextCursor! });
    const third = await owner.getFeedbackBoard({ limit: 2, after: second.nextCursor! });
    const ids = [...first.items, ...second.items, ...third.items].map(item => item.id);
    expect(new Set(ids).size).toBe(5); expect(ids).toEqual([...ids].sort()); expect(third.nextCursor).toBe(null);
    const id = ids[0];
    expect((await client('tenant-b').getFeedbackBoard()).items).toEqual([]);
    await expect(client('tenant-b').voteFeedback(id, 1)).rejects.toMatchObject({ status: 404 });
    await expect(client('tenant-b').setFeedbackStatus(id, 'done')).rejects.toMatchObject({ status: 404 });
    for (const options of [{ limit: 0 }, { limit: 101 }, { after: 'bad' }, { status: 'bad' }]) await expect(owner.getFeedbackBoard(options as any)).rejects.toMatchObject({ status: 400 });
    const actors = Array.from({ length: 20 }, (_, index) => client('voter-' + index));
    await Promise.all(actors.map(actor => actor.voteFeedback(id, 1)));
    await Promise.all(Array.from({ length: 8 }, () => owner.voteFeedback(id, 1)));
    expect((await owner.getFeedbackBoard()).items.find(item => item.id === id)?.votes).toBe(21);
    owner.identify('different-client-identity', { tenantId: 'b' });
    const flips = await Promise.all(Array.from({ length: 20 }, (_, index) => owner.voteFeedback(id, index % 2 ? 1 : -1)));
    expect(flips.every(result => result.votes === 20 + result.viewerVote)).toBe(true);
    expect((await owner.voteFeedback(id, -1)).votes).toBe(19);
    expect((await owner.voteFeedback(id, 0)).votes).toBe(20);
    expect((await owner.voteFeedback(id, 0)).votes).toBe(20);
    expect(await adapter.count({ model: 'userfn_feedback_votes' })).toBe(20);
    const forbidden = client('read-only');
    await expect(forbidden.voteFeedback(id, 1)).rejects.toMatchObject({ status: 403 });
    await expect(forbidden.setFeedbackStatus(id, 'done')).rejects.toMatchObject({ status: 403 });
    const python = await promisify(execFile)('uv', ['run', '--isolated', '--no-project', '--python', '3.10', 'python', resolve('tests/python_board_acceptance.py'), endpoint, id], { env: { ...process.env, PYTHONPATH: resolve('../python/src') }, timeout: 20000 });
    expect(python.stdout).toContain('Python board HTTP acceptance passes');
    await adapter.close(); ({ sql, adapter } = connect()); service = createUserFnService({ database: adapter, auth });
    const reopened = await owner.getFeedbackBoard({ status: 'planned' });
    expect(reopened.items).toHaveLength(1); expect(reopened.items[0]).toMatchObject({ id, votes: 20, viewerVote: 0, status: 'planned' });
    expect(await owner.setFeedbackStatus(id, 'done')).toEqual({ id, status: 'done' });
    expect((await owner.getFeedbackBoard({ status: 'planned' })).items).toEqual([]);
    service = createUserFnService({ database: adapter, auth, maxVotesPerFeedback: 19 });
    await expect(owner.getFeedbackBoard()).rejects.toMatchObject({ status: 503 });
    service = createUserFnService({ database: adapter, auth });
    await sql.schema.dropTable('userfn_feedback_votes').execute();
    await expect(owner.voteFeedback(id, 1)).rejects.toMatchObject({ status: 503 });
    await expect(owner.getFeedbackBoard()).rejects.toMatchObject({ status: 503 });
  } finally {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    await adapter.close(); await rm(directory, { recursive: true, force: true });
  }
}, 30000);

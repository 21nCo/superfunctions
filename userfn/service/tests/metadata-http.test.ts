import { it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { Kysely, SqliteDialect } from 'kysely';
import { kyselyAdapter } from '@superfunctions/db/adapters';
import type { Adapter } from '@superfunctions/db';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { AuthProvider } from '@superfunctions/auth';
import { createUserFnService, getUserFnSchema, backfillFeedbackFilters } from '../src/index.js';
import { UserFnClient } from '../../typescript/src/index';

it('atomically moderates tags and product area through both SDKs without changing submission identity', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'userfn-metadata-'));
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

    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('No address');
    const endpoint = `http://127.0.0.1:${address.port}`;
    const client = (actor: string) => new UserFnClient({ endpoint, apiKey: actor, feedbackMaxAttempts: 1 });
    const owner = client('owner');
    const submission = { title: 'Original', body: 'Immutable submission', category: 'feature' as const, tags: ['Original'], productArea: 'Old area' };
    await owner.submitFeedback(submission, { idempotencyKey: 'metadata' });
    const id = (await owner.getFeedbackBoard()).items[0].id;
    const before = await adapter.findOne({ model: 'userfn_feedback', where: [{ field: 'id', operator: 'eq', value: id }] });
    // Readiness gate protects old rows from a backfill overwriting newer metadata.
    await expect(owner.setFeedbackMetadata(id, { tags: ['blocked'] })).rejects.toMatchObject({ status: 503 });
    await backfillFeedbackFilters(adapter);
    const request = (body: unknown, key = 'owner') => fetch(`${endpoint}/feedback/${id}/metadata`, { method: 'PATCH', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    for (const bad of [{}, null, [], { tags: null }, { tags: [42] }, { tags: [' '] }, { tags: Array(21).fill('x') }, { productArea: '' }, { productArea: 42 }, { productArea: 'x'.repeat(101) }, { tags: [], tenantId: 'b' }, { tags: [], actorId: 'admin' }, { tags: [], scopes: ['*'] }]) expect((await request(bad)).status).toBe(400);
    expect((await request({ tags: ['x'.repeat(66000)] })).status).toBe(413);
    await expect(client('read-only').setFeedbackMetadata(id, { tags: [] })).rejects.toMatchObject({ status: 403 });
    await expect(client('tenant-b').setFeedbackMetadata(id, { tags: [] })).rejects.toMatchObject({ status: 404 });
    expect(await owner.setFeedbackMetadata(id, { tags: [' Cafe\u0301 ', 'Café', 'UI'], productArea: ' Search ' })).toEqual({ id, tags: ['Café', 'UI'], productArea: 'Search' });
    expect((await owner.getFeedbackBoard({ tag: 'Original' })).items).toEqual([]);
    expect((await owner.getFeedbackBoard({ productArea: 'Old area' })).items).toEqual([]);
    expect((await owner.getFeedbackBoard({ tag: 'Café', productArea: 'Search' })).items[0]).toMatchObject({ id, tags: ['Café', 'UI'], productArea: 'Search' });
    // Disjoint concurrent patches must not overwrite the other field with a stale read.
    await Promise.all([owner.setFeedbackMetadata(id, { tags: ['Concurrent'] }), owner.setFeedbackMetadata(id, { productArea: 'Concurrent area' })]);
    expect((await owner.getFeedbackBoard()).items[0]).toMatchObject({ tags: ['Concurrent'], productArea: 'Concurrent area' });
    await Promise.all(Array.from({ length: 8 }, (_, index) => owner.setFeedbackMetadata(id, { tags: ['Set ' + index, 'Companion ' + index] })));
    const concurrentTags = (await owner.getFeedbackBoard()).items[0].tags!;
    expect(concurrentTags).toHaveLength(2);
    expect(concurrentTags[0].split(' ')[1]).toBe(concurrentTags[1].split(' ')[1]);
    await Promise.all(Array.from({ length: 8 }, () => owner.setFeedbackMetadata(id, { tags: ['Repeated'] })));
    expect(await adapter.count({ model: 'userfn_feedback_tags' })).toBe(1);
    // Failure after deletion and one insertion rolls back the whole update, including area.
    const broken: Adapter = { ...adapter, transaction: callback => adapter.transaction(tx => callback({ ...tx, create: async params => {
      if (params.model === 'userfn_feedback_tags' && params.data.tag === 'Z fail') throw new Error('private database failure');
      return tx.create(params);
    } })) };
    service = createUserFnService({ database: broken, auth });
    await expect(owner.setFeedbackMetadata(id, { tags: ['A written', 'Z fail'], productArea: 'Lost' })).rejects.toMatchObject({ status: 503 });
    service = createUserFnService({ database: adapter, auth });
    expect((await owner.getFeedbackBoard()).items[0]).toMatchObject({ tags: ['Repeated'], productArea: 'Concurrent area' });
    expect(await adapter.findOne({ model: 'userfn_feedback', where: [{ field: 'id', operator: 'eq', value: id }] })).toEqual(before);
    const failedCommit: Adapter = { ...adapter, transaction: callback => adapter.transaction(async tx => { await callback(tx); throw new Error('Commit aborted'); }) };
    service = createUserFnService({ database: failedCommit, auth });
    await expect(owner.setFeedbackMetadata(id, { tags: ['Rolled back'], productArea: 'Rolled back' })).rejects.toMatchObject({ status: 503 });
    service = createUserFnService({ database: adapter, auth });
    expect((await owner.getFeedbackBoard()).items[0]).toMatchObject({ tags: ['Repeated'], productArea: 'Concurrent area' });
    // Replaying the original POST acknowledges without reverting moderator metadata.
    await owner.submitFeedback(submission, { idempotencyKey: 'metadata' });
    expect((await owner.getFeedbackBoard()).items[0].tags).toEqual(['Repeated']);
    const stored = await (await fetch(`${endpoint}/feedback/${id}`, { headers: { authorization: 'Bearer owner' } })).json();
    expect(stored.payload.feedback).toEqual(submission);
    expect(stored.metadata).toEqual({ tags: ['Repeated'], productArea: 'Concurrent area' });
    const python = await promisify(execFile)('uv', ['run', '--isolated', '--no-project', '--python', '3.10', 'python', resolve('tests/python_metadata_acceptance.py'), endpoint, id], { env: { ...process.env, PYTHONPATH: resolve('../python/src') }, timeout: 20000 });
    expect(python.stdout).toContain('Python metadata HTTP acceptance passes');
    await adapter.close(); ({ sql, adapter } = connect()); service = createUserFnService({ database: adapter, auth });
    expect((await owner.getFeedbackBoard({ tag: 'Python', productArea: 'SDK' })).items[0]).toMatchObject({ id, tags: ['Python'], productArea: 'SDK' });
    expect(await owner.setFeedbackMetadata(id, { productArea: null })).toEqual({ id, tags: ['Python'], productArea: null });
    expect((await owner.getFeedbackBoard({ productArea: 'SDK' })).items).toEqual([]);
    expect(await owner.setFeedbackMetadata(id, { tags: [] })).toEqual({ id, tags: [], productArea: null });
    expect((await owner.getFeedbackBoard({ tag: 'Python' })).items).toEqual([]);
    await adapter.close(); ({ sql, adapter } = connect()); service = createUserFnService({ database: adapter, auth });
    expect((await owner.getFeedbackBoard()).items[0]).toMatchObject({ id, tags: [], productArea: null });
    const unsupported = { ...adapter, capabilities: { ...adapter.capabilities, transactions: { ...adapter.capabilities.transactions, supported: false } } };
    service = createUserFnService({ database: unsupported, auth });
    await expect(owner.setFeedbackMetadata(id, { tags: ['not saved'] })).rejects.toMatchObject({ status: 503 });
  } finally {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    await adapter.close(); await rm(directory, { recursive: true, force: true });
  }
}, 30000);

import { readFile } from 'node:fs/promises';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { PostgresAdapter } from '../src/storage/pg/adapter';
import { MemoryFn } from '../src/core/pipeline';
import * as schema from '../src/storage/pg/schema';
import { describeSourceContract } from './source-contract';

const migrations = ['0001-initial.sql', '0002-memory-lifecycle.sql', '0003-document-sources.sql'];

const url = process.env.MEMORYFN_TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;
// This variable must designate a disposable test database, never a production URL.
suite('Postgres lifecycle integration', () => {
  let client: postgres.Sql;
  let adapter: PostgresAdapter;
  const vector = (index: number) => Array.from({ length: 1536 }, (_, i) => i === index ? 1 : 0);
  beforeAll(async () => {
    client = postgres(url!);
    for (const name of migrations) {
      await client.unsafe(await readFile(new URL(`../migrations/${name}`, import.meta.url), 'utf8'));
    }
    adapter = new PostgresAdapter(drizzle(client, { schema }));
  });
  beforeEach(async () => { await client`TRUNCATE memory_relationships, memories`; });
  afterAll(async () => { await client?.end(); });
  describeSourceContract('PostgresAdapter', () => adapter);
  it('re-runs every migration and keeps the source columns and live-source index', async () => {
    for (const name of migrations) {
      await client.unsafe(await readFile(new URL(`../migrations/${name}`, import.meta.url), 'utf8'));
    }
    const columns = await client`SELECT column_name, data_type, is_nullable FROM information_schema.columns
      WHERE table_name = 'memories' AND column_name IN ('source_key', 'content_hash', 'chunk_index') ORDER BY column_name`;
    expect(columns.map(c => [c.column_name, c.data_type, c.is_nullable])).toEqual([
      ['chunk_index', 'integer', 'YES'], ['content_hash', 'text', 'YES'], ['source_key', 'text', 'YES'],
    ]);
    const [index] = await client`SELECT indexdef FROM pg_indexes WHERE indexname = 'idx_memories_live_source'`;
    expect(index.indexdef).toMatch(/\(tenant_id, source_key\) WHERE \(deleted_at IS NULL\)/);
  });
  it('clears tombstoned chunk content and their relationships', async () => {
    const scope = { tenantId: 'a', containerTags: ['docs'], sourceKey: 'guide.md' };
    const [chunk] = await adapter.replaceSource({ ...scope, contentHash: 'hash-1', chunks: [{ tenantId: 'a', containerTags: ['docs'], content: 'secret', embedding: vector(0) }] });
    const [plain] = await adapter.insertMemories([{ tenantId: 'a', containerTags: ['docs'], content: 'plain' }]);
    await adapter.insertRelationships([{ tenantId: 'a', containerTags: ['docs'], fromId: plain.id, toId: chunk.id }]);
    await adapter.replaceSource({ ...scope, contentHash: 'hash-2', chunks: [] });
    const [raw] = await client`SELECT content, embedding, metadata, deleted_at, source_key FROM memories WHERE id=${chunk.id}`;
    expect(raw).toMatchObject({ content: '', embedding: null, metadata: {}, source_key: 'guide.md' });
    expect(raw.deleted_at).not.toBeNull();
    expect(await client`SELECT * FROM memory_relationships`).toHaveLength(0);
  });
  it('preserves explicit relationship IDs and zero confidence', async () => {
    const rows = await adapter.insertMemories([0, 1].map(i => ({ tenantId: 'a', containerTags: [], content: String(i) })));
    const id = '550e8400-e29b-41d4-a716-446655440000';
    const [relation] = await adapter.insertRelationships([{ tenantId: 'a', containerTags: [], id, fromId: rows[0].id, toId: rows[1].id, confidence: 0 }]);
    expect(relation).toMatchObject({ id, confidence: 0 });
    await expect(adapter.insertRelationships([{ tenantId: 'a', containerTags: [], id, fromId: rows[0].id, toId: rows[1].id }])).rejects.toThrow('MEMORY_RELATION_EXISTS');
    const [generated] = await adapter.insertRelationships([{ tenantId: 'a', containerTags: [], id: '', fromId: rows[0].id, toId: rows[1].id }]);
    expect(generated.id).toBeTruthy();
  });
  it('retrieves only the explicit tenant with all scope tags', async () => {
    await adapter.insertMemories([
      { tenantId: 'a', containerTags: ['shared'], content: 'public', embedding: vector(0) },
      { tenantId: 'a', containerTags: ['shared', 'private'], content: 'private', embedding: vector(0) },
      { tenantId: 'b', containerTags: ['shared', 'private'], content: 'other tenant', embedding: vector(0) },
    ]);
    expect((await adapter.searchVectors({ tenantId: 'a', containerTags: ['shared', 'private'], embedding: vector(0), topK: 10 })).map(m => m.content)).toEqual(['private']);
  });
  it('preserves metadata on a public content-only update', async () => {
    const scope = {tenantId:'a',containerTags:['private']};
    const fn = new MemoryFn({storage:{kind:'adapter',adapter}},adapter,
      {embed:async()=>vector(0),embedBatch:async(values:string[])=>values.map(()=>vector(0))});
    const {memories:[saved]} = await fn.add({...scope,content:'old',metadata:{source:'audit'}});
    await fn.update({...scope,id:saved.id,expectedRevision:1,content:'new'});
    expect(await adapter.getMemory({...scope,id:saved.id})).toMatchObject({content:'new',metadata:{source:'audit'},revision:2});
    expect((await fn.search({...scope,q:'new',filters:{source:'audit'}})).results).toHaveLength(1);
  });
  it('competing updates have one winner and replace the vector', async () => {
    const [memory] = await adapter.insertMemories([{ tenantId: 'a', containerTags: [], content: 'old', embedding: vector(0) }]);
    const results = await Promise.allSettled([1, 2].map(() => adapter.updateMemory({ id: memory.id, tenantId: 'a', containerTags: [], expectedRevision: 1, changes: { content: 'new', embedding: vector(1) } })));
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(await adapter.searchVectors({ tenantId: 'a', containerTags: [], embedding: vector(0), threshold: 0.9, topK: 10 })).toEqual([]);
  });
  it('forget clears sensitive data and relations, survives adapter recreation and is idempotent', async () => {
    const rows = await adapter.insertMemories([0, 1].map(i => ({ tenantId: 'a', containerTags: [], content: `secret${i}`, embedding: vector(i) })));
    await adapter.insertRelationships([{ tenantId: 'a', containerTags: [], fromId: rows[0].id, toId: rows[1].id, type: 'extends' }]);
    const scope = { id: rows[0].id, tenantId: 'a', containerTags: [] };
    await adapter.deleteMemory(scope); await adapter.deleteMemory(scope);
    const fresh = new PostgresAdapter(drizzle(client, { schema }));
    expect(await fresh.getMemory(scope)).toBeNull();
    const [raw] = await client`SELECT content, embedding, metadata, deleted_at FROM memories WHERE id=${scope.id}`;
    expect(raw.content).toBe(''); expect(raw.embedding).toBeNull(); expect(raw.metadata).toEqual({}); expect(raw.deleted_at).not.toBeNull();
    expect(await client`SELECT * FROM memory_relationships`).toHaveLength(0);
    await expect(fresh.updateMemory({ ...scope, expectedRevision: 1, changes: { content: 'stale', embedding: vector(0) } })).rejects.toThrow();
  });
  it('rolls back a failed cleanup and safely retries the full forget transaction', async () => {
    const rows = await adapter.insertMemories([0, 1].map(i => ({ tenantId: 'a', containerTags: [], content: `secret${i}`, embedding: vector(i) })));
    await adapter.insertRelationships([{ tenantId: 'a', containerTags: [], fromId: rows[0].id, toId: rows[1].id }]);
    const scope = { id: rows[0].id, tenantId: 'a', containerTags: [] };
    await client.unsafe(`CREATE OR REPLACE FUNCTION sfns4_fail_cleanup() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'simulated cleanup failure'; END $$;
      CREATE TRIGGER sfns4_cleanup_failure BEFORE DELETE ON memory_relationships FOR EACH ROW EXECUTE FUNCTION sfns4_fail_cleanup();`);
    try {
      await expect(adapter.deleteMemory(scope)).rejects.toMatchObject({ cause: expect.objectContaining({ message: 'simulated cleanup failure' }) });
      expect(await adapter.getMemory(scope)).toMatchObject({ content: 'secret0', revision: 1 });
    } finally { await client.unsafe('DROP TRIGGER IF EXISTS sfns4_cleanup_failure ON memory_relationships; DROP FUNCTION IF EXISTS sfns4_fail_cleanup();'); }
    await adapter.deleteMemory(scope);
    expect(await adapter.getMemory(scope)).toBeNull();
    expect(await client`SELECT * FROM memory_relationships`).toHaveLength(0);
  });
  it('rejects cross-tenant and tombstoned relationship endpoints', async () => {
    const [a] = await adapter.insertMemories([{ tenantId: 'a', containerTags: [], content: 'a' }]);
    const [b] = await adapter.insertMemories([{ tenantId: 'b', containerTags: [], content: 'b' }]);
    await expect(adapter.insertRelationships([{ tenantId: 'a', containerTags: [], fromId: a.id, toId: b.id }])).rejects.toThrow('SCOPE_INVALID');
    await adapter.deleteMemory({ id: a.id, tenantId: 'a', containerTags: [] });
    await expect(adapter.insertRelationships([{ tenantId: 'a', containerTags: [], fromId: a.id, toId: a.id }])).rejects.toThrow('SCOPE_INVALID');
    expect(await client`SELECT * FROM memory_relationships`).toHaveLength(0);
  });
  it('rejects cross-tenant deletes without changing data', async () => {
    const [memory] = await adapter.insertMemories([{ tenantId: 'a', containerTags: [], content: 'secret', embedding: vector(0) }]);
    await expect(adapter.deleteMemory({ id: memory.id, tenantId: 'b', containerTags: [] })).rejects.toThrow();
    expect(await adapter.getMemory({ id: memory.id, tenantId: 'a', containerTags: [] })).toMatchObject({ content: 'secret' });
  });
});

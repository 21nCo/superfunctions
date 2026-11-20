import { readFile } from 'node:fs/promises';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { drizzle } from 'drizzle-orm/postgres-js';
import { Cache, type MutationOption } from 'drizzle-orm/cache/core';
import postgres from 'postgres';
import { PostgresAdapter } from '../src/storage/pg/adapter';
import { MAX_SOURCE_CHUNKS, MAX_SOURCE_REPLACE_BYTES } from '../src/storage/adapter';
import { MemoryFn } from '../src/core/pipeline';
import * as schema from '../src/storage/pg/schema';
import { describeSourceContract } from './source-contract';

const migrations = ['0001-initial.sql', '0002-memory-lifecycle.sql', '0003-document-sources.sql'];

const url = process.env.MEMORYFN_TEST_DATABASE_URL;

/** Caches every read and drops the entries of a table on any mutation of it, like a table-aware drizzle cache. */
class TableCache extends Cache {
  private readonly entries = new Map<string, { value: unknown[]; tables: string[] }>();
  strategy() { return 'all' as const; }
  async get(key: string) { return this.entries.get(key)?.value; }
  async put(key: string, value: unknown[], tables: string[]) { this.entries.set(key, { value, tables }); }
  async onMutate({ tables = [] }: MutationOption) {
    const names = (Array.isArray(tables) ? tables : [tables]).map(String);
    for (const [key, entry] of this.entries) if (entry.tables.some(table => names.includes(table))) this.entries.delete(key);
  }
}
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
  describeSourceContract('PostgresAdapter', () => adapter, async () => (await client`SELECT 1 FROM memory_relationships`).length);
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
  it('removes a relationship committed while the source write waits on its chunk', async () => {
    const scope = { tenantId: 'a', containerTags: ['docs'], sourceKey: 'guide.md' };
    const chunk = (content: string) => ({ tenantId: 'a', containerTags: ['docs'], content });
    const waitingRowLocks = async () => (await client`SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'transactionid' AND NOT granted`)[0].n;
    const writes = {
      deleteSource: () => adapter.deleteSource(scope),
      emptyReplace: () => adapter.replaceSource({ ...scope, contentHash: 'hash-2', chunks: [] }),
      replace: () => adapter.replaceSource({ ...scope, contentHash: 'hash-2', chunks: [chunk('new')] }),
    };
    for (const [name, write] of Object.entries(writes)) {
      await client`TRUNCATE memory_relationships, memories`;
      const [source] = await adapter.replaceSource({ ...scope, contentHash: 'hash-1', chunks: [chunk('old')] });
      const [plain] = await adapter.insertMemories([chunk('plain')]);
      let pending!: Promise<unknown>;
      // A relationship insert locks both endpoints first (as insertRelationships does); the source write must wait for it.
      await client.begin(async relate => {
        await relate`SELECT id FROM memories WHERE id IN (${source.id}, ${plain.id}) AND deleted_at IS NULL ORDER BY id FOR UPDATE`;
        await relate`INSERT INTO memory_relationships (from_id, to_id, type, confidence, reasoning) VALUES (${plain.id}, ${source.id}, 'extends', 1, 'reasoning')`;
        pending = write();
        for (let tries = 0; await waitingRowLocks() < 1; tries++) {
          if (tries > 250) throw new Error(`${name} never waited on the chunk lock`);
          await new Promise(resolve => setTimeout(resolve, 20));
        }
      });
      await pending;
      const [raw] = await client`SELECT deleted_at FROM memories WHERE id = ${source.id}`;
      expect(raw.deleted_at, name).not.toBeNull();
      expect(await client`SELECT reasoning FROM memory_relationships`, name).toHaveLength(0);
    }
  });
  it('orders same-source writes of separate adapters on one transaction', async () => {
    const scope = { tenantId: 'a', containerTags: ['docs'], sourceKey: 'guide.md' };
    const chunk = (content: string) => ({ tenantId: 'a', containerTags: ['docs'], content });
    const db = drizzle(client, { schema });
    type Db = typeof db;
    // Each arrangement gives two adapters on one database session: the advisory lock is re-entrant there.
    const arrangements: Array<(tx: Db, run: (left: PostgresAdapter, right: PostgresAdapter) => Promise<unknown[]>) => Promise<unknown[]>> = [
      (tx, run) => run(new PostgresAdapter(tx), new PostgresAdapter(tx)),
      (tx, run) => tx.transaction(inner => run(new PostgresAdapter(tx), new PostgresAdapter(inner as unknown as Db))),
    ];
    for (const arrange of arrangements) {
      await client`TRUNCATE memory_relationships, memories`;
      await adapter.replaceSource({ ...scope, contentHash: 'hash-0', chunks: [chunk('seed')] });
      await db.transaction(tx => arrange(tx as unknown as Db, (left, right) => Promise.all([
        left.replaceSource({ ...scope, contentHash: 'hash-left', chunks: [chunk('l1'), chunk('l2')] }),
        right.replaceSource({ ...scope, contentHash: 'hash-right', chunks: [chunk('r1')] }),
      ])));
      const state = await adapter.getSourceState(scope);
      expect([{ contentHash: 'hash-left', chunkCount: 2 }, { contentHash: 'hash-right', chunkCount: 1 }]).toContainEqual(state);

      const [, deleted] = await db.transaction(tx => arrange(tx as unknown as Db, (left, right) => Promise.all([
        left.replaceSource({ ...scope, contentHash: 'hash-new', chunks: [chunk('n1'), chunk('n2'), chunk('n3')] }),
        right.deleteSource(scope),
      ])));
      // Replace then delete removes the three new chunks; delete then replace removes the previous ones.
      const after = await adapter.getSourceState(scope);
      if (after === null) expect(deleted).toBe(3);
      else expect([deleted, after]).toEqual([state!.chunkCount, { contentHash: 'hash-new', chunkCount: 3 }]);
      const [{ n }] = await client`SELECT count(*)::int AS n FROM memories WHERE deleted_at IS NULL`;
      expect(n).toBe(after?.chunkCount ?? 0);
    }
  });
  it('invalidates cached memories and relationships after every source write', async () => {
    const scope = { tenantId: 'a', containerTags: ['docs'], sourceKey: 'guide.md' };
    const chunk = (content: string) => ({ tenantId: 'a', containerTags: ['docs'], content });
    const writes: Array<[string, (cached: PostgresAdapter) => Promise<unknown>, { contentHash: string; chunkCount: number } | null]> = [
      ['deleteSource', cached => cached.deleteSource(scope), null],
      ['empty replaceSource', cached => cached.replaceSource({ ...scope, contentHash: 'hash-2', chunks: [] }), null],
      ['replaceSource', cached => cached.replaceSource({ ...scope, contentHash: 'hash-2', chunks: [chunk('new')] }), { contentHash: 'hash-2', chunkCount: 1 }],
    ];
    for (const [name, write, state] of writes) {
      await client`TRUNCATE memory_relationships, memories`;
      const db = drizzle(client, { schema, cache: new TableCache() });
      const cached = new PostgresAdapter(db);
      const [source] = await cached.replaceSource({ ...scope, contentHash: 'hash-1', chunks: [chunk('old')] });
      const [plain] = await cached.insertMemories([chunk('plain')]);
      await cached.insertRelationships([{ tenantId: 'a', containerTags: ['docs'], fromId: plain.id, toId: source.id, reasoning: 'reasoning' }]);
      const read = { tenantId: 'a', containerTags: ['docs'], id: source.id };
      const relationships = () => db.select({ reasoning: schema.memoryRelationships.reasoning }).from(schema.memoryRelationships);
      // Fill the cache with the live source and its relationship before the write.
      expect(await cached.getSourceState(scope)).toEqual({ contentHash: 'hash-1', chunkCount: 1 });
      expect(await cached.getMemory(read)).toMatchObject({ content: 'old', deletedAt: null });
      expect(await relationships()).toEqual([{ reasoning: 'reasoning' }]);
      await write(cached);
      expect(await cached.getSourceState(scope), name).toEqual(state);
      expect(await cached.getMemory(read), name).toBeNull();
      expect(await relationships(), name).toEqual([]);
    }
  });
  it('never caches source state read inside a transaction that rolls back', async () => {
    const scope = { tenantId: 'a', containerTags: ['docs'], sourceKey: 'guide.md' };
    const chunk = (content: string) => ({ tenantId: 'a', containerTags: ['docs'], content });
    const cached = new PostgresAdapter(drizzle(client, { schema, cache: new TableCache() }));
    await cached.replaceSource({ ...scope, contentHash: 'hash-1', chunks: [chunk('old')] });
    expect(await cached.getSourceState(scope)).toEqual({ contentHash: 'hash-1', chunkCount: 1 });
    await expect(cached.transaction(async tx => {
      await tx.replaceSource({ ...scope, contentHash: 'hash-2', chunks: [chunk('n1'), chunk('n2')] });
      expect(await tx.getSourceState(scope)).toEqual({ contentHash: 'hash-2', chunkCount: 2 });
      throw new Error('abort');
    })).rejects.toThrow('abort');
    expect(await cached.getSourceState(scope)).toEqual({ contentHash: 'hash-1', chunkCount: 1 });
  });
  it('keeps the previous chunks and relationships when a replacement at the chunk limit fails', async () => {
    const scope = { tenantId: 'a', containerTags: ['docs'], sourceKey: 'guide.md' };
    const chunk = (content: string) => ({ tenantId: 'a', containerTags: ['docs'], content });
    const [source] = await adapter.replaceSource({ ...scope, contentHash: 'hash-1', chunks: [chunk('old-1'), chunk('old-2')] });
    const [plain] = await adapter.insertMemories([chunk('plain')]);
    await adapter.insertRelationships([{ tenantId: 'a', containerTags: ['docs'], fromId: plain.id, toId: source.id }]);
    const many = Array.from({ length: MAX_SOURCE_CHUNKS }, (_, index) => ({ ...chunk(`chunk ${index}\n"quoted"\u0001`), type: `type "${index}"` }));
    const duplicateId = '00000000-0000-4000-8000-000000000001';
    const failing = many.map((row, index) => index === 0 || index === MAX_SOURCE_CHUNKS - 1 ? { ...row, id: duplicateId } : row);
    await expect(adapter.replaceSource({ ...scope, contentHash: 'hash-2', chunks: failing })).rejects.toThrow();
    expect(await adapter.getSourceState(scope)).toEqual({ contentHash: 'hash-1', chunkCount: 2 });
    expect((await client`SELECT content FROM memories WHERE deleted_at IS NULL AND source_key IS NOT NULL ORDER BY chunk_index`).map(row => row.content)).toEqual(['old-1', 'old-2']);
    expect(await client`SELECT 1 FROM memory_relationships WHERE to_id = ${source.id}`).toHaveLength(1);
    await adapter.replaceSource({ ...scope, contentHash: 'hash-2', chunks: many });
    expect(await adapter.getSourceState(scope)).toEqual({ contentHash: 'hash-2', chunkCount: MAX_SOURCE_CHUNKS });
    expect(await client`SELECT 1 FROM memory_relationships`).toHaveLength(0);
  }, 120_000);
  it('stores chunk text and source fields sent as their own parameters exactly', async () => {
    const scope = { tenantId: 'a', containerTags: ['docs'], sourceKey: 'guide.md' };
    // Control characters grow six-fold under JSON escaping; every replacement sends its text unescaped.
    const long = String.fromCharCode(1).repeat(1 << 20) + 'end';
    const metadata = { note: `${String.fromCharCode(1).repeat(1024)}"quoted"`, nested: { list: [1, 'two'] } };
    const chunks = [{ content: 'short' }, { content: long, metadata }, { content: long + 'er' }, { content: 'tail\u0001' }]
      .map(chunk => ({ tenantId: 'a', containerTags: ['docs'], ...chunk }));
    const contentHash = `hash-${String.fromCharCode(1).repeat(1024)}`;
    const rows = await adapter.replaceSource({ ...scope, contentHash, chunks });
    expect(rows.map(row => [row.chunkIndex, row.content.length])).toEqual([[0, 5], [1, (1 << 20) + 3], [2, (1 << 20) + 5], [3, 5]]);
    const stored = await client`SELECT chunk_index, content = ${long} AS same FROM memories WHERE deleted_at IS NULL ORDER BY chunk_index`;
    expect(stored.map(row => [row.chunk_index, row.same])).toEqual([[0, false], [1, true], [2, false], [3, false]]);
    expect(rows[2].content.endsWith('ender')).toBe(true);
    expect(rows.map(row => row.metadata)).toEqual([{}, metadata, {}, {}]);
    expect(await adapter.getSourceState(scope)).toEqual({ contentHash, chunkCount: 4 });
  });
  it('replaces an escape-heavy source at the chunk limit and the byte limit', async () => {
    const scope = { tenantId: 'a', containerTags: ['docs', 'team', 'docs'], sourceKey: 'guide.md' };
    // Every text is ASCII, so its UTF-8 size is its length; control characters and quotes would grow under JSON escaping.
    const many = Array.from({ length: MAX_SOURCE_CHUNKS }, (_, index) => ({
      tenantId: 'a', containerTags: ['team', 'docs'], type: `type "${index}"\u0001`, metadata: { index, note: '"quoted"\u0001' },
      content: `chunk ${index}\n"quoted"\u0001`,
    }));
    const used = 'hash-many'.length + scope.containerTags.join('').length
      + many.reduce((total, chunk) => total + chunk.type.length + chunk.content.length + JSON.stringify(chunk.metadata).length, 0);
    many[3].content += String.fromCharCode(1).repeat(MAX_SOURCE_REPLACE_BYTES - used);
    const rows = await adapter.replaceSource({ ...scope, contentHash: 'hash-many', chunks: many });
    expect(rows.map(row => [row.chunkIndex, row.type, row.content, row.metadata, row.containerTags]))
      .toEqual(many.map((chunk, index) => [index, chunk.type, chunk.content, chunk.metadata, scope.containerTags]));
    const stored = await client`SELECT chunk_index FROM memories WHERE deleted_at IS NULL AND content = ${many[3].content}`;
    expect(stored.map(row => row.chunk_index)).toEqual([3]);
    expect(await adapter.getSourceState(scope)).toEqual({ contentHash: 'hash-many', chunkCount: MAX_SOURCE_CHUNKS });
  }, 120_000);
  it('commits transactions that write the same source keys in one order with disjoint tags', async () => {
    const chunk = (tag: string, content: string) => ({ tenantId: 'a', containerTags: [tag], content });
    const keys = ['b.md', 'a.md'].sort();
    // Sources sharing a key share its lock whatever their tags: each transaction takes its (tenant, key) pairs in sorted order.
    const writeAll = (tag: string) => adapter.transaction(async tx => {
      for (const sourceKey of keys) {
        await tx.replaceSource({ tenantId: 'a', containerTags: [tag], sourceKey, contentHash: `hash-${tag}`, chunks: [chunk(tag, `${tag} ${sourceKey}`)] });
      }
    });
    await Promise.all([writeAll('x'), writeAll('y')]);
    for (const tag of ['x', 'y']) for (const sourceKey of keys) {
      expect(await adapter.getSourceState({ tenantId: 'a', containerTags: [tag], sourceKey })).toEqual({ contentHash: `hash-${tag}`, chunkCount: 1 });
    }
    // The same tag set given reordered or with duplicates is the same source, so its writes stay serialized.
    const scope = { tenantId: 'a', containerTags: ['docs', 'team'], sourceKey: 'c.md' };
    const team = (content: string) => ({ tenantId: 'a', containerTags: ['team', 'docs'], content });
    await Promise.all([
      adapter.replaceSource({ ...scope, contentHash: 'hash-left', chunks: [team('l1'), team('l2')] }),
      adapter.replaceSource({ ...scope, containerTags: ['team', 'docs', 'team'], contentHash: 'hash-right', chunks: [team('r1')] }),
    ]);
    const state = await adapter.getSourceState(scope);
    expect([{ contentHash: 'hash-left', chunkCount: 2 }, { contentHash: 'hash-right', chunkCount: 1 }]).toContainEqual(state);
    const [{ n }] = await client`SELECT count(*)::int AS n FROM memories WHERE deleted_at IS NULL AND source_key = 'c.md'`;
    expect(n).toBe(state!.chunkCount);
  });
  it('takes the source and relationship row locks on the connection when a drizzle cache holds their reads', async () => {
    const scope = { tenantId: 'a', containerTags: ['docs'], sourceKey: 'guide.md' };
    const chunk = (content: string) => ({ tenantId: 'a', containerTags: ['docs'], content });
    const waitingRowLocks = async () => (await client`SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'transactionid' AND NOT granted`)[0].n;
    /** Returns once `pending` waits on a row lock or has settled. */
    const untilBlocked = async (pending: Promise<unknown>) => {
      let settled = false;
      pending.then(() => { settled = true; }, () => { settled = true; });
      for (let tries = 0; !settled && await waitingRowLocks() < 1 && tries < 100; tries++) await new Promise(resolve => setTimeout(resolve, 20));
    };
    const cached = new PostgresAdapter(drizzle(client, { schema, cache: new TableCache() }));
    const [source] = await cached.replaceSource({ ...scope, contentHash: 'hash-1', chunks: [chunk('old')] });
    const [plain] = await cached.insertMemories([chunk('plain')]);

    // A replacement that fails after its row-lock read, before any mutation reaches drizzle, leaves that read cached if it is cacheable.
    await expect(cached.replaceSource({ ...scope, contentHash: 'hash-x', chunks: [{ ...chunk('bad'), createdAt: Infinity }] })).rejects.toThrow();
    let pending!: Promise<unknown>;
    await client.begin(async relate => {
      await relate`SELECT id FROM memories WHERE id IN (${source.id}, ${plain.id}) AND deleted_at IS NULL ORDER BY id FOR UPDATE`;
      await relate`INSERT INTO memory_relationships (from_id, to_id, type, confidence, reasoning) VALUES (${plain.id}, ${source.id}, 'extends', 1, 'reasoning')`;
      pending = cached.deleteSource(scope);
      await untilBlocked(pending);
    });
    expect(await pending).toBe(1);
    expect(await client`SELECT reasoning FROM memory_relationships`).toHaveLength(0);

    // A relationship insert whose endpoint read is cached must still wait for a source write that holds the chunk.
    await client`TRUNCATE memory_relationships, memories`;
    const [next] = await cached.replaceSource({ ...scope, contentHash: 'hash-2', chunks: [chunk('next')] });
    const [other] = await cached.insertMemories([chunk('other')]);
    const relate = () => cached.insertRelationships([{ tenantId: 'a', containerTags: ['other'], fromId: other.id, toId: next.id }]);
    await expect(relate()).rejects.toThrow('MEMORY_RELATION_SCOPE_INVALID');
    let inserted!: Promise<unknown>;
    await client.begin(async write => {
      await write`UPDATE memories SET deleted_at = now() WHERE id = ${next.id}`;
      inserted = cached.insertRelationships([{ tenantId: 'a', containerTags: ['docs'], fromId: other.id, toId: next.id }]);
      await untilBlocked(inserted);
    });
    await expect(inserted).rejects.toThrow('MEMORY_RELATION_SCOPE_INVALID');
    expect(await client`SELECT reasoning FROM memory_relationships`).toHaveLength(0);
  });
  describe('source writes under REPEATABLE READ', () => {
    const scope = { tenantId: 'a', containerTags: ['docs'], sourceKey: 'guide.md' };
    const chunk = (content: string) => ({ tenantId: 'a', containerTags: ['docs'], content });
    const waitingAdvisoryLocks = async () => (await client`SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted`)[0].n;
    it('serializes replacements from a client whose transactions default to REPEATABLE READ', async () => {
      const repeatable = postgres(url!, { connection: { default_transaction_isolation: 'repeatable read' } });
      try {
        const storage = new PostgresAdapter(drizzle(repeatable, { schema }));
        let pending!: Promise<unknown>;
        // Both replacements take their first snapshot while a third session holds the source lock.
        await client.begin(async holder => {
          await holder`SELECT pg_advisory_xact_lock(hashtextextended(json_build_array(${scope.tenantId}::text, ${scope.sourceKey}::text)::text, 0))`;
          pending = Promise.all([
            storage.replaceSource({ ...scope, contentHash: 'hash-left', chunks: [chunk('l1'), chunk('l2')] }),
            storage.replaceSource({ ...scope, contentHash: 'hash-right', chunks: [chunk('r1')] }),
          ]);
          for (let tries = 0; await waitingAdvisoryLocks() < 2; tries++) {
            if (tries > 250) throw new Error('replacements never waited on the source lock');
            await new Promise(resolve => setTimeout(resolve, 20));
          }
        });
        await pending;
        expect([{ contentHash: 'hash-left', chunkCount: 2 }, { contentHash: 'hash-right', chunkCount: 1 }])
          .toContainEqual(await adapter.getSourceState(scope));
      } finally { await repeatable.end(); }
    });
    it('rejects source writes nested in a REPEATABLE READ transaction before writing', async () => {
      await adapter.replaceSource({ ...scope, contentHash: 'hash-1', chunks: [chunk('a')] });
      const db = drizzle(client, { schema });
      for (const write of [
        (storage: PostgresAdapter) => storage.replaceSource({ ...scope, contentHash: 'hash-2', chunks: [chunk('x')] }),
        (storage: PostgresAdapter) => storage.deleteSource(scope),
      ]) {
        await expect(db.transaction(tx => write(new PostgresAdapter(tx as unknown as typeof db)), { isolationLevel: 'repeatable read' }))
          .rejects.toThrow('MEMORY_SOURCE_ISOLATION_UNSUPPORTED');
      }
      expect(await adapter.getSourceState(scope)).toEqual({ contentHash: 'hash-1', chunkCount: 1 });
    });
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

import { describe, expect, it } from 'vitest';
import { drizzle } from 'drizzle-orm/postgres-js';
import type postgres from 'postgres';
import { PostgresAdapter } from '../src/storage/pg/adapter';
import { MemorySourceLimitError } from '../src/storage/adapter';
import * as pgEntry from '../src/storage/pg/index';
import * as schema from '../src/storage/pg/schema';

/** A postgres-js stand-in that records each statement and answers it without a database. */
function recorder(onQuery: (query: string) => void = () => {}, values: (query: string) => unknown[][] = () => []) {
  const statements: Array<{ query: string; params: unknown[] }> = [];
  const client: Record<string, unknown> = {
    options: { parsers: {}, serializers: {} },
    unsafe(query: string, params: unknown[] = []) {
      onQuery(query);
      statements.push({ query, params });
      const rows = /transaction_isolation/.test(query) ? [{ isolation: 'read committed' }] : [];
      return Object.assign(Promise.resolve(rows), { values: () => Promise.resolve(values(query)) });
    },
    begin: (operation: (tx: unknown) => unknown) => operation(client),
    savepoint: (operation: (tx: unknown) => unknown) => operation(client),
  };
  const adapter = new PostgresAdapter(drizzle(client as unknown as postgres.Sql, { schema }));
  return { adapter, statements };
}

const TAG = 'probe-tag-0001';
const scope = { tenantId: 'tenant-a', containerTags: [TAG, 'docs', TAG], sourceKey: 'guide.md' };
const chunk = { tenantId: 'tenant-a', containerTags: ['docs', TAG], content: 'text' };

describe('PostgresAdapter source statements', () => {
  it('binds the tag set once in every statement that matches the source', async () => {
    const calls: Array<[string, (adapter: PostgresAdapter) => Promise<unknown>]> = [
      ['getSourceState', adapter => adapter.getSourceState(scope)],
      ['replace', adapter => adapter.replaceSource({ ...scope, contentHash: 'hash-1', chunks: [chunk, chunk] })],
      ['empty replace', adapter => adapter.replaceSource({ ...scope, contentHash: 'hash-1', chunks: [] })],
      ['deleteSource', adapter => adapter.deleteSource(scope)],
    ];
    for (const [name, call] of calls) {
      const { adapter, statements } = recorder();
      await call(adapter);
      // Occurrences of the repeated tag in each statement's parameters.
      const binds = statements.map(({ params }) => params.reduce<number>((total, param) => total + String(param).split(TAG).length - 1, 0))
        .filter(count => count > 0);
      // getSourceState is one statement; a write has the row lock and then its write statement.
      expect([name, binds]).toEqual([name, name === 'getSourceState' ? [1] : [1, 1]]);
    }
  });

  it('rejects over-limit input and invalid chunk fields before any statement', async () => {
    const { adapter, statements } = recorder(query => { throw new Error(`DATABASE_TOUCHED: ${query}`); });
    await expect(adapter.getSourceState({ ...scope, sourceKey: 'k'.repeat(1025) })).rejects.toThrow(pgEntry.MemorySourceLimitError);
    await expect(adapter.deleteSource({ ...scope, tenantId: 't'.repeat(1025) })).rejects.toThrow(MemorySourceLimitError);
    const wide = { ...scope, containerTags: Array.from({ length: pgEntry.MAX_SOURCE_TAG_BYTES / 1024 + 1 }, (_, index) => `${index}`.padEnd(1024, 't')) };
    await expect(adapter.getSourceState(wide)).rejects.toThrow(pgEntry.MemorySourceLimitError);
    await expect(adapter.deleteSource(wide)).rejects.toThrow(pgEntry.MemorySourceLimitError);
    await expect(adapter.replaceSource({ ...scope, contentHash: 'h'.repeat(1025), chunks: [] })).rejects.toThrow(pgEntry.MemorySourceLimitError);
    const over = Array.from({ length: pgEntry.MAX_SOURCE_CHUNKS + 1 }, () => chunk);
    await expect(adapter.replaceSource({ ...scope, contentHash: 'hash-1', chunks: over })).rejects.toMatchObject({ code: 'MEMORY_SOURCE_LIMIT_EXCEEDED' });
    for (const id of ['memory-1', `${'0'.repeat(8)}-0000-4000-8000-${'0'.repeat(12)}x`]) {
      await expect(adapter.replaceSource({ ...scope, contentHash: 'hash-1', chunks: [{ ...chunk, id }] })).rejects.toThrow('MEMORY_SOURCE_CHUNK_INVALID');
    }
    expect(statements).toHaveLength(0);
  });

  it('keeps a replacement at every limit (distinct tags) to one statement of under 260 MiB of parameters', async () => {
    const { adapter, statements } = recorder();
    const containerTags = Array.from({ length: pgEntry.MAX_SOURCE_TAG_BYTES / 1024 }, (_, index) => `${index}`.padEnd(1024, 't'));
    // Each chunk is its share of the byte limit: type 'document', metadata '{}' and content.
    const content = String.fromCharCode(1).repeat(pgEntry.MAX_SOURCE_REPLACE_BYTES / pgEntry.MAX_SOURCE_CHUNKS - 'document'.length - '{}'.length);
    const chunks = Array.from({ length: pgEntry.MAX_SOURCE_CHUNKS }, () => ({ tenantId: scope.tenantId, containerTags, type: 'document' as const, content }));
    await adapter.replaceSource({ ...scope, containerTags, contentHash: 'h'.repeat(pgEntry.MAX_SOURCE_IDENTITY_BYTES), chunks });
    // A Bind message frames each value with a 4-byte length.
    const sizes = statements.map(({ params }) => params.reduce<number>((total, param) => total + 4 + Buffer.byteLength(typeof param === 'string' ? param : JSON.stringify(param)), 0));
    expect(Math.max(...sizes)).toBeGreaterThan(pgEntry.MAX_SOURCE_REPLACE_BYTES);
    expect(Math.max(...sizes)).toBeLessThan(260 * 1024 * 1024);
  }, 120_000);

  it('passes every uuid spelling PostgreSQL accepts to the database', async () => {
    for (const id of ['00000000-0000-4000-8000-000000000001', '00000000000040008000000000000001', '{00000000-0000-4000-8000-000000000001}', '0000-0000-0000-4000-8000-0000-0000-0001']) {
      const { adapter, statements } = recorder();
      await adapter.replaceSource({ ...scope, contentHash: 'hash-1', chunks: [{ ...chunk, id }] });
      expect([id, statements.some(({ params }) => params.some(param => String(param).includes(id.replace(/[{}]/g, ''))))]).toEqual([id, true]);
    }
  });

  it('recognizes a limit error thrown by another bundle of the class', () => {
    const foreign = Object.assign(new Error('MEMORY_SOURCE_LIMIT_EXCEEDED'), { name: 'MemorySourceLimitError', code: 'MEMORY_SOURCE_LIMIT_EXCEEDED' });
    expect([foreign instanceof MemorySourceLimitError, new MemorySourceLimitError() instanceof pgEntry.MemorySourceLimitError]).toEqual([true, true]);
    const others = [new Error('MEMORY_SOURCE_LIMIT_EXCEEDED'), Object.assign(new Error('x'), { code: 'MEMORY_SOURCE_LIMIT_EXCEEDED' }), { name: 'MemorySourceLimitError', code: 'MEMORY_SOURCE_LIMIT_EXCEEDED' }];
    expect(others.map(value => value instanceof MemorySourceLimitError)).toEqual([false, false, false]);
    class AppLimit extends MemorySourceLimitError { readonly retryAfter = 1; }
    class Renamed extends MemorySourceLimitError { name = 'AppLimit'; }
    expect([new MemorySourceLimitError() instanceof AppLimit, foreign instanceof AppLimit, new AppLimit() instanceof AppLimit, new AppLimit() instanceof pgEntry.MemorySourceLimitError])
      .toEqual([false, false, true, true]);
    expect([new Renamed() instanceof MemorySourceLimitError, new Renamed() instanceof Renamed, new AppLimit() instanceof Renamed]).toEqual([true, true, false]);
  });

  it('reads the source state after the source locks and skips the write when the hash matches', async () => {
    const kinds = (statements: Array<{ query: string }>) => statements.map(({ query }) =>
      /pg_advisory_xact_lock/.test(query) ? 'lock' : /for update/.test(query) ? 'row-lock' : /count\(\*\)/.test(query) ? 'state'
        : /^with .*insert into "memories"/s.test(query) ? 'write' : /^delete from "memory_relationships"/.test(query) ? 'invalidate' : 'other');
    const stored = (hash: string) => (query: string) => /count\(\*\)/.test(query) ? [[hash, 2]] : [];
    const same = recorder(undefined, stored('hash-1'));
    expect(await same.adapter.replaceSourceIfChanged({ ...scope, contentHash: 'hash-1', chunks: [chunk] }))
      .toEqual({ unchanged: true, state: { contentHash: 'hash-1', chunkCount: 2 } });
    expect(kinds(same.statements)).toEqual(['other', 'other', 'lock', 'row-lock', 'state', 'invalidate']);
    const changed = recorder(undefined, stored('hash-0'));
    expect(await changed.adapter.replaceSourceIfChanged({ ...scope, contentHash: 'hash-1', chunks: [chunk] })).toMatchObject({ unchanged: false });
    expect(kinds(changed.statements)).toEqual(['other', 'other', 'lock', 'row-lock', 'state', 'write', 'invalidate']);
  });

  it('leaves source rows out of a vector search only when excludeSources is set', async () => {
    const search = { tenantId: 'tenant-a', containerTags: ['docs'], embedding: [1, 0], topK: 1, threshold: 0.95 };
    const excluded = recorder();
    await excluded.adapter.searchVectors({ ...search, excludeSources: true });
    expect(excluded.statements).toHaveLength(1);
    expect(excluded.statements[0].query).toMatch(/"source_key" is null/);
    const included = recorder();
    await included.adapter.searchVectors(search);
    expect(included.statements[0].query).not.toMatch(/"source_key" is null/);
  });
});

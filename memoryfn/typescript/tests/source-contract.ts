import { describe, expect, it } from 'vitest';
import type { MemoryInsert, MemoryUpdate, SourceScope, StorageAdapter } from '../src/storage/adapter';
import type { Memory } from '../src/core/types';

const chunkId = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

/**
 * Source-keyed document contract shared by every StorageAdapter. `adapter`
 * returns a storage that is empty at the start of each test.
 */
export function describeSourceContract(name: string, adapter: () => StorageAdapter): void {
  describe(`${name} source-keyed documents`, () => {
    const source: SourceScope = { tenantId: 'tenant-a', containerTags: ['team', 'docs'], sourceKey: 'docs/guide.md' };
    const chunks = (scope: SourceScope, ...contents: string[]): MemoryInsert[] =>
      contents.map(content => ({ tenantId: scope.tenantId, containerTags: [...scope.containerTags], type: 'document', content }));
    const live = async (scope: SourceScope, rows: Memory[]) =>
      (await Promise.all(rows.map(row => adapter().getMemory({ ...scope, id: row.id })))).filter(row => row !== null);

    it('replaces every chunk of a source and reports the new hash and count', async () => {
      expect(await adapter().getSourceState(source)).toBeNull();
      const first = await adapter().replaceSource({ ...source, contentHash: 'hash-1', chunks: chunks(source, 'a', 'b', 'c') });
      expect(first.map(row => [row.content, row.sourceKey, row.contentHash, row.chunkIndex]))
        .toEqual([['a', source.sourceKey, 'hash-1', 0], ['b', source.sourceKey, 'hash-1', 1], ['c', source.sourceKey, 'hash-1', 2]]);
      expect(await adapter().getSourceState(source)).toEqual({ contentHash: 'hash-1', chunkCount: 3 });

      const second = await adapter().replaceSource({ ...source, contentHash: 'hash-2', chunks: chunks(source, 'x', 'y') });
      expect(await adapter().getSourceState(source)).toEqual({ contentHash: 'hash-2', chunkCount: 2 });
      expect(await live(source, first)).toEqual([]);
      expect((await live(source, second)).map(row => [row.content, row.chunkIndex])).toEqual([['x', 0], ['y', 1]]);
    });

    it('treats an empty replacement as removing every live chunk', async () => {
      await adapter().replaceSource({ ...source, contentHash: 'hash-1', chunks: chunks(source, 'a') });
      await expect(adapter().replaceSource({ ...source, contentHash: 'hash-empty', chunks: [] })).resolves.toEqual([]);
      expect(await adapter().getSourceState(source)).toBeNull();
    });

    it('deletes only the live chunks of one source', async () => {
      const otherKey = { ...source, sourceKey: 'docs/other.md' };
      const otherTags = { ...source, containerTags: ['team'] };
      const target = await adapter().replaceSource({ ...source, contentHash: 'hash-1', chunks: chunks(source, 'a', 'b') });
      const keep = [
        ...await adapter().replaceSource({ ...otherKey, contentHash: 'hash-o', chunks: chunks(otherKey, 'o') }),
        ...await adapter().replaceSource({ ...otherTags, contentHash: 'hash-t', chunks: chunks(otherTags, 't') }),
      ];
      const [plain] = await adapter().insertMemories([{ tenantId: source.tenantId, containerTags: source.containerTags, content: 'plain' }]);

      expect(await adapter().deleteSource(source)).toBe(2);
      expect(await adapter().getSourceState(source)).toBeNull();
      expect(await live(source, target)).toEqual([]);
      expect(await adapter().getSourceState(otherKey)).toEqual({ contentHash: 'hash-o', chunkCount: 1 });
      expect(await adapter().getSourceState(otherTags)).toEqual({ contentHash: 'hash-t', chunkCount: 1 });
      expect((await live(otherTags, keep)).map(row => row.content)).toEqual(['o', 't']);
      expect(await adapter().getMemory({ ...source, id: plain.id })).toMatchObject({ content: 'plain' });
      expect(await adapter().deleteSource(source)).toBe(0);
    });

    it('scopes a source by tenant and the exact container tag set', async () => {
      await adapter().replaceSource({ ...source, contentHash: 'hash-1', chunks: chunks(source, 'a') });
      expect(await adapter().getSourceState({ ...source, containerTags: ['docs', 'team', 'docs'] })).toEqual({ contentHash: 'hash-1', chunkCount: 1 });
      for (const scope of [
        { ...source, tenantId: 'tenant-b' },
        { ...source, containerTags: ['team'] },
        { ...source, containerTags: ['team', 'docs', 'extra'] },
        { ...source, containerTags: [] },
      ]) {
        expect(await adapter().getSourceState(scope)).toBeNull();
        expect(await adapter().deleteSource(scope)).toBe(0);
      }
      const subset = { ...source, containerTags: ['team'] };
      await adapter().replaceSource({ ...subset, contentHash: 'hash-s', chunks: chunks(subset, 's') });
      expect(await adapter().getSourceState(source)).toEqual({ contentHash: 'hash-1', chunkCount: 1 });
      expect(await adapter().getSourceState(subset)).toEqual({ contentHash: 'hash-s', chunkCount: 1 });
    });

    it('leaves exactly one of two concurrent replacements live', async () => {
      const results = await Promise.all([
        adapter().replaceSource({ ...source, contentHash: 'hash-left', chunks: chunks(source, 'l1', 'l2', 'l3') }),
        adapter().replaceSource({ ...source, contentHash: 'hash-right', chunks: chunks(source, 'r1', 'r2') }),
      ]);
      const liveCounts = await Promise.all(results.map(async rows => (await live(source, rows)).length));
      const winner = liveCounts[0] === results[0].length ? 0 : 1;
      expect(liveCounts[winner]).toBe(results[winner].length);
      expect(liveCounts[1 - winner]).toBe(0);
      expect(await adapter().getSourceState(source))
        .toEqual({ contentHash: winner === 0 ? 'hash-left' : 'hash-right', chunkCount: results[winner].length });
    });

    it('serializes same-source writes made through one transaction', async () => {
      await adapter().replaceSource({ ...source, contentHash: 'hash-0', chunks: chunks(source, 'seed') });
      const [left, right] = await adapter().transaction!(tx => Promise.all([
        tx.replaceSource({ ...source, contentHash: 'hash-left', chunks: chunks(source, 'l1', 'l2') }),
        tx.replaceSource({ ...source, contentHash: 'hash-right', chunks: chunks(source, 'r1') }),
      ]));
      const leftLive = (await live(source, left)).length; const rightLive = (await live(source, right)).length;
      expect([leftLive, rightLive]).toContainEqual(0);
      expect(await adapter().getSourceState(source))
        .toEqual(leftLive ? { contentHash: 'hash-left', chunkCount: 2 } : { contentHash: 'hash-right', chunkCount: 1 });

      const [replaced, deleted] = await adapter().transaction!(tx => Promise.all([
        tx.replaceSource({ ...source, contentHash: 'hash-new', chunks: chunks(source, 'n1', 'n2', 'n3') }),
        tx.deleteSource(source),
      ]));
      const state = await adapter().getSourceState(source);
      // Replace then delete removes the three new chunks; delete then replace removes the previous ones.
      if (state === null) expect([deleted, (await live(source, replaced)).length]).toEqual([3, 0]);
      else expect([deleted, state]).toEqual([leftLive ? 2 : 1, { contentHash: 'hash-new', chunkCount: 3 }]);
    });

    it('writes the source scope and chunks given at call time', async () => {
      const other = { ...source, sourceKey: 'docs/other.md' };
      await adapter().replaceSource({ ...source, contentHash: 'hash-1', chunks: chunks(source, 'a') });
      await adapter().replaceSource({ ...other, contentHash: 'hash-o', chunks: chunks(other, 'o') });
      const input = { ...source, containerTags: [...source.containerTags], contentHash: 'hash-2', chunks: chunks(source, 'x') };
      const pending = adapter().replaceSource(input);
      Object.assign(input, { sourceKey: other.sourceKey, tenantId: 'tenant-b', contentHash: 'hash-mutated' });
      input.containerTags.push('extra'); input.chunks[0].content = 'mutated'; input.chunks.push(chunks(source, 'pushed')[0]);
      expect((await pending).map(row => [row.content, row.sourceKey, row.contentHash])).toEqual([['x', source.sourceKey, 'hash-2']]);
      expect(await adapter().getSourceState(source)).toEqual({ contentHash: 'hash-2', chunkCount: 1 });
      expect(await adapter().getSourceState(other)).toEqual({ contentHash: 'hash-o', chunkCount: 1 });

      const scope = { ...source, containerTags: [...source.containerTags] };
      const deleting = adapter().deleteSource(scope);
      scope.sourceKey = other.sourceKey; scope.containerTags.push('extra');
      expect(await deleting).toBe(1);
      expect(await adapter().getSourceState(source)).toBeNull();
      expect(await adapter().getSourceState(other)).toEqual({ contentHash: 'hash-o', chunkCount: 1 });
    });

    it('never lets updateMemory change source fields', async () => {
      const [chunk] = await adapter().replaceSource({ ...source, contentHash: 'hash-1', chunks: chunks(source, 'a') });
      const [plain] = await adapter().insertMemories([{ tenantId: source.tenantId, containerTags: source.containerTags, content: 'plain' }]);
      // A Memory read back from storage, passed whole as the changes of another memory.
      const changes = { ...chunk, content: 'edited', embedding: null } as unknown as MemoryUpdate['changes'];
      const updated = await adapter().updateMemory({ ...source, id: plain.id, expectedRevision: plain.revision!, changes });
      expect(updated).toMatchObject({ id: plain.id, content: 'edited', revision: plain.revision! + 1 });
      expect(updated).not.toHaveProperty('sourceKey');
      const moved = { content: 'chunk edited', embedding: null, sourceKey: 'docs/other.md', contentHash: 'hash-x', chunkIndex: 7 } as MemoryUpdate['changes'];
      expect(await adapter().updateMemory({ ...source, id: chunk.id, expectedRevision: chunk.revision!, changes: moved }))
        .toMatchObject({ sourceKey: source.sourceKey, contentHash: 'hash-1', chunkIndex: 0 });
      expect(await adapter().getSourceState(source)).toEqual({ contentHash: 'hash-1', chunkCount: 1 });
      expect(await adapter().deleteSource(source)).toBe(1);
      expect(await adapter().getMemory({ ...source, id: plain.id })).toMatchObject({ content: 'edited' });
    });

    it('leaves the previous chunks live when a replacement fails', async () => {
      const before = await adapter().replaceSource({ ...source, contentHash: 'hash-1', chunks: chunks(source, 'a', 'b') });
      const duplicate = chunks(source, 'x', 'y').map(chunk => ({ ...chunk, id: chunkId(1) }));
      await expect(adapter().replaceSource({ ...source, contentHash: 'hash-2', chunks: duplicate })).rejects.toThrow();
      await expect(adapter().replaceSource({ ...source, contentHash: 'hash-2', chunks: [{ ...chunks(source, 'x')[0], tenantId: 'tenant-b' }] }))
        .rejects.toThrow('MEMORY_SOURCE_SCOPE_MISMATCH');
      await expect(adapter().replaceSource({ ...source, contentHash: 'hash-2', chunks: [{ ...chunks(source, 'x')[0], containerTags: ['team'] }] }))
        .rejects.toThrow('MEMORY_SOURCE_SCOPE_MISMATCH');
      await expect(adapter().replaceSource({ ...source, contentHash: ' ', chunks: chunks(source, 'x') })).rejects.toThrow('MEMORY_SOURCE_HASH_REQUIRED');
      await expect(adapter().replaceSource({ ...source, sourceKey: '', contentHash: 'hash-2', chunks: [] })).rejects.toThrow('MEMORY_SOURCE_KEY_REQUIRED');
      await expect(adapter().getSourceState({ ...source, sourceKey: ' ' })).rejects.toThrow('MEMORY_SOURCE_KEY_REQUIRED');
      expect(await adapter().getSourceState(source)).toEqual({ contentHash: 'hash-1', chunkCount: 2 });
      expect(await live(source, before)).toHaveLength(2);
    });

    it('rolls a replacement back with its enclosing transaction', async () => {
      await adapter().replaceSource({ ...source, contentHash: 'hash-1', chunks: chunks(source, 'a') });
      await expect(adapter().transaction!(async tx => {
        await tx.replaceSource({ ...source, contentHash: 'hash-2', chunks: chunks(source, 'x', 'y') });
        expect(await tx.getSourceState(source)).toEqual({ contentHash: 'hash-2', chunkCount: 2 });
        throw new Error('abort');
      })).rejects.toThrow('abort');
      expect(await adapter().getSourceState(source)).toEqual({ contentHash: 'hash-1', chunkCount: 1 });
    });

    it('never lets insertMemories write source columns', async () => {
      const spoofed = { ...chunks(source, 'spoof')[0], sourceKey: source.sourceKey, contentHash: 'hash-spoof', chunkIndex: 0 } as MemoryInsert;
      const [row] = await adapter().insertMemories([spoofed]);
      expect(row).not.toHaveProperty('sourceKey');
      expect(await adapter().getSourceState(source)).toBeNull();
    });
  });
}

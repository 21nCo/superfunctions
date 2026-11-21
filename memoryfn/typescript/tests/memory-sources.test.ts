import { beforeEach, expect, it } from 'vitest';
import { MemoryStorageAdapter } from '../src/storage/memory/adapter';
import { describeSourceContract } from './source-contract';

let storage: MemoryStorageAdapter;
beforeEach(() => { storage = new MemoryStorageAdapter(); });

describeSourceContract('MemoryStorageAdapter', () => storage,
  async () => (storage as unknown as { relationships: Map<string, unknown> }).relationships.size);

it('clears tombstoned chunk content and drops their relationships', async () => {
  const scope = { tenantId: 'tenant-a', containerTags: ['docs'], sourceKey: 'guide.md' };
  const [chunk] = await storage.replaceSource({ ...scope, contentHash: 'hash-1', chunks: [{ tenantId: 'tenant-a', containerTags: ['docs'], content: 'secret' }] });
  const [plain] = await storage.insertMemories([{ tenantId: 'tenant-a', containerTags: ['docs'], content: 'plain' }]);
  await storage.insertRelationships([{ tenantId: 'tenant-a', containerTags: ['docs'], fromId: plain.id, toId: chunk.id }]);
  await storage.deleteSource(scope);
  const raw = (storage as unknown as { memories: Map<string, { content: string; deletedAt: number | null }> }).memories.get(chunk.id);
  expect(raw).toMatchObject({ content: '', deletedAt: expect.any(Number) });
  expect((storage as unknown as { relationships: Map<string, unknown> }).relationships.size).toBe(0);
});

import { describe, expect, it } from 'vitest';
import { MemoryStorageAdapter } from '../src/storage/memory/adapter';

describe('MemoryStorageAdapter', () => {
  it('persists memories and applies tag, metadata, threshold, and limit filters', async () => {
    const storage = new MemoryStorageAdapter();
    await storage.insertMemories([
      {
        tenantId: 'tenant-a',
        containerTags: ['scope:a'],
        type: 'document',
        content: 'visible',
        embedding: [1, 0],
        metadata: { kind: 'note' },
        isLatest: true,
      },
      {
        tenantId: 'tenant-b',
        containerTags: ['scope:b'],
        type: 'document',
        content: 'hidden',
        embedding: [1, 0],
        metadata: { kind: 'note' },
        isLatest: true,
      },
      {
        tenantId: 'tenant-a',
        containerTags: ['scope:a'],
        type: 'document',
        content: 'wrong metadata',
        embedding: [1, 0],
        metadata: { kind: 'task' },
        isLatest: true,
      },
    ]);

    const results = await storage.searchVectors({
      embedding: [1, 0],
      containerTags: ['scope:a'],
      filters: { kind: 'note' },
      threshold: 0.9,
      topK: 1,
    });

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ tenantId: 'tenant-a', content: 'visible' });
    results[0]!.content = 'mutated outside storage';
    await expect(storage.searchVectors({
      embedding: [1, 0],
      containerTags: ['scope:a'],
      filters: { kind: 'note' },
      topK: 1,
    })).resolves.toEqual([expect.objectContaining({ content: 'visible' })]);
  });
});

import { Memory } from '../core/types';
import { StorageAdapter } from '../storage/adapter';

export class Deduplicator {
  private storage: StorageAdapter;
  private threshold: number;

  constructor(storage: StorageAdapter, threshold: number = 0.95) {
    this.storage = storage;
    this.threshold = threshold;
  }

  /**
   * The closest memory at or above the threshold that belongs to no source.
   * Source chunks and facts live and die with their source, so new content is
   * never merged into them.
   */
  async findDuplicate(tenantId: string, embedding: number[], containerTags: string[]): Promise<Memory | null> {
    const results = await this.storage.searchVectors({
      tenantId,
      embedding,
      containerTags,
      threshold: this.threshold,
      topK: 1,
      excludeSources: true,
    });

    // Also filtered here, for an adapter that ignores excludeSources.
    return results.find(memory => memory.sourceKey == null) ?? null;
  }
}

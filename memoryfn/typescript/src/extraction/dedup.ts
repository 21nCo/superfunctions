import { Memory } from '../core/types';
import { StorageAdapter } from '../storage/adapter';

/**
 * Up to `limit` memories that belong to no source, in the adapter's rank
 * order, from one searchVectors call with `topK: limit` and excludeSources.
 * Source chunks and facts live and die with their source, so add() never
 * merges into, supersedes or links them. An adapter that declares
 * excludesSources (which upsertDocument requires) honours excludeSources; for
 * one that does not, source rows are dropped here, never re-queried, so they
 * can only cost a missed candidate, never a source change or a larger request.
 */
export async function searchOrdinaryCandidates(
  storage: StorageAdapter,
  params: Omit<Parameters<StorageAdapter['searchVectors']>[0], 'topK' | 'excludeSources'>,
  limit: number,
): Promise<Memory[]> {
  const rows = await storage.searchVectors({ ...params, topK: limit, excludeSources: true });
  return rows.filter(memory => memory.sourceKey == null).slice(0, limit);
}

export class Deduplicator {
  private storage: StorageAdapter;
  private threshold: number;

  constructor(storage: StorageAdapter, threshold: number = 0.95) {
    this.storage = storage;
    this.threshold = threshold;
  }

  /** The closest memory at or above the threshold that belongs to no source. */
  async findDuplicate(tenantId: string, embedding: number[], containerTags: string[]): Promise<Memory | null> {
    const [duplicate] = await searchOrdinaryCandidates(this.storage, { tenantId, embedding, containerTags, threshold: this.threshold }, 1);
    return duplicate ?? null;
  }
}

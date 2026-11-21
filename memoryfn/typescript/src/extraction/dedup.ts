import { Memory } from '../core/types';
import { StorageAdapter } from '../storage/adapter';

/**
 * The best `limit` memories that belong to no source, in the adapter's rank
 * order. Source chunks and facts live and die with their source, so add()
 * never merges into, supersedes or links them. An adapter that honours
 * excludeSources answers in one call with `topK: limit`. For one that returns
 * source rows anyway, the query is repeated with a doubled topK until `limit`
 * ordinary rows are found or the candidates run out (a short page, a page of
 * only ordinary rows, or a page no longer than the one before, from an adapter
 * that does not page), so source rows never take an ordinary candidate's place.
 */
export async function searchOrdinaryCandidates(
  storage: StorageAdapter,
  params: Omit<Parameters<StorageAdapter['searchVectors']>[0], 'topK' | 'excludeSources'>,
  limit: number,
): Promise<Memory[]> {
  let previous = 0;
  for (let topK = limit; ; topK *= 2) {
    const rows = await storage.searchVectors({ ...params, topK, excludeSources: true });
    const ordinary = rows.filter(memory => memory.sourceKey == null);
    if (ordinary.length >= limit || ordinary.length === rows.length || rows.length < topK || rows.length <= previous) {
      return ordinary.slice(0, limit);
    }
    previous = rows.length;
  }
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

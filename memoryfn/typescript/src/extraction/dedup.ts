import { Memory } from '../core/types';
import { StorageAdapter } from '../storage/adapter';

/** Deepest page searchOrdinaryCandidates asks for when an adapter returns source rows. */
export const MAX_ORDINARY_CANDIDATE_ROWS = 64;

/**
 * The best `limit` memories that belong to no source, in the adapter's rank
 * order. Source chunks and facts live and die with their source, so add()
 * never merges into, supersedes or links them. An adapter that honours
 * excludeSources answers in one call with `topK: limit`; for one that returns
 * source rows anyway, the query is repeated with a doubled topK, up to
 * MAX_ORDINARY_CANDIDATE_ROWS, until `limit` ordinary rows are found or the
 * candidates run out, so source rows never take an ordinary candidate's place.
 */
export async function searchOrdinaryCandidates(
  storage: StorageAdapter,
  params: Omit<Parameters<StorageAdapter['searchVectors']>[0], 'topK' | 'excludeSources'>,
  limit: number,
): Promise<Memory[]> {
  for (let topK = limit; ; topK = Math.min(topK * 2, MAX_ORDINARY_CANDIDATE_ROWS)) {
    const rows = await storage.searchVectors({ ...params, topK, excludeSources: true });
    const ordinary = rows.filter(memory => memory.sourceKey == null);
    if (ordinary.length >= limit || ordinary.length === rows.length || rows.length < topK || topK >= MAX_ORDINARY_CANDIDATE_ROWS) {
      return ordinary.slice(0, limit);
    }
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

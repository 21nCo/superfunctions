import { Memory, MemoryRelationship } from '../core/types';

export interface MemoryScope { tenantId: string; containerTags: string[] }
/** Source fields are written only through replaceSource, never by insertMemories. */
export type MemoryInsert = MemoryScope & Partial<Omit<Memory, keyof MemoryScope | 'revision' | 'deletedAt' | 'sourceKey' | 'contentHash' | 'chunkIndex'>>;
export type MemoryRelationshipInsert = MemoryScope
  & Pick<MemoryRelationship, 'fromId' | 'toId'>
  & Partial<Omit<MemoryRelationship, 'fromId' | 'toId'>>;
export interface MemoryUpdate extends MemoryScope {
  id: string;
  expectedRevision: number;
  changes: Pick<Memory, 'content' | 'embedding'> & Partial<Pick<Memory, 'metadata' | 'isLatest'>>;
}
export interface MemoryDelete extends MemoryScope { id: string; expectedRevision?: number }
/**
 * A source is identified by tenantId, the exact containerTags set (order and
 * duplicates ignored) and sourceKey. Another tag set is another source.
 */
export interface SourceScope extends MemoryScope { sourceKey: string }
/** contentHash is null only when live chunks disagree (rows written outside replaceSource); a replace repairs it. */
export interface SourceState { contentHash: string | null; chunkCount: number }
export interface SourceReplace extends SourceScope {
  contentHash: string;
  /** Each chunk must carry the source's tenantId and tag set; chunkIndex is its array position. */
  chunks: MemoryInsert[];
}
export interface StorageAdapter {
  /** Fixed vector dimension, shared across bundled entrypoints. */
  readonly embeddingDimensions?: number;
  close?(): Promise<void>;
  /** Commit all callback writes together, or leave storage unchanged on failure. */
  transaction?<T>(operation: (storage: StorageAdapter) => Promise<T>): Promise<T>;
  insertMemories(memories: MemoryInsert[]): Promise<Memory[]>;
  insertRelationships(relationships: MemoryRelationshipInsert[]): Promise<MemoryRelationship[]>;
  searchVectors(params: {
    tenantId: string;
    embedding: number[];
    containerTags: string[];
    filters?: Record<string, any>;
    topK: number;
    threshold?: number;
  }): Promise<Memory[]>;
  getMemory(scope: MemoryScope & { id: string }): Promise<Memory | null>;
  updateMemory(input: MemoryUpdate): Promise<Memory>;
  deleteMemory(input: MemoryDelete): Promise<void>;
  /** Hash and count of the source's live chunks, or null when it has none. */
  getSourceState(scope: SourceScope): Promise<SourceState | null>;
  /**
   * Atomically soft-deletes every live chunk of the source and inserts `chunks`,
   * serialized per source. Concurrent calls leave exactly one call's chunks live.
   * An empty `chunks` list leaves the source without live chunks.
   */
  replaceSource(input: SourceReplace): Promise<Memory[]>;
  /** Soft-deletes every live chunk of the source and returns how many it deleted. */
  deleteSource(scope: SourceScope): Promise<number>;
}

export function requireScope(tenantId: string | undefined, tags: string[] | undefined): asserts tenantId is string {
  if (typeof tenantId !== 'string' || !tenantId.trim() || !Array.isArray(tags) || tags.some(tag => typeof tag !== 'string' || !tag.trim())) {
    throw new Error('MEMORY_SCOPE_REQUIRED');
  }
}

/** Validates a source scope and returns its tag set in canonical (sorted, unique) form. */
export function requireSourceScope(scope: SourceScope): string[] {
  requireScope(scope.tenantId, scope.containerTags);
  if (typeof scope.sourceKey !== 'string' || !scope.sourceKey.trim()) throw new Error('MEMORY_SOURCE_KEY_REQUIRED');
  return [...new Set(scope.containerTags)].sort();
}

export function sameTagSet(left: string[], right: string[]): boolean {
  const a = new Set(left); const b = new Set(right);
  return a.size === b.size && [...a].every(tag => b.has(tag));
}

/** Validates a replacement before any write: hash present and every chunk in the source's scope. */
export function requireSourceReplace(input: SourceReplace): string[] {
  const tags = requireSourceScope(input);
  if (typeof input.contentHash !== 'string' || !input.contentHash.trim()) throw new Error('MEMORY_SOURCE_HASH_REQUIRED');
  if (!Array.isArray(input.chunks)) throw new Error('MEMORY_SOURCE_CHUNKS_REQUIRED');
  for (const chunk of input.chunks) {
    if (!chunk || chunk.tenantId !== input.tenantId || !Array.isArray(chunk.containerTags) || !sameTagSet(chunk.containerTags, input.containerTags)) {
      throw new Error('MEMORY_SOURCE_SCOPE_MISMATCH');
    }
  }
  return tags;
}

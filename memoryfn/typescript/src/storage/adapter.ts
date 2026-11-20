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

/** Code-unit order, independent of the runtime locale. */
export function compareCodeUnits(left: string, right: string): number {
  if (left < right) return -1;
  return left > right ? 1 : 0;
}

/**
 * An unpaired UTF-16 surrogate. PostgreSQL text encodes it as U+FFFD, so two
 * different strings would name one stored source. The memory adapter would keep
 * them distinct, so the source path rejects them in every adapter.
 * (A regex rather than String#isWellFormed, which needs Node 20.)
 */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
/** PostgreSQL text rejects NUL while the memory adapter would store it. */
const NUL = String.fromCharCode(0);

/** A non-empty string that every adapter stores and compares unchanged. */
function isSourceText(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '' && !value.includes(NUL) && !LONE_SURROGATE.test(value);
}

/**
 * Source tags must all be non-empty, storable strings. Unlike Array#some, this
 * visits the holes of a sparse array, which would otherwise be stored as missing tags.
 */
function requireSourceTags(tags: unknown): asserts tags is string[] {
  if (!Array.isArray(tags)) throw new Error('MEMORY_SCOPE_REQUIRED');
  for (let index = 0; index < tags.length; index++) {
    if (!isSourceText(tags[index])) throw new Error('MEMORY_SCOPE_REQUIRED');
  }
}

/** A source scope copied at call time, with its tag set in canonical (sorted, unique) form. */
export interface SourceSnapshot { scope: SourceScope; tags: string[] }
export interface SourceReplaceSnapshot extends SourceSnapshot { contentHash: string; chunks: MemoryInsert[] }

/**
 * Validates a source scope and copies it, so a caller that changes its input
 * while a write waits for the source lock cannot retarget that write.
 */
export function requireSourceScope(input: SourceScope): SourceSnapshot {
  const { tenantId, containerTags, sourceKey } = input;
  requireScope(tenantId, containerTags);
  requireSourceTags(containerTags);
  if (!isSourceText(tenantId)) throw new Error('MEMORY_SCOPE_REQUIRED');
  if (typeof sourceKey !== 'string' || !sourceKey.trim()) throw new Error('MEMORY_SOURCE_KEY_REQUIRED');
  if (!isSourceText(sourceKey)) throw new Error('MEMORY_SCOPE_REQUIRED');
  const scope: SourceScope = { tenantId, containerTags: [...containerTags], sourceKey };
  return { scope, tags: [...new Set(scope.containerTags)].sort(compareCodeUnits) };
}

export function sameTagSet(left: string[], right: string[]): boolean {
  const a = new Set(left); const b = new Set(right);
  return a.size === b.size && [...a].every(tag => b.has(tag));
}

/**
 * Validates a replacement before any write (hash present, every chunk in the
 * source's scope) and copies the scope and chunks it will write.
 */
export function requireSourceReplace(input: SourceReplace): SourceReplaceSnapshot {
  const { scope, tags } = requireSourceScope(input);
  const { contentHash, chunks } = input;
  if (!isSourceText(contentHash)) throw new Error('MEMORY_SOURCE_HASH_REQUIRED');
  if (!Array.isArray(chunks)) throw new Error('MEMORY_SOURCE_CHUNKS_REQUIRED');
  const copies = [...chunks].map((chunk): MemoryInsert => {
    if (!chunk || chunk.tenantId !== scope.tenantId) throw new Error('MEMORY_SOURCE_SCOPE_MISMATCH');
    requireSourceTags(chunk.containerTags);
    if (!sameTagSet(chunk.containerTags, scope.containerTags)) throw new Error('MEMORY_SOURCE_SCOPE_MISMATCH');
    return {
      ...chunk, tenantId: scope.tenantId, containerTags: [...scope.containerTags],
      ...(chunk.embedding ? { embedding: [...chunk.embedding] } : {}),
      ...(chunk.metadata === undefined ? {} : { metadata: structuredClone(chunk.metadata) }),
    };
  });
  return { scope, tags, contentHash, chunks: copies };
}

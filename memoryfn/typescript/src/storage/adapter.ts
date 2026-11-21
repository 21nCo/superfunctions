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

// Input limits shared by every adapter. A source call over a limit is rejected
// with MemorySourceLimitError before any lock or write.
/** Most chunks one replaceSource call may write. */
export const MAX_SOURCE_CHUNKS = 16_384;
/**
 * Most bytes of chunk data one replaceSource call may write: the UTF-8 bytes of
 * each chunk's type (an omitted or empty type counts as the 'conversational'
 * written for it), content, JSON-serialized metadata and JSON-serialized
 * embedding. The content hash and the scope tags are not counted.
 */
export const MAX_SOURCE_REPLACE_BYTES = 256 * 1024 * 1024;
/** Most UTF-8 bytes of a source's tenantId, of its sourceKey and of a replacement's contentHash, each. */
export const MAX_SOURCE_IDENTITY_BYTES = 1024;
/** Most UTF-8 bytes of a source's distinct container tags together (a repeated tag counts once). */
export const MAX_SOURCE_TAG_BYTES = 64 * 1024;
/** Rejects a source call over one of the limits above; `code` is stable for callers to test. */
export class MemorySourceLimitError extends Error {
  readonly code = 'MEMORY_SOURCE_LIMIT_EXCEEDED' as const;
  constructor() {
    super('MEMORY_SOURCE_LIMIT_EXCEEDED');
    this.name = 'MemorySourceLimitError';
  }

  /**
   * Each package entry point (the root and ./storage/pg) bundles its own copy
   * of this class, so besides the ordinary prototype check `instanceof` matches
   * the error of another copy by its name and code. A subclass keeps only the
   * ordinary check.
   */
  static [Symbol.hasInstance](value: unknown): boolean {
    if (Function.prototype[Symbol.hasInstance].call(this, value)) return true;
    return this === MemorySourceLimitError && value instanceof Error && value.name === 'MemorySourceLimitError'
      && (value as { code?: unknown }).code === 'MEMORY_SOURCE_LIMIT_EXCEEDED';
  }
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
 * UTF-8 length of `value` as PostgreSQL stores it (a lone surrogate becomes the
 * 3-byte U+FFFD), counted without encoding it or any runtime-specific API.
 */
function utf8Bytes(value: string): number {
  let bytes = value.length;
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index);
    if (unit < 0x80) continue;
    if (unit < 0x800) { bytes += 1; continue; }
    // A surrogate pair is 2 units and 4 bytes; any other unit here is 3 bytes.
    if (unit >= 0xD800 && unit <= 0xDBFF && (value.charCodeAt(index + 1) & 0xFC00) === 0xDC00) index++;
    bytes += 2;
  }
  return bytes;
}

function sourceLimitExceeded(): Error { return new MemorySourceLimitError(); }

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

/** A source scope copied at call time. */
export interface SourceSnapshot { scope: SourceScope }
export interface SourceReplaceSnapshot extends SourceSnapshot { contentHash: string; chunks: MemoryInsert[] }

/**
 * Validates a source scope and copies it, so a caller that changes its input
 * while a write waits for the source lock cannot retarget that write.
 */
export function requireSourceScope(input: SourceScope): SourceSnapshot {
  const { tenantId, sourceKey } = input;
  // Copied by index (holes become undefined), so the tags validated are the tags used.
  const given: unknown = input.containerTags;
  const containerTags = Array.isArray(given) ? Array.from({ length: given.length }, (_, index): unknown => given[index]) : given;
  requireScope(tenantId, containerTags as string[]);
  requireSourceTags(containerTags);
  if (!isSourceText(tenantId)) throw new Error('MEMORY_SCOPE_REQUIRED');
  if (typeof sourceKey !== 'string' || !sourceKey.trim()) throw new Error('MEMORY_SOURCE_KEY_REQUIRED');
  if (!isSourceText(sourceKey)) throw new Error('MEMORY_SCOPE_REQUIRED');
  if (utf8Bytes(tenantId) > MAX_SOURCE_IDENTITY_BYTES || utf8Bytes(sourceKey) > MAX_SOURCE_IDENTITY_BYTES) throw sourceLimitExceeded();
  let tagBytes = 0;
  for (const tag of new Set(containerTags)) tagBytes += utf8Bytes(tag);
  if (tagBytes > MAX_SOURCE_TAG_BYTES) throw sourceLimitExceeded();
  const scope: SourceScope = { tenantId, containerTags, sourceKey };
  return { scope };
}

export function sameTagSet(left: string[], right: string[]): boolean {
  const a = new Set(left); const b = new Set(right);
  return a.size === b.size && [...a].every(tag => b.has(tag));
}

/**
 * UTF-8 bytes of the JSON text of `value`. A value whose JSON text exceeds the
 * runtime's string capacity (a RangeError) is far over MAX_SOURCE_REPLACE_BYTES.
 */
function jsonBytes(value: unknown): number {
  try {
    return utf8Bytes(JSON.stringify(value));
  } catch (error) {
    if (error instanceof RangeError) throw sourceLimitExceeded();
    throw error;
  }
}

/** Bytes a copied (normalized) chunk adds to a replacement, as MAX_SOURCE_REPLACE_BYTES counts them. */
function chunkBytes(chunk: MemoryInsert): number {
  return utf8Bytes(chunk.type!) + utf8Bytes(chunk.content!) + jsonBytes(chunk.metadata ?? {})
    + (chunk.embedding ? jsonBytes(chunk.embedding) : 0);
}

type ChunkFields = Pick<MemoryInsert, 'type' | 'content' | 'id' | 'isLatest'>;
/**
 * A chunk's fields in the form every adapter writes: a missing or empty type
 * becomes 'conversational' and missing content ''. A type, content, id or
 * isLatest of another type is rejected, so no adapter stores it differently or
 * writes a value the limits did not count.
 */
function chunkFields({ type, content, id, isLatest }: ChunkFields): ChunkFields {
  if ((type != null && typeof type !== 'string') || (content != null && typeof content !== 'string')
    || (id != null && (typeof id !== 'string' || id === '')) || (isLatest != null && typeof isLatest !== 'boolean')) {
    throw new Error('MEMORY_SOURCE_CHUNK_INVALID');
  }
  return { type: type || 'conversational', content: content ?? '', ...(id == null ? {} : { id }), ...(isLatest == null ? {} : { isLatest }) };
}

/**
 * Validates a replacement before any write (hash present, every chunk in the
 * source's scope, within the source limits) and copies the scope and chunks it
 * will write.
 */
export function requireSourceReplace(input: SourceReplace): SourceReplaceSnapshot {
  const { scope } = requireSourceScope(input);
  const { contentHash, chunks } = input;
  if (!isSourceText(contentHash)) throw new Error('MEMORY_SOURCE_HASH_REQUIRED');
  if (utf8Bytes(contentHash) > MAX_SOURCE_IDENTITY_BYTES) throw sourceLimitExceeded();
  if (!Array.isArray(chunks)) throw new Error('MEMORY_SOURCE_CHUNKS_REQUIRED');
  // The length is checked before the array is read, and the copy is taken by index, not through its iterator.
  const count = chunks.length;
  if (count > MAX_SOURCE_CHUNKS) throw sourceLimitExceeded();
  const given = Array.from({ length: count }, (_, index) => chunks[index]);
  let bytes = 0;
  // Each chunk is copied first, reading every field once, and the copy that the
  // adapters write is the value measured.
  const copies = given.map((chunk): MemoryInsert => {
    if (!chunk || chunk.tenantId !== scope.tenantId) throw new Error('MEMORY_SOURCE_SCOPE_MISMATCH');
    requireSourceTags(chunk.containerTags);
    if (!sameTagSet(chunk.containerTags, scope.containerTags)) throw new Error('MEMORY_SOURCE_SCOPE_MISMATCH');
    const { embedding, metadata, type, content, id, isLatest, ...fields } = chunk;
    const copy: MemoryInsert = {
      ...fields, ...chunkFields({ type, content, id, isLatest }), tenantId: scope.tenantId, containerTags: [...scope.containerTags],
      ...(embedding ? { embedding: [...embedding] } : {}),
      ...(metadata === undefined ? {} : { metadata: structuredClone(metadata) }),
    };
    bytes += chunkBytes(copy);
    if (bytes > MAX_SOURCE_REPLACE_BYTES) throw sourceLimitExceeded();
    return copy;
  });
  return { scope, contentHash, chunks: copies };
}

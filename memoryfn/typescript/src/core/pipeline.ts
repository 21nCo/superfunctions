import { MemoryFnConfig, IMemoryFn, validateMemoryPolicies } from './config';
import {
  AddMemoryInput, AddMemoryResult, SearchMemoryInput, SearchMemoryResult, Memory, MemoryRelationship,
  UpsertDocumentInput, UpsertDocumentResult, ForgetSourceInput, ForgetSourceResult, MEMORY_TYPES,
} from './types';
import {
  requireScope, requireSourceScope, requireSourceHash, sourceChunkBytesBeforeEmbedding, sourceMetadataBytes, sourceTagsBytes,
  sourceEmbeddingBytes, storableMetadataBytes, isStorableText,
  MAX_SOURCE_CHUNKS, MAX_SOURCE_REPLACE_BYTES, MemorySourceLimitError,
  type StorageAdapter, type MemoryScope, type MemoryDelete, type MemoryInsert,
} from '../storage/adapter';
import { markdownChunks, resolveChunkingOptions } from '../chunking/markdown';
import { Embedder, LLMProvider } from '../providers/types';
import { FactExtractor } from '../extraction/facts';
import { Deduplicator, searchOrdinaryCandidates } from '../extraction/dedup';
import { ConflictResolver } from '../extraction/resolver';

export class MemoryFn implements IMemoryFn {
  private storage: StorageAdapter;
  private embedder?: Embedder;
  private llm?: LLMProvider;
  private extractor?: FactExtractor;
  private deduplicator: Deduplicator;
  private resolver?: ConflictResolver;

  constructor(_config: MemoryFnConfig, storage: StorageAdapter, embedder?: Embedder, llm?: LLMProvider) {
    validateMemoryPolicies(_config);
    this.storage = storage;
    this.embedder = embedder;
    this.llm = llm;
    if (this.llm) {
      this.extractor = new FactExtractor(this.llm);
      this.resolver = new ConflictResolver(this.llm);
    }
    this.deduplicator = new Deduplicator(this.storage, 0.95);
  }

  async add(input: AddMemoryInput): Promise<AddMemoryResult> {
    const tenantId = input.tenantId;
    requireScope(tenantId, input.containerTags);
    const content = input.content ?? input.messages?.map(message => `${message.role}: ${message.content}`).join('\n') ?? '';
    if (!content.trim()) throw new Error('MEMORY_CONTENT_REQUIRED');
    const facts = this.extractor ? await this.extractor.extract(content) : [{ content, type: input.type ?? 'conversational', tags: [], confidence: 1 }];
    const embeddings = this.embedder ? await this.embedder.embedBatch(facts.map(fact => fact.content)) : [];
    if (this.embedder && embeddings.length !== facts.length) throw new Error('MEMORY_EMBEDDING_COUNT_MISMATCH');
    const saved: Memory[] = [];
    const relationships: MemoryRelationship[] = [];
    let deduplicated = 0;
    let updated = 0;
    for (let i = 0; i < facts.length; i++) {
      const fact = facts[i];
      // Model-generated tags are descriptive metadata, never authority or scope.
      const tags = [...input.containerTags];
      const embedding = embeddings[i] ?? null;
      if (embedding && await this.deduplicator.findDuplicate(tenantId, embedding, tags)) { deduplicated++; continue; }
      // Source chunks and facts are never superseded or linked: their source alone owns their lifecycle.
      const related = embedding && this.resolver ? await searchOrdinaryCandidates(this.storage, { tenantId, containerTags: tags, embedding, threshold: 0.75 }, 3) : [];
      const resolutions = this.resolver ? await Promise.all(related.map(async memory => ({ memory, resolution: await this.resolver!.resolve(fact.content, memory) }))) : [];
      const persist = async (storage: StorageAdapter) => {
        const links: MemoryRelationship[] = [];
        let count = 0;
        const [memory] = await storage.insertMemories([{
          tenantId, containerTags: tags, content: fact.content, type: fact.type,
          embedding, metadata: { ...input.metadata, extractedTags: fact.tags, confidence: fact.confidence }, isLatest: true,
        }]);

        for (const { memory: existing, resolution } of resolutions) {
          if (resolution.type === 'none') continue;
          if (resolution.type === 'updates') {
            await storage.updateMemory({ tenantId, containerTags: tags, id: existing.id,
              expectedRevision: existing.revision ?? 1,
              changes: { content: existing.content, embedding: existing.embedding, isLatest: false } });
            count++;
          }
          links.push(...await storage.insertRelationships([{
            tenantId, containerTags: tags,
            fromId: memory.id, toId: existing.id, type: resolution.type, confidence: 1, reasoning: resolution.reasoning,
          }]));
        }
        return { memory, links, count };
      };
      const hasConflicts = resolutions.some(item => item.resolution.type !== "none");
      if (hasConflicts && !this.storage.transaction) throw new Error("MEMORY_TRANSACTION_REQUIRED");
      const committed = hasConflicts ? await this.storage.transaction!(persist) : await persist(this.storage);
      saved.push(committed.memory); relationships.push(...committed.links); updated += committed.count;
    }
    return { memories: saved, relationships, summary: { created: saved.length, updated, deduplicated } };
  }

  /**
   * Stores `content` as embedded chunks of the source (tenantId, exact
   * containerTags set, sourceKey), atomically replacing its previous chunks.
   * When the stored hash equals the incoming one nothing is embedded or written;
   * the hash is compared again inside the storage write, so of concurrent
   * identical calls at most one writes and the others report unchanged.
   * With `extract: true` the facts extracted from each chunk are stored in place
   * of the chunks, under the same source; they are not deduplicated against or
   * linked to other memories, so forgetBySource removes everything it wrote.
   * Input and the source limits are checked before the provider call they
   * would waste, and a rejected call leaves the source unchanged.
   */
  async upsertDocument(input: UpsertDocumentInput): Promise<UpsertDocumentResult> {
    const { scope: given } = requireSourceScope(input);
    // A source ignores tag order and repeats, so its records store the distinct tags once each.
    const scope = { ...given, containerTags: [...new Set(given.containerTags)] };
    const { content, contentHash: givenHash, type, extract, chunking } = input;
    if (typeof content !== 'string' || !content.trim()) throw new Error('MEMORY_CONTENT_REQUIRED');
    // Hashed as UTF-8, a lone surrogate would alias U+FFFD, and PostgreSQL rejects NUL after embedding.
    if (!isStorableText(content)) throw new Error('MEMORY_CONTENT_INVALID');
    if (givenHash !== undefined) requireSourceHash(givenHash);
    if (type !== undefined && !(MEMORY_TYPES as readonly unknown[]).includes(type)) throw new Error('MEMORY_TYPE_INVALID');
    if (extract !== undefined && typeof extract !== 'boolean') throw new Error('MEMORY_EXTRACT_INVALID');
    const options = resolveChunkingOptions(chunking);
    if (!this.embedder) throw new Error('MEMORY_EMBEDDER_REQUIRED');
    // Never emulated by a state read and replaceSource: that would race concurrent identical upserts.
    if (typeof this.storage.replaceSourceIfChanged !== 'function') throw new Error('MEMORY_DOCUMENTS_UNSUPPORTED');
    if (extract && !this.extractor) throw new Error('MEMORY_LLM_REQUIRED');
    // One detached JSON copy of the caller's metadata is measured, checked and written, so changing it meanwhile changes nothing.
    const metadata = metadataSnapshot(input.metadata);
    const metadataBytes = storableMetadataBytes(metadata);
    const tagsBytes = sourceTagsBytes(scope.containerTags);
    const contentHash = givenHash ?? await sha256Hex(content);

    const state = await this.storage.getSourceState(scope);
    if (state && state.contentHash === contentHash) {
      return { sourceKey: scope.sourceKey, contentHash, unchanged: true, chunks: state.chunkCount, memories: [] };
    }

    // Every record costs its type, content and metadata bytes (as replaceSource
    // counts them), its copy of the tag array and its embedding. The count and
    // the bytes known before embedding are checked as each chunk or fact is
    // produced, so an oversized source fails before the rest is split, extracted
    // or copied, and before embedding; the embeddings are added before the write.
    const overLimit = () => new MemorySourceLimitError();
    let bytes = 0;
    const charge = (recordType: string, text: string, recordMetadataBytes: number) => {
      bytes += sourceChunkBytesBeforeEmbedding(recordType, text, recordMetadataBytes) + tagsBytes;
      if (bytes > MAX_SOURCE_REPLACE_BYTES) throw overLimit();
    };
    const chunkType = type ?? 'document';
    const chunks: string[] = [];
    for (const chunk of markdownChunks(content, options)) {
      if (chunks.length === MAX_SOURCE_CHUNKS) throw overLimit();
      if (!extract) charge(chunkType, chunk, metadataBytes);
      chunks.push(chunk);
    }
    const records: Array<Pick<MemoryInsert, 'content' | 'type' | 'metadata'>> = [];
    if (extract) {
      for (let index = 0; index < chunks.length; index++) {
        await this.extractor!.extract(chunks[index], {
          maxFacts: MAX_SOURCE_CHUNKS - records.length,
          tooMany: overLimit,
          accept: fact => {
            // Stored as text and JSON on every adapter, so a NUL or lone surrogate fails here, before embedding.
            if (!isStorableText(fact.content) || !fact.tags.every(isStorableText)) throw new Error('MEMORY_EXTRACTION_INVALID');
            // Model-generated tags are descriptive metadata, never authority or scope.
            const record = { content: fact.content, type: fact.type,
              metadata: { ...metadata, extractedTags: fact.tags, confidence: fact.confidence, sourceChunk: index } };
            charge(record.type, record.content, sourceMetadataBytes(record.metadata));
            records.push(record);
          },
        });
      }
    } else {
      for (const chunk of chunks) records.push({ content: chunk, type: chunkType, metadata: { ...metadata } });
    }
    const batch: unknown = records.length ? await this.embedder.embedBatch(records.map(record => record.content!)) : [];
    // Plain copies of the embedder's values, each charged before the next is made: what is charged is exactly what storage receives.
    const embeddings = storableEmbeddings(batch, records.length, this.storage.embeddingDimensions, embedding => {
      bytes += sourceEmbeddingBytes(embedding);
      if (bytes > MAX_SOURCE_REPLACE_BYTES) throw overLimit();
    });
    const written = await this.storage.replaceSourceIfChanged!({
      ...scope, contentHash,
      chunks: records.map((record, index) => ({ ...record, tenantId: scope.tenantId, containerTags: scope.containerTags, embedding: embeddings[index], isLatest: true })),
    });
    if (written.unchanged) {
      return { sourceKey: scope.sourceKey, contentHash, unchanged: true, chunks: written.state.chunkCount, memories: [] };
    }
    return { sourceKey: scope.sourceKey, contentHash, unchanged: false, chunks: written.memories.length, memories: written.memories };
  }

  /** Soft-deletes every live chunk and fact of the source (tenantId, exact containerTags set, sourceKey). */
  async forgetBySource(input: ForgetSourceInput): Promise<ForgetSourceResult> {
    const { scope } = requireSourceScope(input);
    return { sourceKey: scope.sourceKey, deleted: await this.storage.deleteSource(scope) };
  }

  async close(): Promise<void> { await this.storage.close?.(); }

  async update(input: MemoryScope & { id: string; expectedRevision: number; content: string; metadata?: Record<string, unknown> }): Promise<Memory> {
    const current = await this.storage.getMemory(input);
    if (!current) throw new Error('MEMORY_NOT_FOUND');
    const embedding = this.embedder ? await this.embedder.embed(input.content) : null;
    return this.storage.updateMemory({ ...input, changes: { content: input.content, embedding, ...(input.metadata === undefined ? {} : { metadata: input.metadata }) } });
  }

  async forget(input: MemoryDelete): Promise<void> { await this.storage.deleteMemory(input); }

  async search(input: SearchMemoryInput): Promise<SearchMemoryResult> {
    requireScope(input.tenantId, input.containerTags);
    if (!this.embedder) throw new Error('MEMORY_EMBEDDER_REQUIRED');
    const embedding = await this.embedder.embed(input.q);
    // A query no built-in adapter can score is an error, not an empty result; any other query is sent as embedded.
    if (!Array.isArray(embedding) || embedding.length === 0 || !inCosineRange(embedding)) throw new Error('MEMORY_EMBEDDING_INVALID');

    // 2. Vector search
    const results = await this.storage.searchVectors({
      tenantId: input.tenantId!,
      embedding,
      containerTags: input.containerTags,
      filters: input.filters,
      topK: input.limit || 10,
      threshold: input.threshold
    });

    return {
      results,
      metadata: {
        totalFound: results.length,
        returned: results.length
      }
    };
  }
}

/**
 * A detached plain copy of caller metadata, as JSON can hold it, so later
 * changes to the caller's objects, accessors or shared memory cannot change
 * what is measured or written. Metadata structuredClone cannot copy (such as a
 * function) or JSON cannot express (a cycle, a BigInt) is MEMORY_METADATA_INVALID;
 * metadata too large to serialize is MemorySourceLimitError.
 */
function metadataSnapshot(metadata: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (metadata === undefined) return undefined;
  let text: string | undefined;
  try {
    // Serialized at once from the clone, so no caller code runs between the copy and its JSON.
    text = JSON.stringify(structuredClone(metadata));
  } catch (error) {
    if (error instanceof RangeError) throw new MemorySourceLimitError();
    throw new Error('MEMORY_METADATA_INVALID');
  }
  if (text === undefined) throw new Error('MEMORY_METADATA_INVALID');
  return JSON.parse(text) as Record<string, unknown>;
}

/** Lowercase hex SHA-256 of the UTF-8 bytes of `text`. */
export async function sha256Hex(text: string): Promise<string> {
  const subtle = globalThis.crypto?.subtle ?? (await import('node:crypto')).webcrypto.subtle;
  const digest = await subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

/** Smallest positive normal and largest finite float32: pgvector's components and sums are float32. */
const FLOAT32_MIN_NORMAL = 2 ** -126;
const FLOAT32_MAX = 3.4028234663852886e38;

/**
 * Whether every built-in adapter can compute the cosine of `vector`: finite
 * numbers whose sum of squares (float64) is at most FLOAT32_MAX and whose
 * largest square is at least FLOAT32_MIN_NORMAL, so its norm neither
 * overflows nor vanishes in the memory adapter's float64 or pgvector's float32.
 */
function inCosineRange(vector: readonly unknown[]): boolean {
  let squares = 0;
  let largest = 0;
  // Read by index, so a hole in a sparse array is seen as a missing number.
  for (let at = 0; at < vector.length; at++) {
    const number = vector[at];
    if (typeof number !== 'number' || !Number.isFinite(number)) return false;
    squares += number * number;
    largest = Math.max(largest, number * number);
  }
  return squares <= FLOAT32_MAX && largest >= FLOAT32_MIN_NORMAL;
}

/**
 * Plain copies of an embedding batch, with the embedder's values unchanged, so
 * a query from the same embedder scores a chunk exactly as it scores an add()
 * memory: `count` non-empty vectors with one shared length, equal to the
 * storage's fixed dimension when it has one, each inCosineRange. Anything
 * else is rejected before the source is touched (MEMORY_EMBEDDING_COUNT_MISMATCH
 * or MEMORY_EMBEDDING_INVALID), so the previous chunks stay live and
 * searchable. `accept` sees each copy before the next vector is read, and may
 * throw to stop.
 */
function storableEmbeddings(value: unknown, count: number, dimensions: number | undefined, accept: (copy: number[]) => void): number[][] {
  if (!Array.isArray(value) || value.length !== count) throw new Error('MEMORY_EMBEDDING_COUNT_MISMATCH');
  let size = dimensions;
  const copies: number[][] = [];
  for (let index = 0; index < count; index++) {
    const vector: unknown = value[index];
    if (!Array.isArray(vector) || vector.length === 0 || (size !== undefined && vector.length !== size)) throw new Error('MEMORY_EMBEDDING_INVALID');
    size = vector.length;
    // Copied before it is checked, so the values checked are the values stored.
    const copy: unknown[] = [];
    for (let at = 0; at < size; at++) copy.push(vector[at]);
    if (!inCosineRange(copy)) throw new Error('MEMORY_EMBEDDING_INVALID');
    accept(copy as number[]);
    copies.push(copy as number[]);
  }
  return copies;
}

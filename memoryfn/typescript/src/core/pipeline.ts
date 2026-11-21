import { MemoryFnConfig, IMemoryFn, validateMemoryPolicies } from './config';
import {
  AddMemoryInput, AddMemoryResult, SearchMemoryInput, SearchMemoryResult, Memory, MemoryRelationship,
  UpsertDocumentInput, UpsertDocumentResult, ForgetSourceInput, ForgetSourceResult, MEMORY_TYPES,
} from './types';
import {
  requireScope, requireSourceScope, requireSourceHash, sourceChunkBytesBeforeEmbedding, sourceMetadataBytes, sourceTagsBytes,
  storableMetadataBytes, isStorableText,
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
    // One plain JSON-data copy of the caller's metadata is measured, checked and written, so changing it meanwhile changes nothing.
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
    const embeddings = storableEmbeddings(batch, records.length, this.storage.embeddingDimensions, jsonBytes => {
      bytes += jsonBytes;
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
 * A plain copy of caller metadata as JSON data: plain objects (from any realm),
 * dense arrays, strings, finite numbers, booleans and null, each property read
 * once, so later changes to the caller's objects cannot change what is
 * measured or written. An object property that is undefined is left out, as
 * JSON does. Anything else (such as a Map, Date, class instance, typed array,
 * BigInt, function or cycle) is MEMORY_METADATA_INVALID, never silently
 * converted, as is metadata whose inspection or reading throws. The copy's
 * JSON bytes (keys, values, escaping and punctuation) are counted as it is
 * made, so metadata whose JSON would pass MAX_SOURCE_REPLACE_BYTES, through
 * repeated references or large keys included, is MemorySourceLimitError before
 * it is serialized, as is nesting deeper than the stack allows.
 */
function metadataSnapshot(metadata: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (metadata === undefined) return undefined;
  const invalid = () => new Error('MEMORY_METADATA_INVALID');
  /** Runs caller code (getters, proxies); whatever it throws is invalid metadata. */
  const read = <T>(get: () => T): T => { try { return get(); } catch { throw invalid(); } };
  const open = new Set<object>();
  let size = 0;
  const charge = (bytes: number) => {
    size += bytes;
    if (size > MAX_SOURCE_REPLACE_BYTES) throw new MemorySourceLimitError();
  };
  const chargeString = (text: string) => {
    // A string's JSON is never shorter than its length plus the quotes, so a huge one stops before it is scanned.
    charge(text.length + 2);
    charge(jsonStringBytes(text) - text.length - 2);
  };
  const copy = (value: unknown): unknown => {
    if (value === null) { charge(4); return value; }
    if (typeof value === 'string') { chargeString(value); return value; }
    if (typeof value === 'boolean') { charge(value ? 4 : 5); return value; }
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) throw invalid();
      // JSON writes a finite number as String() does (-0 as 0).
      charge(String(value).length);
      return value;
    }
    if (typeof value !== 'object' || open.has(value)) throw invalid();
    const isArray = read(() => Array.isArray(value));
    // A plain object's prototype is null or some realm's Object.prototype, whose own prototype is null.
    const prototype = isArray ? null : read(() => Object.getPrototypeOf(value));
    if (prototype !== null && read(() => Object.getPrototypeOf(prototype)) !== null) throw invalid();
    open.add(value);
    let result: unknown;
    if (isArray) {
      const items: unknown[] = [];
      const array = value as unknown[];
      const count = read(() => array.length);
      if (!Number.isSafeInteger(count) || count < 0) throw invalid();
      // Brackets and separators, before any item is read.
      charge(2 + Math.max(0, count - 1));
      for (let index = 0; index < count; index++) {
        const item: unknown = read(() => array[index]);
        if (item === undefined) throw invalid();
        items.push(copy(item));
      }
      result = items;
    } else {
      const entries: Record<string, unknown> = {};
      const object = value as Record<string, unknown>;
      let written = 0;
      charge(2);
      for (const key of read(() => Object.keys(object))) {
        const item: unknown = read(() => object[key]);
        if (item === undefined) continue;
        // The separator, the quoted key and its colon, before the value is copied.
        charge(written++ ? 2 : 1);
        chargeString(key);
        // Defined, not assigned, so a "__proto__" key stays an own data property.
        Object.defineProperty(entries, key, { value: copy(item), enumerable: true, writable: true, configurable: true });
      }
      result = entries;
    }
    open.delete(value);
    return result;
  };
  if (metadata === null || typeof metadata !== 'object' || read(() => Array.isArray(metadata))) throw invalid();
  try {
    return copy(metadata) as Record<string, unknown>;
  } catch (error) {
    // Nesting deeper than the stack allows is over the limit, as JSON serialization would be.
    if (error instanceof RangeError) throw new MemorySourceLimitError();
    throw error;
  }
}

/** UTF-8 bytes of JSON.stringify(text), counted without serializing it. */
function jsonStringBytes(text: string): number {
  let bytes = 2;
  for (let index = 0; index < text.length; index++) {
    const unit = text.charCodeAt(index);
    if (unit === 0x22 || unit === 0x5C) bytes += 2;
    else if (unit < 0x20) bytes += unit === 8 || unit === 9 || unit === 10 || unit === 12 || unit === 13 ? 2 : 6;
    else if (unit < 0x80) bytes += 1;
    else if (unit < 0x800) bytes += 2;
    else if (unit >= 0xD800 && unit <= 0xDBFF && (text.charCodeAt(index + 1) & 0xFC00) === 0xDC00) { bytes += 4; index++; }
    // A lone surrogate is written as a \uXXXX escape.
    else if (unit >= 0xD800 && unit <= 0xDFFF) bytes += 6;
    else bytes += 3;
  }
  return bytes;
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
 * A plain copy of `value` if it is a non-empty array of finite numbers (of
 * `size` numbers when given), with its float64 sum of squares and largest
 * square; otherwise null. Each number is read once, checked and copied
 * before the next is read, and `charge` is given the JSON bytes of each
 * copied number and its separator, and of the opening bracket, and may throw
 * to stop: an oversized or malformed vector costs no more than its prefix.
 */
function plainVector(value: unknown, size: number | undefined, charge: (jsonBytes: number) => void): { values: number[]; squares: number; largest: number } | null {
  if (!Array.isArray(value)) return null;
  // Read once: the length checked is the length copied.
  const count = value.length;
  if (count === 0 || (size !== undefined && count !== size)) return null;
  const values: number[] = [];
  let squares = 0;
  let largest = 0;
  charge(1);
  for (let at = 0; at < count; at++) {
    const number: unknown = value[at];
    if (typeof number !== 'number' || !Number.isFinite(number)) return null;
    // JSON writes a finite number as String() does (-0 as 0), followed by a comma or the closing bracket.
    charge(String(number).length + 1);
    values.push(number);
    squares += number * number;
    largest = Math.max(largest, number * number);
  }
  return { values, squares, largest };
}

/**
 * Plain copies of an embedding batch, with the embedder's values unchanged, so
 * a query from the same embedder scores a chunk exactly as it scores an add()
 * memory: `count` non-empty vectors of finite numbers with one shared length,
 * equal to the storage's fixed dimension when it has one. Each must be
 * scorable by every built-in adapter: its largest square at least float32's
 * smallest normal value, and its sum of squares, with room for float32
 * rounding of each component, product and partial sum, at most float32's
 * largest value. Anything else is rejected before the source is touched
 * (MEMORY_EMBEDDING_COUNT_MISMATCH or MEMORY_EMBEDDING_INVALID), so the
 * previous chunks stay live and searchable. `charge` sees the JSON bytes of
 * each number as it is copied (see plainVector), and may throw to stop.
 */
function storableEmbeddings(value: unknown, count: number, dimensions: number | undefined, charge: (jsonBytes: number) => void): number[][] {
  if (!Array.isArray(value) || value.length !== count) throw new Error('MEMORY_EMBEDDING_COUNT_MISMATCH');
  let size = dimensions;
  const copies: number[][] = [];
  for (let index = 0; index < count; index++) {
    const vector = plainVector(value[index], size, charge);
    if (!vector) throw new Error('MEMORY_EMBEDDING_INVALID');
    size = vector.values.length;
    // Recursive float32 summation of n terms errs by at most about n units in the last place (2^-24 each).
    const rounding = 1 + (size + 4) * 2 ** -23;
    if (vector.largest < FLOAT32_MIN_NORMAL || vector.squares * rounding > FLOAT32_MAX) throw new Error('MEMORY_EMBEDDING_INVALID');
    copies.push(vector.values);
  }
  return copies;
}

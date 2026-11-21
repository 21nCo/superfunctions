import { MemoryFnConfig, IMemoryFn, validateMemoryPolicies } from './config';
import {
  AddMemoryInput, AddMemoryResult, SearchMemoryInput, SearchMemoryResult, Memory, MemoryRelationship,
  UpsertDocumentInput, UpsertDocumentResult, ForgetSourceInput, ForgetSourceResult,
} from './types';
import { requireScope, requireSourceScope, MAX_SOURCE_CHUNKS, MemorySourceLimitError, type StorageAdapter, type MemoryScope, type MemoryDelete, type MemoryInsert } from '../storage/adapter';
import { chunkMarkdown, resolveChunkingOptions } from '../chunking/markdown';
import { Embedder, LLMProvider } from '../providers/types';
import { FactExtractor } from '../extraction/facts';
import { Deduplicator } from '../extraction/dedup';
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
      const related = embedding && this.resolver ? await this.storage.searchVectors({ tenantId, containerTags: tags, embedding, threshold: 0.75, topK: 3 }) : [];
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
   * When the stored hash equals the incoming one nothing is embedded or written.
   * With `extract: true` the facts extracted from each chunk are stored in place
   * of the chunks, under the same source; they are not deduplicated against or
   * linked to other memories, so forgetBySource removes everything it wrote.
   */
  async upsertDocument(input: UpsertDocumentInput): Promise<UpsertDocumentResult> {
    const { scope } = requireSourceScope(input);
    const { content, contentHash: givenHash, metadata, type, extract, chunking } = input;
    if (typeof content !== 'string' || !content.trim()) throw new Error('MEMORY_CONTENT_REQUIRED');
    if (givenHash !== undefined && (typeof givenHash !== 'string' || !givenHash.trim())) throw new Error('MEMORY_SOURCE_HASH_REQUIRED');
    if (extract !== undefined && typeof extract !== 'boolean') throw new Error('MEMORY_EXTRACT_INVALID');
    const options = resolveChunkingOptions(chunking);
    if (!this.embedder) throw new Error('MEMORY_EMBEDDER_REQUIRED');
    if (extract && !this.extractor) throw new Error('MEMORY_LLM_REQUIRED');
    const contentHash = givenHash ?? await sha256Hex(content);

    const state = await this.storage.getSourceState(scope);
    if (state && state.contentHash === contentHash) {
      return { sourceKey: scope.sourceKey, contentHash, unchanged: true, chunks: state.chunkCount, memories: [] };
    }

    const chunks = chunkMarkdown(content, options);
    // Rejected before any LLM or embedding call; replaceSource would reject the write anyway.
    if (chunks.length > MAX_SOURCE_CHUNKS) throw new MemorySourceLimitError();
    const records: Array<Pick<MemoryInsert, 'content' | 'type' | 'metadata'>> = [];
    if (extract) {
      for (let index = 0; index < chunks.length; index++) {
        // Model-generated tags are descriptive metadata, never authority or scope.
        for (const fact of await this.extractor!.extract(chunks[index])) {
          records.push({ content: fact.content, type: fact.type,
            metadata: { ...metadata, extractedTags: fact.tags, confidence: fact.confidence, sourceChunk: index } });
        }
      }
    } else {
      for (const chunk of chunks) records.push({ content: chunk, type: type ?? 'document', metadata: { ...metadata } });
    }
    if (records.length > MAX_SOURCE_CHUNKS) throw new MemorySourceLimitError();
    const embeddings = records.length ? await this.embedder.embedBatch(records.map(record => record.content!)) : [];
    if (embeddings.length !== records.length) throw new Error('MEMORY_EMBEDDING_COUNT_MISMATCH');
    const memories = await this.storage.replaceSource({
      ...scope, contentHash,
      chunks: records.map((record, index) => ({ ...record, tenantId: scope.tenantId, containerTags: scope.containerTags, embedding: embeddings[index], isLatest: true })),
    });
    return { sourceKey: scope.sourceKey, contentHash, unchanged: false, chunks: memories.length, memories };
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

/** Lowercase hex SHA-256 of the UTF-8 bytes of `text`. */
export async function sha256Hex(text: string): Promise<string> {
  const subtle = globalThis.crypto?.subtle ?? (await import('node:crypto')).webcrypto.subtle;
  const digest = await subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

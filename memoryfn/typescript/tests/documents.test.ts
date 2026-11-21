import { runInNewContext } from 'node:vm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { searchOrdinaryCandidates } from '../src/extraction/dedup';
import { MAX_SOURCE_REPLACE_BYTES, MemoryFn, MemoryStorageAdapter, sha256Hex, sourceChunkBytesBeforeEmbedding, sourceEmbeddingBytes, sourceMetadataBytes, sourceTagsBytes, type Embedder, type LLMProvider, type Memory, type StorageAdapter } from '../src';

/** A deterministic bag-of-letters embedder that records every batch it embeds. */
function fakeEmbedder() {
  const vector = (text: string) => {
    const counts = new Array(26).fill(0);
    for (const char of text.toLowerCase()) { const code = char.charCodeAt(0) - 97; if (code >= 0 && code < 26) counts[code]++; }
    return counts;
  };
  return {
    embed: vi.fn(async (text: string) => vector(text)),
    embedBatch: vi.fn(async (texts: string[]) => texts.map(vector)),
  } satisfies Embedder;
}

/** An LLM that returns one fact per chunk, quoting the chunk's first line. */
function fakeLLM(): LLMProvider {
  return {
    generate: vi.fn(),
    generateJSON: vi.fn(async (prompt: string) => {
      const text = JSON.parse(/<untrusted-data>(\{.*\})<\/untrusted-data>/s.exec(prompt)![1]).text as string;
      return { facts: [{ content: `Fact: ${text.split('\n')[0]}`, type: 'derived', confidence: 0.9, tags: ['doc'] }] };
    }) as LLMProvider['generateJSON'],
  };
}

const scope = { tenantId: 'tenant-a', containerTags: ['docs', 'team:1'], sourceKey: 'guide.md' };
const docV1 = '# Install\n\nRun the installer.\n\n# Configure\n\nSet the region.\n\n# Use\n\nCall the API.';
const docV2 = '# Install\n\nDownload the zip archive.\n\n# Upgrade\n\nReplace the binary.';

let storage: MemoryStorageAdapter;
let embedder: ReturnType<typeof fakeEmbedder>;
let memory: MemoryFn;
beforeEach(() => {
  storage = new MemoryStorageAdapter();
  embedder = fakeEmbedder();
  memory = new MemoryFn({ storage: { kind: 'memory' } }, storage, embedder);
});

const searchAll = async (q = 'install') =>
  (await memory.search({ q, tenantId: scope.tenantId, containerTags: scope.containerTags, limit: 100 })).results;

describe('upsertDocument', () => {
  it('stores one embedded document chunk per section, keyed by the source and the SHA-256 of the content', async () => {
    const result = await memory.upsertDocument({ ...scope, content: docV1, metadata: { url: 'https://example.test/guide' } });
    expect(result).toMatchObject({ sourceKey: 'guide.md', unchanged: false, chunks: 3, contentHash: await sha256Hex(docV1) });
    expect(result.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.memories.map(chunk => chunk.content)).toEqual(['# Install\n\nRun the installer.', '# Configure\n\nSet the region.', '# Use\n\nCall the API.']);
    expect(result.memories.map(chunk => chunk.chunkIndex)).toEqual([0, 1, 2]);
    for (const chunk of result.memories) {
      expect(chunk).toMatchObject({ sourceKey: 'guide.md', contentHash: result.contentHash, type: 'document', isLatest: true, metadata: { url: 'https://example.test/guide' } });
      expect(chunk.embedding).toHaveLength(26);
    }
    expect(embedder.embedBatch).toHaveBeenCalledTimes(1);
    expect(await searchAll()).toHaveLength(3);
  });

  it('is a no-op for unchanged content: no embed call and no write', async () => {
    await memory.upsertDocument({ ...scope, content: docV1 });
    const before = await searchAll();
    embedder.embedBatch.mockClear();
    const replaceSource = vi.spyOn(storage, 'replaceSource');
    const again = await memory.upsertDocument({ ...scope, content: docV1 });
    expect(again).toEqual({ sourceKey: 'guide.md', contentHash: await sha256Hex(docV1), unchanged: true, chunks: 3, memories: [] });
    expect(embedder.embedBatch).not.toHaveBeenCalled();
    expect(replaceSource).not.toHaveBeenCalled();
    expect((await searchAll()).map(chunk => chunk.id).sort()).toEqual(before.map(chunk => chunk.id).sort());
  });

  it('compares a caller-supplied contentHash instead of hashing the content', async () => {
    await memory.upsertDocument({ ...scope, content: docV1, contentHash: 'etag-1' });
    embedder.embedBatch.mockClear();
    expect(await memory.upsertDocument({ ...scope, content: docV2, contentHash: 'etag-1' })).toMatchObject({ unchanged: true, contentHash: 'etag-1' });
    expect(embedder.embedBatch).not.toHaveBeenCalled();
    expect(await memory.upsertDocument({ ...scope, content: docV1, contentHash: 'etag-2' })).toMatchObject({ unchanged: false, contentHash: 'etag-2' });
  });

  it('replaces every previous chunk when the content changes, so search no longer returns old chunks', async () => {
    const first = await memory.upsertDocument({ ...scope, content: docV1 });
    const second = await memory.upsertDocument({ ...scope, content: docV2 });
    expect(second).toMatchObject({ unchanged: false, chunks: 2 });
    const results = await searchAll();
    expect(results.map(chunk => chunk.content).sort()).toEqual(['# Install\n\nDownload the zip archive.', '# Upgrade\n\nReplace the binary.']);
    const oldIds = new Set(first.memories.map(chunk => chunk.id));
    expect(results.some(chunk => oldIds.has(chunk.id))).toBe(false);
    for (const old of first.memories) expect(await storage.getMemory({ ...scope, id: old.id })).toBeNull();
    expect(await storage.getSourceState(scope)).toEqual({ contentHash: second.contentHash, chunkCount: 2 });
  });

  it('keeps sources with another key or another tag set apart, and leaves add() memories alone', async () => {
    const plain = await memory.add({ tenantId: scope.tenantId, containerTags: scope.containerTags, content: 'install notes' });
    await memory.upsertDocument({ ...scope, content: docV1 });
    await memory.upsertDocument({ ...scope, sourceKey: 'other.md', content: docV1 });
    await memory.upsertDocument({ ...scope, containerTags: ['docs'], content: docV1 });
    await memory.upsertDocument({ ...scope, content: docV2 });
    const results = await memory.search({ q: 'install', tenantId: scope.tenantId, containerTags: ['docs'], limit: 100 });
    expect(results.results.filter(chunk => chunk.sourceKey === 'other.md')).toHaveLength(3);
    expect(results.results.filter(chunk => chunk.sourceKey === 'guide.md' && chunk.containerTags.length === 1)).toHaveLength(3);
    expect(results.results.filter(chunk => chunk.sourceKey === 'guide.md' && chunk.containerTags.length === 2)).toHaveLength(2);
    expect(results.results.some(chunk => chunk.id === plain.memories[0].id)).toBe(true);
  });

  it('applies caller chunking options and a caller type', async () => {
    const content = Array.from({ length: 40 }, (_, index) => `sentence ${index} about installing.`).join(' ');
    const result = await memory.upsertDocument({ ...scope, content, type: 'procedural', chunking: { targetChars: 200, overlapChars: 0 } });
    expect(result.chunks).toBeGreaterThan(3);
    expect(result.memories.every(chunk => chunk.content.length <= 200 && chunk.type === 'procedural')).toBe(true);
    expect(result.memories.map(chunk => chunk.content).join('')).toBe(content);
  });

  it('requires an embedder, like search, before reading or writing storage', async () => {
    const noEmbedder = new MemoryFn({ storage: { kind: 'memory' } }, storage);
    const getSourceState = vi.spyOn(storage, 'getSourceState');
    await expect(noEmbedder.upsertDocument({ ...scope, content: docV1 })).rejects.toThrow('MEMORY_EMBEDDER_REQUIRED');
    expect(getSourceState).not.toHaveBeenCalled();
  });

  it('rejects invalid input before any storage call', async () => {
    const getSourceState = vi.spyOn(storage, 'getSourceState');
    await expect(memory.upsertDocument({ ...scope, content: '  \n' })).rejects.toThrow('MEMORY_CONTENT_REQUIRED');
    await expect(memory.upsertDocument({ ...scope, sourceKey: ' ', content: docV1 })).rejects.toThrow('MEMORY_SOURCE_KEY_REQUIRED');
    await expect(memory.upsertDocument({ ...scope, tenantId: '', content: docV1 })).rejects.toThrow('MEMORY_SCOPE_REQUIRED');
    await expect(memory.upsertDocument({ ...scope, content: docV1, contentHash: '' })).rejects.toThrow('MEMORY_SOURCE_HASH_REQUIRED');
    await expect(memory.upsertDocument({ ...scope, content: docV1, chunking: { targetChars: 10 } })).rejects.toThrow('MEMORY_CHUNKING_INVALID');
    await expect(memory.upsertDocument({ ...scope, content: docV1, extract: true })).rejects.toThrow('MEMORY_LLM_REQUIRED');
    expect(getSourceState).not.toHaveBeenCalled();
  });

  it('validates contentHash and type like storage, before any storage or provider call', async () => {
    const getSourceState = vi.spyOn(storage, 'getSourceState');
    const failing = { embed: vi.fn(), embedBatch: vi.fn(async () => { throw new Error('provider down'); }) };
    memory = new MemoryFn({ storage: { kind: 'memory' } }, storage, failing);
    await expect(memory.upsertDocument({ ...scope, content: docV1, contentHash: 'h'.repeat(1_025) })).rejects.toMatchObject({ code: 'MEMORY_SOURCE_LIMIT_EXCEEDED' });
    await expect(memory.upsertDocument({ ...scope, content: docV1, contentHash: `etag${String.fromCharCode(0)}1` })).rejects.toThrow('MEMORY_SOURCE_HASH_REQUIRED');
    await expect(memory.upsertDocument({ ...scope, content: docV1, contentHash: 'etag\uD800' })).rejects.toThrow('MEMORY_SOURCE_HASH_REQUIRED');
    await expect(memory.upsertDocument({ ...scope, content: docV1, type: '' as never })).rejects.toThrow('MEMORY_TYPE_INVALID');
    await expect(memory.upsertDocument({ ...scope, content: docV1, type: 7 as never })).rejects.toThrow('MEMORY_TYPE_INVALID');
    expect(getSourceState).not.toHaveBeenCalled();
    expect(failing.embedBatch).not.toHaveBeenCalled();
    // A 1 KiB hash is accepted.
    await expect(memory.upsertDocument({ ...scope, content: docV1, contentHash: 'h'.repeat(1_024) })).rejects.toThrow('provider down');
  });

  it('rejects a source over the chunk limit with the typed error, without splitting the rest or embedding', async () => {
    const before = await memory.upsertDocument({ ...scope, content: docV1 });
    embedder.embedBatch.mockClear();
    // The old chunker overflowed the call stack (a RangeError) on this input.
    const huge = memory.upsertDocument({ ...scope, content: 'x '.repeat(2_100_000), chunking: { targetChars: 64, overlapChars: 32 } });
    await expect(huge).rejects.toMatchObject({ name: 'MemorySourceLimitError', code: 'MEMORY_SOURCE_LIMIT_EXCEEDED' });
    expect(embedder.embedBatch).not.toHaveBeenCalled();
    expect(await storage.getSourceState(scope)).toEqual({ contentHash: before.contentHash, chunkCount: 3 });
  });

  it('rejects metadata that would exceed the replacement byte budget across all chunks before copying it or embedding', async () => {
    const before = await memory.upsertDocument({ ...scope, content: docV1 });
    embedder.embedBatch.mockClear();
    const content = Array.from({ length: 14_000 }, (_, index) => `# H${index}`).join('\n');
    // 14,000 chunks x 20 KB of metadata is over the 256 MiB budget, though each piece is small.
    const result = memory.upsertDocument({ ...scope, content, metadata: { blob: 'm'.repeat(20_000) } });
    await expect(result).rejects.toMatchObject({ code: 'MEMORY_SOURCE_LIMIT_EXCEEDED' });
    expect(embedder.embedBatch).not.toHaveBeenCalled();
    expect(await storage.getSourceState(scope)).toEqual({ contentHash: before.contentHash, chunkCount: 3 });
  });

  it('rejects content over the source chunk limit before embedding it', async () => {
    const content = Array.from({ length: 16_385 }, (_, index) => `# H${index}`).join('\n');
    await expect(memory.upsertDocument({ ...scope, content })).rejects.toMatchObject({ code: 'MEMORY_SOURCE_LIMIT_EXCEEDED' });
    expect(embedder.embedBatch).not.toHaveBeenCalled();
  });

  it('leaves the previous chunks live when embedding fails', async () => {
    const first = await memory.upsertDocument({ ...scope, content: docV1 });
    embedder.embedBatch.mockRejectedValueOnce(new Error('provider down'));
    await expect(memory.upsertDocument({ ...scope, content: docV2 })).rejects.toThrow('provider down');
    embedder.embedBatch.mockResolvedValueOnce([[1]]);
    await expect(memory.upsertDocument({ ...scope, content: docV2 })).rejects.toThrow('MEMORY_EMBEDDING_COUNT_MISMATCH');
    expect((await searchAll()).map(chunk => chunk.id).sort()).toEqual(first.memories.map(chunk => chunk.id).sort());
  });
});

describe('upsertDocument with extract: true', () => {
  it('stores the facts of each chunk under the source, and forgetBySource removes them', async () => {
    const llm = fakeLLM();
    memory = new MemoryFn({ storage: { kind: 'memory' } }, storage, embedder, llm);
    const plain = await memory.add({ tenantId: scope.tenantId, containerTags: scope.containerTags, content: 'kept memory' });
    const result = await memory.upsertDocument({ ...scope, content: docV1, extract: true, metadata: { url: 'u' } });
    expect(llm.generateJSON).toHaveBeenCalledTimes(1 + 3);
    expect(result).toMatchObject({ unchanged: false, chunks: 3 });
    expect(result.memories.map(fact => fact.content)).toEqual(['Fact: # Install', 'Fact: # Configure', 'Fact: # Use']);
    for (const [index, fact] of result.memories.entries()) {
      expect(fact).toMatchObject({ sourceKey: 'guide.md', type: 'derived', chunkIndex: index,
        metadata: { url: 'u', extractedTags: ['doc'], confidence: 0.9, sourceChunk: index } });
    }
    expect(await memory.forgetBySource(scope)).toEqual({ sourceKey: 'guide.md', deleted: 3 });
    const remaining = await searchAll('fact');
    expect(remaining.map(entry => entry.id)).toEqual([plain.memories[0].id]);
  });


  it('stops extracting once the facts exceed the chunk limit, before embedding', async () => {
    const fact = { content: 'A fact.', type: 'derived', confidence: 1, tags: [] };
    const llm: LLMProvider = { generate: vi.fn(), generateJSON: vi.fn(async () => ({ facts: Array.from({ length: 9_000 }, () => fact) })) as LLMProvider['generateJSON'] };
    memory = new MemoryFn({ storage: { kind: 'memory' } }, storage, embedder, llm);
    await expect(memory.upsertDocument({ ...scope, content: docV1, extract: true })).rejects.toMatchObject({ code: 'MEMORY_SOURCE_LIMIT_EXCEEDED' });
    // The second chunk's facts pass the 16,384 limit, so the third chunk is never extracted.
    expect(llm.generateJSON).toHaveBeenCalledTimes(2);
    expect(embedder.embedBatch).not.toHaveBeenCalled();
    expect(await storage.getSourceState(scope)).toBeNull();
  });
});

describe('add() next to sources', () => {
  const memoryScope = { tenantId: scope.tenantId, containerTags: scope.containerTags };

  it('does not deduplicate into a source chunk, so forgetBySource leaves the added memory', async () => {
    await memory.upsertDocument({ ...scope, content: docV1 });
    const added = await memory.add({ ...memoryScope, content: '# Install\n\nRun the installer.' });
    // The old pipeline reported deduplicated: 1 and stored nothing.
    expect(added.summary).toEqual({ created: 1, updated: 0, deduplicated: 0 });
    await memory.forgetBySource(scope);
    expect((await searchAll()).map(entry => entry.id)).toEqual([added.memories[0].id]);
    // Ordinary memories still deduplicate against each other.
    expect((await memory.add({ ...memoryScope, content: '# Install\n\nRun the installer.' })).summary.deduplicated).toBe(1);
  });

  it('never supersedes or links a source chunk, so a re-upsert of the same content stays searchable', async () => {
    const llm: LLMProvider = {
      generate: vi.fn(),
      generateJSON: vi.fn(async (prompt: string) => (prompt.includes('"facts"')
        ? { facts: [{ content: 'Run the installer now.', type: 'derived', confidence: 1, tags: [] }] }
        : { type: 'updates', reasoning: 'newer' })) as LLMProvider['generateJSON'],
    };
    const doc = await new MemoryFn({ storage: { kind: 'memory' } }, storage, embedder).upsertDocument({ ...scope, content: '# Install\n\nRun the installer.' });
    memory = new MemoryFn({ storage: { kind: 'memory' } }, storage, embedder, llm);
    const added = await memory.add({ ...memoryScope, content: 'note' });
    expect(added.summary).toEqual({ created: 1, updated: 0, deduplicated: 0 });
    expect(added.relationships).toEqual([]);
    expect(await memory.upsertDocument({ ...scope, content: '# Install\n\nRun the installer.' })).toMatchObject({ unchanged: true, chunks: 1 });
    expect((await searchAll()).map(entry => entry.id)).toContain(doc.memories[0].id);
  });
});

describe('forgetBySource', () => {
  it('soft-deletes every chunk of the source and nothing else; a second call deletes none', async () => {
    const doc = await memory.upsertDocument({ ...scope, content: docV1 });
    const other = await memory.upsertDocument({ ...scope, sourceKey: 'other.md', content: docV1 });
    expect(await memory.forgetBySource(scope)).toEqual({ sourceKey: 'guide.md', deleted: 3 });
    const results = await searchAll();
    expect(results.map(chunk => chunk.id).sort()).toEqual(other.memories.map(chunk => chunk.id).sort());
    expect(await storage.getSourceState(scope)).toBeNull();
    const raw = (storage as unknown as { memories: Map<string, { deletedAt: number | null }> }).memories.get(doc.memories[0].id);
    expect(raw?.deletedAt).toEqual(expect.any(Number));
    expect(await memory.forgetBySource(scope)).toEqual({ sourceKey: 'guide.md', deleted: 0 });
    // A forgotten source is written again by the next upsert of the same content.
    expect(await memory.upsertDocument({ ...scope, content: docV1 })).toMatchObject({ unchanged: false, chunks: 3 });
  });

  it('needs no embedder and validates the source scope', async () => {
    const noEmbedder = new MemoryFn({ storage: { kind: 'memory' } }, storage);
    expect(await noEmbedder.forgetBySource(scope)).toEqual({ sourceKey: 'guide.md', deleted: 0 });
    await expect(noEmbedder.forgetBySource({ ...scope, sourceKey: '' })).rejects.toThrow('MEMORY_SOURCE_KEY_REQUIRED');
    await expect(noEmbedder.forgetBySource({ ...scope, containerTags: [''] })).rejects.toThrow('MEMORY_SCOPE_REQUIRED');
  });
});

describe('upsertDocument per-record budget', () => {
  it('stores a repeated tag once per record, so repeats cost nothing per chunk', async () => {
    const containerTags = Array.from({ length: 100_000 }, () => 't');
    const content = Array.from({ length: 2_000 }, (_, index) => `# H${index}`).join('\n');
    const result = await memory.upsertDocument({ tenantId: scope.tenantId, containerTags, sourceKey: 'tags.md', content });
    expect(result.chunks).toBe(2_000);
    expect(result.memories.every(chunk => chunk.containerTags.length === 1)).toBe(true);
    expect(await storage.getSourceState({ tenantId: scope.tenantId, containerTags: ['t'], sourceKey: 'tags.md' })).toMatchObject({ chunkCount: 2_000 });
  });

  it('counts each record\'s copy of the distinct tags in the byte budget, before embedding', async () => {
    // About 64 KB of distinct tags, under the 64 KiB tag limit, is about 76 KB of JSON per record: 3,600 records exceed 256 MiB.
    const containerTags = Array.from({ length: 4_000 }, (_, index) => `${index}`.padEnd(16, 't'));
    const source = { tenantId: scope.tenantId, containerTags, sourceKey: 'wide.md' };
    const before = await memory.upsertDocument({ ...source, content: docV1 });
    embedder.embedBatch.mockClear();
    const content = Array.from({ length: 3_600 }, (_, index) => `# H${index}`).join('\n');
    await expect(memory.upsertDocument({ ...source, content })).rejects.toMatchObject({ code: 'MEMORY_SOURCE_LIMIT_EXCEEDED' });
    expect(embedder.embedBatch).not.toHaveBeenCalled();
    expect(await storage.getSourceState(source)).toEqual({ contentHash: before.contentHash, chunkCount: 3 });
  });

  it('rejects an extraction response over the remaining record budget before reading any fact', async () => {
    let reads = 0;
    const fact = { get content() { reads++; return 'A fact.'; }, type: 'derived', confidence: 1, tags: [] };
    const llm: LLMProvider = { generate: vi.fn(), generateJSON: vi.fn(async () => ({ facts: Array.from({ length: 16_385 }, () => fact) })) as LLMProvider['generateJSON'] };
    memory = new MemoryFn({ storage: { kind: 'memory' } }, storage, embedder, llm);
    await expect(memory.upsertDocument({ ...scope, content: '# One', extract: true })).rejects.toMatchObject({ code: 'MEMORY_SOURCE_LIMIT_EXCEEDED' });
    expect(reads).toBe(0);
    expect(embedder.embedBatch).not.toHaveBeenCalled();
  });

  it('stops reading an extraction response at the fact that exceeds the byte budget', async () => {
    let reads = 0;
    const big = 'f'.repeat(1024 * 1024);
    const fact = { get content() { reads++; return big; }, type: 'derived', confidence: 1, tags: [] };
    const llm: LLMProvider = { generate: vi.fn(), generateJSON: vi.fn(async () => ({ facts: Array.from({ length: 400 }, () => fact) })) as LLMProvider['generateJSON'] };
    memory = new MemoryFn({ storage: { kind: 'memory' } }, storage, embedder, llm);
    await expect(memory.upsertDocument({ ...scope, content: '# One', extract: true })).rejects.toMatchObject({ code: 'MEMORY_SOURCE_LIMIT_EXCEEDED' });
    // Facts of just over 1 MiB pass 256 MiB at the 256th; validating a fact reads its content once.
    expect(reads).toBe(256);
    expect(embedder.embedBatch).not.toHaveBeenCalled();
    expect(await storage.getSourceState(scope)).toBeNull();
  });
});

describe('upsertDocument and concurrent identical calls', () => {
  it('commits one batch; the other call reports unchanged and the returned chunks stay live', async () => {
    const release: Array<() => void> = [];
    embedder.embedBatch.mockImplementation(async (texts: string[]) => {
      await new Promise<void>(resolve => release.push(resolve));
      return texts.map(text => [text.length, 1]);
    });
    const calls = [memory.upsertDocument({ ...scope, content: docV1 }), memory.upsertDocument({ ...scope, content: docV1 })];
    await vi.waitFor(() => expect(release).toHaveLength(2));
    release.forEach(resolve => resolve());
    const results = await Promise.all(calls);
    expect(results.map(result => result.unchanged).sort()).toEqual([false, true]);
    const [written, skipped] = results[0].unchanged ? [results[1], results[0]] : [results[0], results[1]];
    expect(skipped).toEqual({ sourceKey: 'guide.md', contentHash: written.contentHash, unchanged: true, chunks: 3, memories: [] });
    const live = await Promise.all(written.memories.map(chunk => storage.getMemory({ ...scope, id: chunk.id })));
    expect(live.every(chunk => chunk !== null)).toBe(true);
    expect(await storage.getSourceState(scope)).toEqual({ contentHash: written.contentHash, chunkCount: 3 });
  });
});

describe('upsertDocument embedding validation', () => {
  // docV2 has two chunks, so each batch holds two entries.
  const sparse = [[1, 2, 3]];
  sparse.length = 2;
  const holed = [1, 2];
  holed.length = 3;
  it.each([
    ['an empty vector', [[1, 2], []]],
    ['NaN', [[1, 2], [1, Number.NaN]]],
    ['Infinity', [[Number.POSITIVE_INFINITY, 2], [1, 2]]],
    ['mixed dimensions', [[1, 2], [1, 2, 3]]],
    ['a null vector', [null, [1, 2]]],
    ['a sparse batch', sparse],
    ['a hole in a vector', [[1, 2, 3], holed]],
    ['a non-number', [[1, 2], [1, '2']]],
    ['a zero vector', [[1, 2], [0, 0]]],
    ['a 1e308 component', [[1, 2], [1e308, 1]]],
    ['1e200 components', [[1e200, 1e200], [1, 2]]],
    ['a sum of squares over float32\'s largest value', [[1, 2], [1.4e19, 1.4e19]]],
    ['components below float32\'s smallest normal value', [[1, 2], [1e-30, 1e-30]]],
    ['a sum of squares that float32 rounding and accumulation would overflow', [new Array(1_536).fill(1), new Array(1_536).fill(470678219267465300)]],
    ['a billion-element vector with holes', [new Array(1_000_000_000), [1, 2]]],
    // First, so no earlier vector fixes the dimension on this dimensionless adapter.
    ['a fractional length', [new Proxy([1, 2], { get: (target, key, receiver) => (key === 'length' ? 1.5 : Reflect.get(target, key, receiver)) }), [1, 2]]],
    ['a length getter that throws', [[1, 2], new Proxy([1, 2], { get: (target, key, receiver) => { if (key === 'length') throw new Error('provider bug'); return Reflect.get(target, key, receiver); } })]],
    ['a component getter that throws', [[1, 2], new Proxy([1, 2], { get: (target, key, receiver) => { if (key === '1') throw new Error('provider bug'); return Reflect.get(target, key, receiver); } })]],
  ])('rejects %s and keeps the previous chunks searchable', async (_name, batch) => {
    const first = await memory.upsertDocument({ ...scope, content: docV1 });
    embedder.embedBatch.mockResolvedValueOnce(batch as number[][]);
    const replace = vi.spyOn(storage, 'replaceSourceIfChanged');
    await expect(memory.upsertDocument({ ...scope, content: docV2 })).rejects.toThrow('MEMORY_EMBEDDING_INVALID');
    expect(replace).not.toHaveBeenCalled();
    expect((await searchAll()).map(chunk => chunk.id).sort()).toEqual(first.memories.map(chunk => chunk.id).sort());
    // The new hash was not stored, so a retry embeds again.
    expect(await memory.upsertDocument({ ...scope, content: docV2 })).toMatchObject({ unchanged: false, chunks: 2 });
  });

  it('stores a plain copy of each vector, so it scores exactly as an add() memory does', async () => {
    const vector = [1, 4, 19];
    const raw = { embed: vi.fn(async () => vector), embedBatch: vi.fn(async (texts: string[]) => texts.map(() => vector)) };
    memory = new MemoryFn({ storage: { kind: 'memory' } }, storage, raw);
    const result = await memory.upsertDocument({ ...scope, content: '# One' });
    vector[0] = 99;
    expect((await storage.getMemory({ ...scope, id: result.memories[0].id }))!.embedding).toEqual([1, 4, 19]);
    vector[0] = 1;
    const found = await memory.search({ q: 'any', tenantId: scope.tenantId, containerTags: scope.containerTags, threshold: 1 });
    expect(found.results.map(chunk => chunk.id)).toEqual([result.memories[0].id]);
  });

  it('charges each number as it is copied, so an endless vector stops at the byte budget', async () => {
    let reads = 0;
    const endless = new Proxy([0], { get: (target, key) => (key === 'length' ? 2 ** 31 : typeof key === 'string' && /^\d+$/.test(key) ? (reads++, 0.12345678901234568) : Reflect.get(target, key)) });
    embedder.embedBatch.mockResolvedValueOnce([endless]);
    await expect(memory.upsertDocument({ ...scope, content: '# One' })).rejects.toMatchObject({ code: 'MEMORY_SOURCE_LIMIT_EXCEEDED' });
    // Each number is 20 bytes of JSON with its comma, so the copy stops near 256 MiB / 20.
    expect(reads).toBeLessThan(14_000_000);
  });

  it.each([
    ['1e200 components', [1e200, 0]],
    ['a toJSON method', Object.assign([1e15, 2e-15, 3], { toJSON: () => [0, 0, 0] })],
  ])('passes a query vector with %s to storage as the embedder returned it, in one call', async (_name, query) => {
    const search = vi.spyOn(storage, 'searchVectors');
    embedder.embed.mockResolvedValueOnce(query);
    await memory.search({ q: 'any', tenantId: scope.tenantId, containerTags: scope.containerTags });
    expect(search).toHaveBeenCalledTimes(1);
    expect(search.mock.calls[0][0].embedding).toBe(query);
  });

  it('reads each vector length once, so the dimension checked is the dimension stored', async () => {
    let lengthReads = 0;
    const shifting = new Proxy([1, 2, 3], { get: (target, key, receiver) => (key === 'length' ? (++lengthReads === 1 ? 2 : 3) : Reflect.get(target, key, receiver)) });
    const fixed = Object.assign(new MemoryStorageAdapter(), { embeddingDimensions: 2 });
    memory = new MemoryFn({ storage: { kind: 'memory' } }, fixed, embedder);
    embedder.embedBatch.mockResolvedValueOnce([shifting]);
    const result = await memory.upsertDocument({ ...scope, content: '# One' });
    expect(lengthReads).toBe(1);
    expect((await fixed.getMemory({ ...scope, id: result.memories[0].id }))!.embedding).toEqual([1, 2]);
  });

  it('scores a [1, 1] document chunk exactly as an add() memory with the same vector', async () => {
    const same = { embed: vi.fn(async () => [1, 1]), embedBatch: vi.fn(async (texts: string[]) => texts.map(() => [1, 1])) };
    memory = new MemoryFn({ storage: { kind: 'memory' } }, storage, same);
    const added = await memory.add({ tenantId: scope.tenantId, containerTags: scope.containerTags, content: 'memory' });
    const chunk = await memory.upsertDocument({ ...scope, content: '# One' });
    const at = async (threshold: number) =>
      (await memory.search({ q: 'any', tenantId: scope.tenantId, containerTags: scope.containerTags, threshold })).results.map(entry => entry.id).sort();
    // The memory adapter's float64 cosine of [1, 1] with itself is 0.9999999999999998 for both, as on the PR base for add().
    expect(await at(1)).toEqual([]);
    expect(await at(0.9999)).toEqual([added.memories[0].id, chunk.memories[0].id].sort());
  });

  it.each([['a zero vector', 0], ['components whose squares vanish in float64', 1e-200]])('passes a query vector with %s to storage, which scores it 0', async (_name, component) => {
    const query = Array.from({ length: 26 }, () => component);
    const first = await memory.upsertDocument({ ...scope, content: docV1 });
    embedder.embed.mockResolvedValueOnce(query);
    const found = await memory.search({ q: 'any', tenantId: scope.tenantId, containerTags: scope.containerTags, threshold: 0 });
    expect(found.results.map(entry => entry.id).sort()).toEqual(first.memories.map(entry => entry.id).sort());
  });

  it('still finds an add() memory whose vector the memory adapter can score, even outside float32 range', async () => {
    const wide = { embed: vi.fn(async () => [1e20]), embedBatch: vi.fn(async (texts: string[]) => texts.map(() => [1e20])) };
    memory = new MemoryFn({ storage: { kind: 'memory' } }, storage, wide);
    const added = await memory.add({ tenantId: scope.tenantId, containerTags: scope.containerTags, content: 'large' });
    const found = await memory.search({ q: 'large', tenantId: scope.tenantId, containerTags: scope.containerTags, threshold: 1 });
    expect(found.results.map(entry => entry.id)).toEqual([added.memories[0].id]);
  });

  it('rejects vectors of another dimension than the storage keeps', async () => {
    const fixed = Object.assign(new MemoryStorageAdapter(), { embeddingDimensions: 3 });
    memory = new MemoryFn({ storage: { kind: 'memory' } }, fixed, embedder);
    embedder.embedBatch.mockResolvedValueOnce([[1, 2], [1, 2], [1, 2]]);
    await expect(memory.upsertDocument({ ...scope, content: docV1 })).rejects.toThrow('MEMORY_EMBEDDING_INVALID');
    expect(await fixed.getSourceState(scope)).toBeNull();
    embedder.embedBatch.mockResolvedValueOnce([[1, 2, 3], [1, 2, 3], [1, 2, 3]]);
    expect(await memory.upsertDocument({ ...scope, content: docV1 })).toMatchObject({ unchanged: false, chunks: 3 });
  });
});

/** An adapter written against the PR base's StorageAdapter: no replaceSourceIfChanged. */
function baseContractAdapter(inner: MemoryStorageAdapter): StorageAdapter {
  return {
    transaction: operation => inner.transaction(operation),
    insertMemories: memories => inner.insertMemories(memories),
    insertRelationships: relationships => inner.insertRelationships(relationships),
    searchVectors: params => inner.searchVectors(params),
    getMemory: input => inner.getMemory(input),
    updateMemory: input => inner.updateMemory(input),
    deleteMemory: input => inner.deleteMemory(input),
    getSourceState: input => inner.getSourceState(input),
    replaceSource: input => inner.replaceSource(input),
    deleteSource: input => inner.deleteSource(input),
  };
}

describe('upsertDocument on storage without replaceSourceIfChanged', () => {
  it('still serves add, search and forgetBySource, and rejects upserts before any provider call', async () => {
    const llm = fakeLLM();
    memory = new MemoryFn({ storage: { kind: 'memory' } }, baseContractAdapter(storage), embedder);
    const added = await memory.add({ tenantId: scope.tenantId, containerTags: scope.containerTags, content: 'Install notes.' });
    expect(added.summary.created).toBe(1);
    expect((await searchAll()).map(entry => entry.id)).toEqual([added.memories[0].id]);
    embedder.embedBatch.mockClear();
    await expect(memory.upsertDocument({ ...scope, content: docV1 })).rejects.toThrow('MEMORY_DOCUMENTS_UNSUPPORTED');
    memory = new MemoryFn({ storage: { kind: 'memory' } }, baseContractAdapter(storage), embedder, llm);
    await expect(memory.upsertDocument({ ...scope, content: docV1, extract: true })).rejects.toThrow('MEMORY_DOCUMENTS_UNSUPPORTED');
    expect(embedder.embedBatch).not.toHaveBeenCalled();
    expect(llm.generateJSON).not.toHaveBeenCalled();
    expect(await storage.getSourceState(scope)).toBeNull();
    expect(await memory.forgetBySource(scope)).toEqual({ sourceKey: 'guide.md', deleted: 0 });
  });
});

describe('upsertDocument document text', () => {
  it.each([
    ['a lone high surrogate', 'Install \uD800 now'],
    ['a lone low surrogate', 'Install \uDC00 now'],
    ['NUL', `Install ${String.fromCharCode(0)} now`],
  ])('rejects %s before hashing or any provider call, keeping the source', async (_name, text) => {
    const first = await memory.upsertDocument({ ...scope, content: docV1 });
    embedder.embedBatch.mockClear();
    await expect(memory.upsertDocument({ ...scope, content: `# Install\n\n${text}` })).rejects.toThrow('MEMORY_CONTENT_INVALID');
    await expect(memory.upsertDocument({ ...scope, content: text, contentHash: 'etag-1' })).rejects.toThrow('MEMORY_CONTENT_INVALID');
    expect(embedder.embedBatch).not.toHaveBeenCalled();
    expect(await storage.getSourceState(scope)).toEqual({ contentHash: first.contentHash, chunkCount: 3 });
  });

  it.each([
    ['NUL in a value', { note: `a${String.fromCharCode(0)}b` }],
    ['a lone surrogate in a key', { ['k\uD800']: 1 }],
    ['a lone surrogate in a nested value', { nested: [{ note: 'x\uDC00' }] }],
    ['a value structuredClone cannot copy', { run: () => 1 }],
    ['a cycle', (() => { const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic; return cyclic; })()],
    ['a BigInt', { count: BigInt(1) }],
    ['a BigInt inside a Map', { map: new Map([['count', BigInt(1)]]) }],
    ['a Map', { map: new Map([['name', 'retained']]) }],
    ['a Date', { at: new Date(0) }],
    ['shared memory', { view: new Int32Array(new SharedArrayBuffer(8)) }],
    ['NaN', { score: Number.NaN }],
    ['undefined in an array', { list: [1, undefined] }],
    ['a getter that throws', { get broken() { throw new TypeError('getter failed'); } }],
    ['a getter that throws a RangeError', { nested: { get broken() { throw new RangeError('getter failed'); } } }],
    ['a revoked root proxy', (() => { const { proxy, revoke } = Proxy.revocable({}, {}); revoke(); return proxy; })()],
    ['a revoked nested proxy', (() => { const { proxy, revoke } = Proxy.revocable({}, {}); revoke(); return { nested: proxy }; })()],
    ['a Date from another realm', runInNewContext('({ at: new Date(0) })') as Record<string, unknown>],
    ['a class instance', { item: new (class Item { name = 'x'; })() }],
    ['an object inheriting from a null-prototype object', { item: Object.create(Object.assign(Object.create(null), { inherited: 'lost' })) }],
    ['an instance of a class extending null', { item: Object.create((class Bare extends null {}).prototype) }],
    ['a record whose parent forges an Object constructor', (() => {
      const parent: Record<string, unknown> = Object.create(null);
      parent.constructor = Object.defineProperty(function Object() {}, 'prototype', { value: parent });
      parent.toJSON = () => ({ expected: true });
      return { nested: Object.create(parent) };
    })()],
  ])('rejects metadata with %s before any provider call, keeping the source', async (_name, metadata) => {
    const first = await memory.upsertDocument({ ...scope, content: docV1 });
    embedder.embedBatch.mockClear();
    await expect(memory.upsertDocument({ ...scope, content: docV2, metadata })).rejects.toThrow('MEMORY_METADATA_INVALID');
    expect(embedder.embedBatch).not.toHaveBeenCalled();
    expect(await storage.getSourceState(scope)).toEqual({ contentHash: first.contentHash, chunkCount: 3 });
  });

  it('writes the metadata as it was when called, even if the caller changes it while embedding', async () => {
    const metadata = { nested: { note: 'original' } };
    embedder.embedBatch.mockImplementationOnce(async (texts: string[]) => {
      metadata.nested.note = 'x'.repeat(10_000);
      return texts.map(() => [1, 2]);
    });
    const result = await memory.upsertDocument({ ...scope, content: docV1, metadata });
    expect(result.memories.map(chunk => chunk.metadata)).toEqual([0, 1, 2].map(() => ({ nested: { note: 'original' } })));
  });

  it('stores a plain copy of JSON metadata, reading each property once and leaving out undefined properties', async () => {
    let reads = 0;
    const metadata = { nested: { get note() { reads++; return reads === 1 ? 'first' : 'later'; }, skipped: undefined }, list: [1, 'two', null, true],
      parsed: JSON.parse('{"deep":{"__proto__":{"label":"keep"}}}') as Record<string, unknown> };
    const result = await memory.upsertDocument({ ...scope, content: docV1, metadata });
    expect(reads).toBe(1);
    const stored = await storage.getMemory({ ...scope, id: result.memories[0].id });
    expect(JSON.stringify(stored!.metadata)).toBe('{"nested":{"note":"first"},"list":[1,"two",null,true],"parsed":{"deep":{"__proto__":{"label":"keep"}}}}');
  });

  it.each([
    ['removed', () => { delete (Object.prototype as { constructor?: unknown }).constructor; }],
    ['replaced', () => { Object.defineProperty(Object.prototype, 'constructor', { value: function Object() {}, writable: true, configurable: true, enumerable: false }); }],
  ])('accepts and detaches plain metadata when the host has %s Object.prototype.constructor', async (_name, change) => {
    const metadata = { nested: { list: [1, { label: 'x' }] }, bare: Object.create(null) as object };
    const original = Object.getOwnPropertyDescriptor(Object.prototype, 'constructor')!;
    let result: Awaited<ReturnType<MemoryFn['upsertDocument']>> | undefined;
    let failure: unknown;
    change();
    try {
      result = await memory.upsertDocument({ ...scope, content: docV1, metadata });
    } catch (error) {
      failure = error;
    } finally {
      Object.defineProperty(Object.prototype, 'constructor', original);
    }
    expect(failure).toBeUndefined();
    const stored = (await storage.getMemory({ ...scope, id: result!.memories[0].id }))!.metadata as Record<string, any>;
    expect(stored).toEqual({ nested: { list: [1, { label: 'x' }] }, bare: {} });
    (metadata.nested.list[1] as { label: string }).label = 'changed';
    expect(stored.nested.list[1].label).toBe('x');
  });

  it('accepts and detaches plain records from another realm, nested ones included', async () => {
    const metadata = runInNewContext('({ nested: { list: [1, { label: "x" }] }, bare: Object.create(null) })') as Record<string, unknown>;
    expect(Object.getPrototypeOf(metadata)).not.toBe(Object.prototype);
    const result = await memory.upsertDocument({ ...scope, content: docV1, metadata });
    const stored = (await storage.getMemory({ ...scope, id: result.memories[0].id }))!.metadata as Record<string, any>;
    expect(JSON.stringify(stored)).toBe('{"nested":{"list":[1,{"label":"x"}]},"bare":{}}');
    expect(Object.getPrototypeOf(stored.nested)).toBe(Object.prototype);
    (metadata.nested as Record<string, any>).list[1].label = 'changed';
    expect(stored.nested.list[1].label).toBe('x');
  });

  const bigKey = 'k'.repeat(65_536);
  const quoteKey = '"'.repeat(60_000);
  const shared = { [bigKey]: 1 };
  it.each([
    // 5,000 x 64 KiB keys is over 312 MiB of JSON, though the values alone are a few KB.
    ['a large key repeated across entries', () => ({ list: Array.from({ length: 5_000 }, () => ({ [bigKey]: 1 })) })],
    ['one object referenced repeatedly', () => ({ list: Array.from({ length: 5_000 }, () => shared) })],
    // 60,000 quotes escape to 120,002 bytes each: about 300 MB of JSON from 150 M characters.
    ['keys that JSON escaping doubles', () => ({ list: Array.from({ length: 2_500 }, () => ({ [quoteKey]: true })) })],
  ])('rejects metadata whose JSON passes the budget through %s before serializing it or any provider call', async (_name, build) => {
    const first = await memory.upsertDocument({ ...scope, content: docV1 });
    embedder.embedBatch.mockClear();
    const stringify = vi.spyOn(JSON, 'stringify');
    try {
      await expect(memory.upsertDocument({ ...scope, content: docV2, metadata: build() })).rejects.toMatchObject({ code: 'MEMORY_SOURCE_LIMIT_EXCEEDED' });
      expect(stringify.mock.calls.some(([value]) => value !== null && typeof value === 'object' && 'list' in value)).toBe(false);
    } finally {
      stringify.mockRestore();
    }
    expect(embedder.embedBatch).not.toHaveBeenCalled();
    expect(await storage.getSourceState(scope)).toEqual({ contentHash: first.contentHash, chunkCount: 3 });
  });

  it('keeps oversized serializable metadata on the source-limit path, before any provider call', async () => {
    const first = await memory.upsertDocument({ ...scope, content: docV1 });
    embedder.embedBatch.mockClear();
    // About 100 KB of metadata per chunk: 3,000 chunks pass 256 MiB.
    const content = Array.from({ length: 3_000 }, (_, index) => `# H${index}`).join('\n');
    await expect(memory.upsertDocument({ ...scope, content, metadata: { note: 'm'.repeat(100_000) } }))
      .rejects.toMatchObject({ code: 'MEMORY_SOURCE_LIMIT_EXCEEDED' });
    expect(embedder.embedBatch).not.toHaveBeenCalled();
    expect(await storage.getSourceState(scope)).toEqual({ contentHash: first.contentHash, chunkCount: 3 });
  });

  it.each([['CRLF', '\r\n'], ['CR', '\r']])('rejects %s content over the chunk limit before any provider call', async (_name, ending) => {
    const first = await memory.upsertDocument({ ...scope, content: docV1 });
    embedder.embedBatch.mockClear();
    const content = Array.from({ length: 16_385 }, (_, index) => `# H${index}`).join(ending);
    await expect(memory.upsertDocument({ ...scope, content })).rejects.toMatchObject({ code: 'MEMORY_SOURCE_LIMIT_EXCEEDED' });
    expect(embedder.embedBatch).not.toHaveBeenCalled();
    expect(await storage.getSourceState(scope)).toEqual({ contentHash: first.contentHash, chunkCount: 3 });
  });

  it('stores valid supplementary characters unchanged and hashes their UTF-8 bytes', async () => {
    const content = '# Emoji \u{1F600}\n\nClef \u{1D11E} and \u{20BB7}.';
    const result = await memory.upsertDocument({ ...scope, content });
    expect(result).toMatchObject({ unchanged: false, chunks: 1, contentHash: await sha256Hex(content) });
    expect(result.memories[0].content).toBe(content);
    expect(await memory.upsertDocument({ ...scope, content })).toMatchObject({ unchanged: true, chunks: 1 });
  });
});

describe('upsertDocument extraction output', () => {
  const fact = { content: 'A fact.', type: 'derived', confidence: 1, tags: ['doc'] };
  const sparseFacts = [fact];
  sparseFacts.length = 2;
  const sparseTags = ['doc'];
  sparseTags.length = 2;
  it.each([
    ['a hole in the facts', { facts: sparseFacts }],
    ['a hole in the tags', { facts: [{ ...fact, tags: sparseTags }] }],
    ['NUL in a fact', { facts: [{ ...fact, content: `A ${String.fromCharCode(0)} fact.` }] }],
    ['a lone surrogate in a tag', { facts: [{ ...fact, tags: ['doc \uD800'] }] }],
  ])('rejects %s and keeps the previous source searchable', async (_name, response) => {
    const llm = fakeLLM();
    memory = new MemoryFn({ storage: { kind: 'memory' } }, storage, embedder, llm);
    const first = await memory.upsertDocument({ ...scope, content: docV1, extract: true });
    vi.mocked(llm.generateJSON).mockResolvedValueOnce(response);
    await expect(memory.upsertDocument({ ...scope, content: docV2, extract: true })).rejects.toThrow('MEMORY_EXTRACTION_INVALID');
    expect(await storage.getSourceState(scope)).toEqual({ contentHash: first.contentHash, chunkCount: 3 });
    expect((await searchAll('fact')).map(entry => entry.id).sort()).toEqual(first.memories.map(entry => entry.id).sort());
  });

  it.each([
    ['facts that stop being an array', (reads: number) => ({ facts: reads === 1 ? [fact] : { length: 0 } }), 'facts', 'stored'],
    ['facts that become an array', (reads: number) => ({ facts: reads === 1 ? { length: 0 } : [fact] }), 'facts', 'rejected'],
    ['tags that change', (reads: number) => ({ facts: [{ ...fact, tags: reads === 1 ? ['doc'] : [1] }] }), 'tags', 'stored'],
    ['content that changes', (reads: number) => ({ facts: [{ ...fact, content: reads === 1 ? 'A fact.' : '' }] }), 'content', 'stored'],
  ])('reads %s through an accessor once and uses the value it checked', async (_name, value, field, outcome) => {
    let reads = 0;
    /** The response with `field` behind a getter whose value depends on how often it was read. */
    const response = () => {
      const plain = value(1) as { facts: unknown };
      if (field === 'facts') return { get facts() { reads++; return value(reads).facts; } };
      const first = (plain.facts as Array<Record<string, unknown>>)[0];
      return { facts: [Object.defineProperty({ ...first }, field, { enumerable: true, get() { reads++; return ((value(reads).facts as Array<Record<string, unknown>>)[0])[field]; } })] };
    };
    const llm: LLMProvider = { generate: vi.fn(), generateJSON: vi.fn(async () => { reads = 0; return response(); }) as LLMProvider['generateJSON'] };
    memory = new MemoryFn({ storage: { kind: 'memory' } }, storage, embedder, llm);
    const first = memory.upsertDocument({ ...scope, content: '# One', extract: true });
    if (outcome === 'rejected') {
      // The first read was not a fact list, so nothing was embedded or written.
      await expect(first).rejects.toThrow('MEMORY_EXTRACTION_INVALID');
      expect(embedder.embedBatch).not.toHaveBeenCalled();
      expect(await storage.getSourceState(scope)).toBeNull();
    } else {
      const stored = await first;
      expect(stored).toMatchObject({ unchanged: false, chunks: 1 });
      expect(stored.memories[0]).toMatchObject({ content: 'A fact.', metadata: { extractedTags: ['doc'] } });
    }
    expect(reads).toBe(1);
  });

  it.each([
    ['a field read that throws', () => ({ facts: [{ content: 'A fact.', get type(): string { throw new Error('provider getter failed'); }, confidence: 1, tags: [] }] })],
    ['a facts read that throws', () => ({ get facts(): unknown { throw new Error('provider getter failed'); } })],
    ['a revoked fact proxy', () => { const { proxy, revoke } = Proxy.revocable({}, {}); revoke(); return { facts: [proxy] }; }],
    ['a facts array reporting a negative length', () => ({ facts: new Proxy([], { get: (target, key, receiver) => (key === 'length' ? -1 : Reflect.get(target, key, receiver)) }) })],
    ['a tags array reporting a negative length', () => ({ facts: [{ content: 'A fact.', type: 'derived', confidence: 1,
      tags: new Proxy([], { get: (target, key, receiver) => (key === 'length' ? -1 : Reflect.get(target, key, receiver)) }) }] })],
  ])('maps %s to MEMORY_EXTRACTION_INVALID before embedding, keeping the source', async (_name, build) => {
    const llm = fakeLLM();
    memory = new MemoryFn({ storage: { kind: 'memory' } }, storage, embedder, llm);
    const first = await memory.upsertDocument({ ...scope, content: docV1, extract: true });
    embedder.embedBatch.mockClear();
    vi.mocked(llm.generateJSON).mockResolvedValueOnce(build());
    await expect(memory.upsertDocument({ ...scope, content: docV2, extract: true })).rejects.toThrow('MEMORY_EXTRACTION_INVALID');
    expect(embedder.embedBatch).not.toHaveBeenCalled();
    expect(await storage.getSourceState(scope)).toEqual({ contentHash: first.contentHash, chunkCount: 3 });
  });

  it('checks fields in order, so invalid content fails before a later field is read', async () => {
    let typeReads = 0;
    const llm: LLMProvider = { generate: vi.fn(), generateJSON: vi.fn(async () => ({
      facts: [{ content: '', get type() { typeReads++; throw new Error('provider getter failed'); }, confidence: 1, tags: [] }],
    })) as LLMProvider['generateJSON'] };
    memory = new MemoryFn({ storage: { kind: 'memory' } }, storage, embedder, llm);
    await expect(memory.upsertDocument({ ...scope, content: '# One', extract: true })).rejects.toThrow('MEMORY_EXTRACTION_INVALID');
    expect(typeReads).toBe(0);
    expect(embedder.embedBatch).not.toHaveBeenCalled();
  });

  it('accepts an empty facts array as a source without facts', async () => {
    const llm: LLMProvider = { generate: vi.fn(), generateJSON: vi.fn(async () => ({ facts: [] })) as LLMProvider['generateJSON'] };
    memory = new MemoryFn({ storage: { kind: 'memory' } }, storage, embedder, llm);
    expect(await memory.upsertDocument({ ...scope, content: docV1, extract: true }))
      .toMatchObject({ unchanged: false, chunks: 0, memories: [] });
  });
});

describe('upsertDocument combined byte budget', () => {
  it('charges the returned vectors with the tags and content, rejecting the write and keeping the source', async () => {
    // Per record: about 63 KB of tag JSON (pre-embedding total about 189 MB for 3,000 records) and about
    // 84 KB of vector JSON (storage total about 252 MB): each is under 256 MiB, together they are not.
    // The vector's toJSON would shrink it to 3 bytes; the copy that storage writes is what is charged.
    const containerTags = Array.from({ length: 1_000 }, (_, index) => `${index}`.padEnd(60, 't'));
    const wide = Object.assign(new Array<number>(4_000).fill(Math.sqrt(1 / 4_000)), { toJSON: () => [1] });
    const wideEmbedder = { embed: vi.fn(async () => wide), embedBatch: vi.fn(async (texts: string[]) => texts.map(() => wide)) };
    memory = new MemoryFn({ storage: { kind: 'memory' } }, storage, wideEmbedder);
    const source = { tenantId: scope.tenantId, containerTags, sourceKey: 'wide.md' };
    const first = await memory.upsertDocument({ ...source, content: docV1 });
    const content = Array.from({ length: 3_000 }, (_, index) => `# H${index}`).join('\n');
    await expect(memory.upsertDocument({ ...source, content })).rejects.toMatchObject({ code: 'MEMORY_SOURCE_LIMIT_EXCEEDED' });
    expect(wideEmbedder.embedBatch).toHaveBeenCalledTimes(2);
    expect(await storage.getSourceState(source)).toEqual({ contentHash: first.contentHash, chunkCount: 3 });
    const found = await memory.search({ q: 'install', tenantId: scope.tenantId, containerTags, limit: 10 });
    expect(found.results.map(entry => entry.id).sort()).toEqual(first.memories.map(entry => entry.id).sort());
  });
});

describe('upsertDocument extracted fact budget', () => {
  const unit = { embed: vi.fn(async () => [1]), embedBatch: vi.fn(async (texts: string[]) => texts.map(() => [1])) };
  const oneFact = (tags: unknown) => ({ generate: vi.fn(), generateJSON: vi.fn(async () => ({ facts: [{ content: 'A fact.', type: 'derived', confidence: 0.25, tags }] })) }) as unknown as LLMProvider;
  /** Every byte the pipeline charges for a stored record, from the helpers replaceSource counts with, plus its tag array copy. */
  const recordBytes = (row: Memory) => sourceChunkBytesBeforeEmbedding(row.type, row.content, sourceMetadataBytes(row.metadata))
    + sourceEmbeddingBytes(row.embedding!) + sourceTagsBytes(row.containerTags);

  it('stops reading extracted tags at the budget and never serializes the oversized fact record', async () => {
    const first = await new MemoryFn({ storage: { kind: 'memory' } }, storage, unit, fakeLLM()).upsertDocument({ ...scope, content: docV1, extract: true });
    unit.embedBatch.mockClear();
    const tag = 'x'.repeat(1024 * 1024);
    let reads = 0;
    const tags = new Proxy(new Array(300).fill(0), { get: (target, key, receiver) => (typeof key === 'string' && /^\d+$/.test(key) ? (reads++, tag) : Reflect.get(target, key, receiver)) });
    memory = new MemoryFn({ storage: { kind: 'memory' } }, storage, unit, oneFact(tags));
    const stringify = vi.spyOn(JSON, 'stringify');
    try {
      await expect(memory.upsertDocument({ ...scope, content: '# One', extract: true })).rejects.toMatchObject({ code: 'MEMORY_SOURCE_LIMIT_EXCEEDED' });
      expect(stringify.mock.calls.some(([value]) => value !== null && typeof value === 'object' && 'extractedTags' in value)).toBe(false);
    } finally {
      stringify.mockRestore();
    }
    // Each tag is 1 MiB + 3 bytes of JSON with its comma, so the 256th passes 256 MiB.
    expect(reads).toBe(256);
    expect(unit.embedBatch).not.toHaveBeenCalled();
    expect(await storage.getSourceState(scope)).toEqual({ contentHash: first.contentHash, chunkCount: 3 });
  });

  it('stops many facts with large caller metadata at the budget without serializing a fact record', async () => {
    const facts = Array.from({ length: 400 }, () => ({ content: 'A fact.', type: 'derived', confidence: 1, tags: ['doc'] }));
    memory = new MemoryFn({ storage: { kind: 'memory' } }, storage, unit, { generate: vi.fn(), generateJSON: vi.fn(async () => ({ facts })) } as unknown as LLMProvider);
    unit.embedBatch.mockClear();
    const stringify = vi.spyOn(JSON, 'stringify');
    try {
      await expect(memory.upsertDocument({ ...scope, content: '# One', extract: true, metadata: { note: 'm'.repeat(1024 * 1024) } }))
        .rejects.toMatchObject({ code: 'MEMORY_SOURCE_LIMIT_EXCEEDED' });
      expect(stringify.mock.calls.some(([value]) => value !== null && typeof value === 'object' && 'extractedTags' in value)).toBe(false);
    } finally {
      stringify.mockRestore();
    }
    expect(unit.embedBatch).not.toHaveBeenCalled();
    expect(await storage.getSourceState(scope)).toBeNull();
  });

  it.each([
    ['no caller metadata', undefined],
    ['caller metadata with the keys a fact record sets', { note: 'kept', extractedTags: ['caller'], confidence: 'caller', sourceChunk: 'x'.repeat(100) }],
    ['caller metadata holding only those keys', { confidence: { caller: true } }],
  ])('charges escaped extracted tags exactly with %s: the limit succeeds and one byte over fails', async (_name, metadata) => {
    // Escaped and multi-byte characters: a quote, a backslash, a control character, a 2-byte, a 3-byte and a 4-byte character.
    const escaped = `"\\${String.fromCharCode(1)}\u00e9\u20ac\u{1F600}`;
    const probe = await new MemoryFn({ storage: { kind: 'memory' } }, storage, unit, oneFact([escaped, 'x']))
      .upsertDocument({ ...scope, sourceKey: 'probe.md', content: '# One', extract: true, metadata });
    expect(probe.memories[0].metadata).toEqual({ ...metadata, extractedTags: [escaped, 'x'], confidence: 0.25, sourceChunk: 0 });
    const padding = MAX_SOURCE_REPLACE_BYTES - recordBytes(probe.memories[0]);
    const tagsOf = (extra: number) => [escaped, 'x'.repeat(1 + padding + extra)];
    // At the limit: the write is made, with exactly the budget in records as replaceSource counts them (plus the tag copies).
    // The write is stubbed so the test does not keep 256 MiB of rows.
    const replace = vi.spyOn(storage, 'replaceSourceIfChanged');
    let written = 0;
    replace.mockImplementationOnce(async input => {
      written = input.chunks.reduce((total, chunk) => total + recordBytes(chunk as Memory), 0);
      return { unchanged: false, memories: [] };
    });
    memory = new MemoryFn({ storage: { kind: 'memory' } }, storage, unit, oneFact(tagsOf(0)));
    await expect(memory.upsertDocument({ ...scope, content: '# One', extract: true, metadata })).resolves.toMatchObject({ unchanged: false });
    expect(written).toBe(MAX_SOURCE_REPLACE_BYTES);
    // One byte over in all: the vector's bytes are known only once it is embedded, so the write is refused after embedding.
    replace.mockClear();
    memory = new MemoryFn({ storage: { kind: 'memory' } }, storage, unit, oneFact(tagsOf(1)));
    await expect(memory.upsertDocument({ ...scope, content: '# Two', extract: true, metadata })).rejects.toMatchObject({ code: 'MEMORY_SOURCE_LIMIT_EXCEEDED' });
    expect(replace).not.toHaveBeenCalled();
    // One byte over before embedding: refused before the embedder is called.
    unit.embedBatch.mockClear();
    memory = new MemoryFn({ storage: { kind: 'memory' } }, storage, unit, oneFact(tagsOf(1 + sourceEmbeddingBytes([1]))));
    await expect(memory.upsertDocument({ ...scope, content: '# Two', extract: true, metadata })).rejects.toMatchObject({ code: 'MEMORY_SOURCE_LIMIT_EXCEEDED' });
    expect(unit.embedBatch).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
    expect(await storage.getSourceState(scope)).toBeNull();
  }, 180_000);
});

describe('upsertDocument vector budget', () => {
  it('charges each copied vector before copying the next, so one shared huge vector fails fast', async () => {
    // Each 1,000,000-component unit vector is about 22 MB of JSON, so the 13th passes 256 MiB.
    const huge = new Array<number>(1_000_000).fill(1);
    const shared = { embed: vi.fn(async () => huge), embedBatch: vi.fn(async (texts: string[]) => texts.map(() => huge)) };
    const first = await memory.upsertDocument({ ...scope, content: docV1 });
    memory = new MemoryFn({ storage: { kind: 'memory' } }, storage, shared);
    const content = Array.from({ length: 2_000 }, (_, index) => `# H${index}`).join('\n');
    await expect(memory.upsertDocument({ ...scope, content })).rejects.toMatchObject({ code: 'MEMORY_SOURCE_LIMIT_EXCEEDED' });
    expect(await storage.getSourceState(scope)).toEqual({ contentHash: first.contentHash, chunkCount: 3 });
  });
});

describe('add() candidates and source rows', () => {
  /** A memory adapter that rejects topK above 100, honouring and declaring excludeSources, or ignoring it. */
  class Capped extends MemoryStorageAdapter {
    constructor(private readonly honours: boolean) { super(); }
    override get excludesSources(): true | undefined { return this.honours ? true : undefined; }
    override async searchVectors(params: Parameters<MemoryStorageAdapter['searchVectors']>[0]) {
      if (params.topK > 100) throw new Error('TOPK_LIMIT');
      if (this.honours) return super.searchVectors(params);
      const { excludeSources: _ignored, ...rest } = params;
      return super.searchVectors(rest);
    }
  }
  const memoryScope = { tenantId: scope.tenantId, containerTags: scope.containerTags };
  /** Ordinary text points near [1, 0] at `similarity`; everything else, including the source chunks, is exactly [1, 0]. */
  const angled = (similarity: number) => ({
    embed: vi.fn(async (text: string) => (text.startsWith('ordinary') ? [similarity, Math.sqrt(1 - similarity ** 2)] : [1, 0])),
    embedBatch: vi.fn(async (texts: string[]) => texts.map(text => (text.startsWith('ordinary') ? [similarity, Math.sqrt(1 - similarity ** 2)] : [1, 0]))),
  });
  const resolvingLLM = (): LLMProvider => ({
    generate: vi.fn(),
    generateJSON: vi.fn(async (prompt: string) => (prompt.includes('"facts"')
      ? { facts: [{ content: 'new fact', type: 'derived', confidence: 1, tags: [] }] }
      : { type: 'updates', reasoning: 'newer' })) as LLMProvider['generateJSON'],
  });
  // 80 source chunks rank above every ordinary memory.
  const eighty = Array.from({ length: 80 }, (_, index) => `# H${index}`).join('\n');
  /** 80 source rows at [1, 0], written through the base replaceSource, as an adapter without the declaration may hold them. */
  const seedEighty = (adapter: StorageAdapter) => adapter.replaceSource({ ...scope, contentHash: 'seeded', chunks: Array.from({ length: 80 }, (_, index) => ({
    tenantId: scope.tenantId, containerTags: scope.containerTags, content: `source ${index}`, type: 'document', embedding: [1, 0], isLatest: true,
  })) });
  const revisions = (rows: Memory[]) => rows.map(row => `${row.id}:${row.revision}:${row.content}`).sort();
  const liveSourceRows = async (adapter: StorageAdapter) => (await adapter.searchVectors({ ...memoryScope, embedding: [1, 0], topK: 100 })).filter(row => row.sourceKey);

  it('refuses upserts on an adapter that has not declared excludesSources, before any provider call', async () => {
    const llm = fakeLLM();
    for (const adapter of [new Capped(false), Object.assign(new (class extends MemoryStorageAdapter {
      override async searchVectors(params: Parameters<MemoryStorageAdapter['searchVectors']>[0]) { return super.searchVectors(params); }
    })(), {})]) {
      memory = new MemoryFn({ storage: { kind: 'memory' } }, adapter, embedder, llm);
      await expect(memory.upsertDocument({ ...scope, content: docV1 })).rejects.toThrow('MEMORY_DOCUMENTS_UNSUPPORTED');
      await expect(memory.upsertDocument({ ...scope, content: docV1, extract: true })).rejects.toThrow('MEMORY_DOCUMENTS_UNSUPPORTED');
      expect(await adapter.getSourceState(scope)).toBeNull();
    }
    expect(embedder.embedBatch).not.toHaveBeenCalled();
    expect(llm.generateJSON).not.toHaveBeenCalled();
    expect(new MemoryStorageAdapter().excludesSources).toBe(true);
  });

  it('finds the ordinary duplicate and conflict behind 80 source rows written through replaceSource on a declared capped adapter', async () => {
    storage = new Capped(true);
    memory = new MemoryFn({ storage: { kind: 'memory' } }, storage, angled(0.99));
    await memory.add({ ...memoryScope, content: 'ordinary fact' });
    const seeded = await seedEighty(storage);
    const search = vi.spyOn(storage, 'searchVectors');
    expect((await memory.add({ ...memoryScope, content: 'same fact' })).summary).toEqual({ created: 0, updated: 0, deduplicated: 1 });
    expect(search.mock.calls.map(([params]) => [params.topK, params.excludeSources])).toEqual([[1, true]]);
    expect(revisions(await liveSourceRows(storage))).toEqual(revisions(seeded));

    storage = new Capped(true);
    const embedderAt = angled(0.9);
    const ordinary = await new MemoryFn({ storage: { kind: 'memory' } }, storage, embedderAt).add({ ...memoryScope, content: 'ordinary older fact' });
    const sources = await seedEighty(storage);
    memory = new MemoryFn({ storage: { kind: 'memory' } }, storage, embedderAt, resolvingLLM());
    const resolve = vi.spyOn(storage, 'searchVectors');
    const added = await memory.add({ ...memoryScope, content: 'note' });
    expect(resolve.mock.calls.map(([params]) => [params.topK, params.excludeSources])).toEqual([[1, true], [3, true]]);
    expect(added.summary).toEqual({ created: 1, updated: 1, deduplicated: 0 });
    expect(added.relationships.map(link => [link.toId, link.type])).toEqual([[ordinary.memories[0].id, 'updates']]);
    expect((await storage.getMemory({ ...memoryScope, id: ordinary.memories[0].id }))!.isLatest).toBe(false);
    expect(revisions(await liveSourceRows(storage))).toEqual(revisions(sources));
  });

  it('deduplicates in one topK 1 call behind 80 source rows on a capped adapter that honours excludeSources', async () => {
    storage = new Capped(true);
    memory = new MemoryFn({ storage: { kind: 'memory' } }, storage, angled(0.99));
    await memory.add({ ...memoryScope, content: 'ordinary fact' });
    await memory.upsertDocument({ ...scope, content: eighty });
    const search = vi.spyOn(storage, 'searchVectors');
    expect((await memory.add({ ...memoryScope, content: 'same fact' })).summary).toEqual({ created: 0, updated: 0, deduplicated: 1 });
    expect(search.mock.calls.map(([params]) => [params.topK, params.excludeSources])).toEqual([[1, true]]);
  });

  it('resolves against the ordinary candidate in one topK 3 call behind 80 source rows on a capped adapter that honours excludeSources', async () => {
    storage = new Capped(true);
    const embedderAt = angled(0.9);
    const ordinary = await new MemoryFn({ storage: { kind: 'memory' } }, storage, embedderAt).add({ ...memoryScope, content: 'ordinary older fact' });
    await new MemoryFn({ storage: { kind: 'memory' } }, storage, embedderAt).upsertDocument({ ...scope, content: eighty });
    memory = new MemoryFn({ storage: { kind: 'memory' } }, storage, embedderAt, resolvingLLM());
    const search = vi.spyOn(storage, 'searchVectors');
    const added = await memory.add({ ...memoryScope, content: 'note' });
    expect(search.mock.calls.map(([params]) => [params.topK, params.excludeSources])).toEqual([[1, true], [3, true]]);
    expect(added.summary).toEqual({ created: 1, updated: 1, deduplicated: 0 });
    expect(added.relationships.map(link => [link.toId, link.type])).toEqual([[ordinary.memories[0].id, 'updates']]);
  });

  it('makes only the base calls on a capped adapter that ignores excludeSources, and never touches a source row', async () => {
    storage = new Capped(false);
    const embedderAt = angled(0.9);
    const source = { contentHash: 'seeded', memories: await seedEighty(storage) };
    memory = new MemoryFn({ storage: { kind: 'memory' } }, storage, embedderAt, resolvingLLM());
    const search = vi.spyOn(storage, 'searchVectors');
    const update = vi.spyOn(storage, 'updateMemory');
    const added = await memory.add({ ...memoryScope, content: 'note' });
    expect(search.mock.calls.map(([params]) => params.topK)).toEqual([1, 3]);
    expect(added.summary).toEqual({ created: 1, updated: 0, deduplicated: 0 });
    expect(added.relationships).toEqual([]);
    expect(update).not.toHaveBeenCalled();
    expect(await storage.getSourceState(scope)).toEqual({ contentHash: source.contentHash, chunkCount: 80 });
    const live = await memory.search({ q: 'any', ...memoryScope, limit: 100 });
    expect(live.results.filter(entry => entry.sourceKey).map(entry => entry.id).sort()).toEqual(source.memories.map(entry => entry.id).sort());
    // Without a resolver, deduplication makes its one call and stores the new memory beside the source.
    storage = new Capped(false);
    memory = new MemoryFn({ storage: { kind: 'memory' } }, storage, angled(0.99));
    const seeded = await seedEighty(storage);
    const dedup = vi.spyOn(storage, 'searchVectors');
    expect((await memory.add({ ...memoryScope, content: 'same fact' })).summary).toEqual({ created: 1, updated: 0, deduplicated: 0 });
    expect(dedup.mock.calls.map(([params]) => params.topK)).toEqual([1]);
    expect(revisions(await liveSourceRows(storage))).toEqual(revisions(seeded));
  });

  it('makes one call per candidate search on the built-in memory adapter, which never returns source rows', async () => {
    memory = new MemoryFn({ storage: { kind: 'memory' } }, storage, embedder, resolvingLLM());
    await memory.upsertDocument({ ...scope, content: docV1 });
    const search = vi.spyOn(storage, 'searchVectors');
    await memory.add({ ...memoryScope, content: 'note' });
    expect(search.mock.calls.map(([params]) => [params.topK, params.excludeSources])).toEqual([[1, true], [3, true]]);
    for (const result of search.mock.results) expect((await result.value).filter((row: Memory) => row.sourceKey)).toEqual([]);
  });

  it('drops source rows an adapter returns anyway, without querying again', async () => {
    const page = [0, 1, 2].map(index => ({ id: `source-${index}`, sourceKey: 'guide.md' }) as Memory);
    const search = vi.spyOn(storage, 'searchVectors').mockImplementation(async () => page);
    expect(await searchOrdinaryCandidates(storage, { ...memoryScope, embedding: [1, 0], threshold: 0.75 }, 3)).toEqual([]);
    expect(search.mock.calls.map(([params]) => params.topK)).toEqual([3]);
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryFn, MemoryStorageAdapter, sha256Hex, type Embedder, type LLMProvider, type Memory, type StorageAdapter } from '../src';

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
    // Facts of just over 1 MiB pass 256 MiB at the 256th; validating a fact reads its content 3 times.
    expect(reads).toBe(3 * 256);
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
  ])('rejects %s and keeps the previous chunks searchable', async (_name, batch) => {
    const first = await memory.upsertDocument({ ...scope, content: docV1 });
    embedder.embedBatch.mockResolvedValueOnce(batch as number[][]);
    await expect(memory.upsertDocument({ ...scope, content: docV2 })).rejects.toThrow('MEMORY_EMBEDDING_INVALID');
    expect((await searchAll()).map(chunk => chunk.id).sort()).toEqual(first.memories.map(chunk => chunk.id).sort());
    // The new hash was not stored, so a retry embeds again.
    expect(await memory.upsertDocument({ ...scope, content: docV2 })).toMatchObject({ unchanged: false, chunks: 2 });
  });

  it('stores each vector at unit length, so vectors of any finite scale stay searchable', async () => {
    const scaled = { embed: vi.fn(async () => [1, 1]), embedBatch: vi.fn(async (texts: string[]) => texts.map((_, index) => (index ? [1e-40, 1e-40] : [1e308, 0]))) };
    memory = new MemoryFn({ storage: { kind: 'memory' } }, storage, scaled);
    const result = await memory.upsertDocument({ ...scope, content: docV2 });
    expect(result.memories[0].embedding).toEqual([1, 0]);
    for (const component of result.memories[1].embedding!) expect(component).toBeCloseTo(Math.SQRT1_2, 15);
    const found = await memory.search({ q: 'any', tenantId: scope.tenantId, containerTags: scope.containerTags, threshold: 0.99 });
    expect(found.results.map(chunk => chunk.id)).toEqual([result.memories[1].id]);
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
    // 84 KB of unit-vector JSON (storage total about 252 MB): each is under 256 MiB, together they are not.
    // The vector's toJSON would shrink it to 3 bytes; the copy that storage writes is what is charged.
    const containerTags = Array.from({ length: 1_000 }, (_, index) => `${index}`.padEnd(60, 't'));
    const wide = Object.assign(new Array<number>(4_000).fill(1), { toJSON: () => [1] });
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

describe('add() candidates on an adapter that ignores excludeSources', () => {
  class IgnoresExcludeSources extends MemoryStorageAdapter {
    override async searchVectors(params: Parameters<MemoryStorageAdapter['searchVectors']>[0]) {
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

  it('deduplicates against an ordinary memory ranked behind a source chunk', async () => {
    storage = new IgnoresExcludeSources();
    memory = new MemoryFn({ storage: { kind: 'memory' } }, storage, angled(0.99));
    await memory.add({ ...memoryScope, content: 'ordinary fact' });
    await memory.upsertDocument({ ...scope, content: docV1 });
    const again = await memory.add({ ...memoryScope, content: 'same fact' });
    expect(again.summary).toEqual({ created: 0, updated: 0, deduplicated: 1 });
  });

  it('resolves against an ordinary memory ranked behind three source chunks', async () => {
    storage = new IgnoresExcludeSources();
    const embedderAt = angled(0.9);
    const ordinary = await new MemoryFn({ storage: { kind: 'memory' } }, storage, embedderAt).add({ ...memoryScope, content: 'ordinary older fact' });
    await new MemoryFn({ storage: { kind: 'memory' } }, storage, embedderAt).upsertDocument({ ...scope, content: docV1 });
    memory = new MemoryFn({ storage: { kind: 'memory' } }, storage, embedderAt, resolvingLLM());
    const added = await memory.add({ ...memoryScope, content: 'note' });
    expect(added.summary).toEqual({ created: 1, updated: 1, deduplicated: 0 });
    expect(added.relationships.map(link => [link.toId, link.type])).toEqual([[ordinary.memories[0].id, 'updates']]);
    expect(await storage.getSourceState(scope)).toMatchObject({ chunkCount: 3 });
  });

  it('makes one call per candidate search when the adapter honours excludeSources', async () => {
    memory = new MemoryFn({ storage: { kind: 'memory' } }, storage, embedder, resolvingLLM());
    await memory.upsertDocument({ ...scope, content: docV1 });
    const search = vi.spyOn(storage, 'searchVectors');
    await memory.add({ ...memoryScope, content: 'note' });
    expect(search.mock.calls.map(([params]) => [params.topK, params.excludeSources])).toEqual([[1, true], [3, true]]);
  });

  it('stops after a bounded number of deeper queries when every row belongs to a source', async () => {
    memory = new MemoryFn({ storage: { kind: 'memory' } }, storage, embedder, resolvingLLM());
    const search = vi.spyOn(storage, 'searchVectors').mockImplementation(async params =>
      Array.from({ length: params.topK }, (_, index) => ({ id: `source-${index}`, sourceKey: 'guide.md' }) as Memory));
    const added = await memory.add({ ...memoryScope, content: 'note' });
    expect(added.summary).toEqual({ created: 1, updated: 0, deduplicated: 0 });
    expect(search.mock.calls.map(([params]) => params.topK)).toEqual([1, 2, 4, 8, 16, 32, 64, 3, 6, 12, 24, 48, 64]);
  });
});

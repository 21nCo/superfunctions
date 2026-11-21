import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryFn, MemoryStorageAdapter, sha256Hex, type Embedder, type LLMProvider } from '../src';

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

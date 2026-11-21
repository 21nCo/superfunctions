import { beforeEach, describe, expect, it, vi } from 'vitest';

const { createCompletion, createEmbedding } = vi.hoisted(() => ({
  createCompletion: vi.fn(),
  createEmbedding: vi.fn(),
}));

vi.mock('openai', () => ({
  default: class {
    chat = { completions: { create: createCompletion } };
    embeddings = { create: createEmbedding };
  },
}));

import { OpenAILLM } from '../src/providers/llm/openai';
import { OpenAIEmbedder, OPENAI_EMBEDDING_REQUEST_TOKENS } from '../src/providers/embed/openai';
import { MemoryFn, MemoryStorageAdapter } from '../src';

describe('OpenAILLM structured output', () => {
  beforeEach(() => {
    createCompletion.mockReset();
    createCompletion.mockResolvedValue({ choices: [{ message: { content: '{"value":"ok"}' } }] });
  });

  it('passes the caller schema through the OpenAI json_schema contract', async () => {
    const schema = {
      type: 'object',
      properties: { value: { type: 'string' } },
      required: ['value'],
      additionalProperties: false,
    };
    const llm = new OpenAILLM({ apiKey: 'test-key' });

    await expect(llm.generateJSON('Return a value.', schema)).resolves.toEqual({ value: 'ok' });
    expect(createCompletion).toHaveBeenCalledWith(expect.objectContaining({
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'memoryfn_output', strict: true, schema },
      },
    }));
  });
});

describe('OpenAIEmbedder batching', () => {
  beforeEach(() => createEmbedding.mockReset());

  it('batches within provider limits and restores response index order', async () => {
    createEmbedding
      .mockResolvedValueOnce({ data: [
        { index: 1, embedding: [2] },
        { index: 0, embedding: [1] },
      ] })
      .mockResolvedValueOnce({ data: [{ index: 0, embedding: [3] }] });

    const embedder = new OpenAIEmbedder({ apiKey: 'test-key', batchSize: 2 });
    await expect(embedder.embedBatch(['one', 'two', 'three'])).resolves.toEqual([[1], [2], [3]]);
    expect(createEmbedding).toHaveBeenCalledTimes(2);
  });

  it('rejects incomplete provider response indices', async () => {
    createEmbedding.mockResolvedValue({ data: [{ index: 1, embedding: [2] }] });
    const embedder = new OpenAIEmbedder({ apiKey: 'test-key', batchSize: 2 });
    await expect(embedder.embedBatch(['one', 'two'])).rejects.toThrow('MEMORY_EMBEDDING_RESPONSE_MISMATCH');
  });
});

describe('OpenAIEmbedder request token budget', () => {
  /** Answers every request with [1, n] for the n-th input of the whole run, so order is visible. */
  const answer = () => {
    let next = 0;
    return async ({ input }: { input: string | string[] }) => ({
      data: (Array.isArray(input) ? input : [input]).map((_, index) => ({ index, embedding: [1, ++next] })),
    });
  };
  beforeEach(() => {
    createEmbedding.mockReset();
    createEmbedding.mockImplementation(answer());
  });

  it('splits requests by the UTF-8 bytes of their inputs and keeps the input order', async () => {
    const embedder = new OpenAIEmbedder({ apiKey: 'test-key' });
    // 100,000 two-byte characters are 200,000 bytes: two of them pass the 300,000-token budget.
    const texts = ['\u00e9'.repeat(100_000), 'a'.repeat(100_000), 'b'.repeat(150_000), 'c', 'd'.repeat(OPENAI_EMBEDDING_REQUEST_TOKENS + 1)];
    await expect(embedder.embedBatch(texts)).resolves.toEqual([[1, 1], [1, 2], [1, 3], [1, 4], [1, 5]]);
    expect(createEmbedding.mock.calls.map(([request]) => request.input.map((text: string) => text.length)))
      .toEqual([[100_000, 100_000], [150_000, 1], [OPENAI_EMBEDDING_REQUEST_TOKENS + 1]]);
  });

  it('indexes an under-cap document across requests in order, and a failed later request keeps the previous source', async () => {
    const storage = new MemoryStorageAdapter();
    const memory = new MemoryFn({ storage: { kind: 'memory' } }, storage, new OpenAIEmbedder({ apiKey: 'test-key' }));
    const scope = { tenantId: 'tenant-a', containerTags: ['docs'], sourceKey: 'big.md' };
    const first = await memory.upsertDocument({ ...scope, content: '# Seed\n\nSeed text.' });
    // 400 sections of about 1,000 bytes: about 400 KB, inside the 1 MiB body cap but over one request's budget.
    const content = Array.from({ length: 400 }, (_, index) => `# Section ${index}\n\n${'w'.repeat(1_000)}`).join('\n\n');
    createEmbedding.mockReset();
    createEmbedding.mockImplementationOnce(answer()).mockRejectedValueOnce(new Error('provider down'));
    await expect(memory.upsertDocument({ ...scope, content })).rejects.toThrow('provider down');
    expect(await storage.getSourceState(scope)).toEqual({ contentHash: first.contentHash, chunkCount: 1 });
    createEmbedding.mockReset();
    createEmbedding.mockImplementation(answer());
    const result = await memory.upsertDocument({ ...scope, content });
    expect(result).toMatchObject({ unchanged: false, chunks: 400 });
    expect(createEmbedding.mock.calls.length).toBeGreaterThan(1);
    expect(createEmbedding.mock.calls.flatMap(([request]) => request.input)).toEqual(result.memories.map(chunk => chunk.content));
    expect(result.memories.map(chunk => chunk.embedding![1])).toEqual(Array.from({ length: 400 }, (_, index) => index + 1));
  });
});

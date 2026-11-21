import { describe, expect, it, vi } from 'vitest';
import { createMemoryRouter } from '../src/http/router';
import { MemoryFn, MemoryStorageAdapter, type IMemoryFn } from '../src';

const json = (method: string, path: string, data: unknown, extraHeaders: Record<string, string> = {}) =>
  new Request(`https://test${path}`, { method, headers: { 'content-type': 'application/json', ...extraHeaders }, body: JSON.stringify(data) });

function mockMemory() {
  return {
    add: vi.fn().mockResolvedValue({}),
    search: vi.fn().mockResolvedValue({ results: [] }),
    upsertDocument: vi.fn().mockResolvedValue({ sourceKey: 'k', unchanged: false }),
    forgetBySource: vi.fn().mockResolvedValue({ sourceKey: 'k', deleted: 1 }),
  } satisfies IMemoryFn;
}

const trusted = { tenantId: 'trusted', containerTags: ['private'] };

// Each document route next to the memory route whose scope rules it shares.
const cases = [
  { name: 'POST /v1/memories', method: 'POST', path: '/v1/memories', body: { content: 'x' }, call: 'add' },
  { name: 'PUT /v1/documents', method: 'PUT', path: '/v1/documents', body: { sourceKey: 'k', content: 'x' }, call: 'upsertDocument' },
  { name: 'DELETE /v1/documents', method: 'DELETE', path: '/v1/documents', body: { sourceKey: 'k' }, call: 'forgetBySource' },
] as const;

describe.each(cases)('$name scope rules', ({ method, path, body, call }) => {
  it('passes the trusted tenant and tags plus body tags to the pipeline', async () => {
    const memory = mockMemory();
    const router = createMemoryRouter(memory, { authorize: vi.fn().mockResolvedValue(trusted) });
    const response = await router.handle(json(method, path, { ...body, containerTags: ['extra'] }));
    expect(response.status).toBe(200);
    expect(memory[call]).toHaveBeenCalledTimes(1);
    expect(memory[call].mock.calls[0][0]).toMatchObject({ ...body, tenantId: 'trusted', containerTags: ['private', 'extra'] });
  });

  it('returns 401 without authorization and 400 for a caller-selected tenant or unknown field', async () => {
    const memory = mockMemory();
    const authorize = vi.fn().mockResolvedValue(trusted);
    const router = createMemoryRouter(memory, { authorize });
    expect((await router.handle(json(method, path, { ...body, tenantId: 'other' }))).status).toBe(400);
    expect((await router.handle(json(method, path, { ...body, unknown: true }))).status).toBe(400);
    authorize.mockResolvedValue(null);
    const unauthorized = await router.handle(json(method, path, body));
    expect(unauthorized.status).toBe(401);
    expect(await unauthorized.json()).toEqual({ error: 'UNAUTHORIZED' });
    expect(memory[call]).not.toHaveBeenCalled();
  });

  it('rejects an authorized scope without a tenant the same way, before the pipeline runs', async () => {
    const memory = mockMemory();
    const router = createMemoryRouter(memory, { authorize: vi.fn().mockResolvedValue({ tenantId: '', containerTags: [] }) });
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const response = await router.handle(json(method, path, body));
    errors.mockRestore();
    expect(response.status).toBe(500);
    expect(memory[call]).not.toHaveBeenCalled();
  });

  it('enforces the body limit', async () => {
    const memory = mockMemory();
    const router = createMemoryRouter(memory, { authorize: vi.fn().mockResolvedValue(trusted), maxBodyBytes: 256 });
    const response = await router.handle(json(method, path, { ...body, containerTags: ['x'.repeat(300)] }));
    expect(response.status).toBe(413);
    expect(memory[call]).not.toHaveBeenCalled();
  });
});

describe('document routes', () => {
  it.each([['PUT', 'upsertDocument'], ['DELETE', 'forgetBySource']] as const)('%s answers malformed JSON with 400, keeping 401, 413 and 500', async (method, call) => {
    const raw = (body: string) => new Request('https://test/v1/documents', { method, headers: { 'content-type': 'application/json' }, body });
    const memory = mockMemory();
    const authorize = vi.fn().mockResolvedValue(trusted);
    const router = createMemoryRouter(memory, { authorize, maxBodyBytes: 256 });
    const malformed = await router.handle(raw('{"sourceKey": "k",'));
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toEqual({ error: 'INVALID_INPUT' });
    expect((await router.handle(raw(`{"sourceKey": "${'x'.repeat(300)}`))).status).toBe(413);
    expect(memory[call]).not.toHaveBeenCalled();
    memory[call].mockRejectedValueOnce(new Error('storage unavailable'));
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const failed = await router.handle(json(method, '/v1/documents', { sourceKey: 'k', ...(method === 'PUT' ? { content: 'x' } : {}) }));
    errors.mockRestore();
    expect(failed.status).toBe(500);
    // A body stream that fails while being read, even with a SyntaxError, is a server error, not caller input.
    const broken = new Request('https://test/v1/documents', { method, headers: { 'content-type': 'application/json' },
      body: new ReadableStream({ pull(controller) { controller.error(new SyntaxError('stream failed')); } }), duplex: 'half' } as RequestInit);
    const readErrors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const interrupted = await router.handle(broken);
    readErrors.mockRestore();
    expect(interrupted.status).toBe(500);
    expect(memory[call]).toHaveBeenCalledTimes(1);
    authorize.mockResolvedValue(null);
    expect((await router.handle(raw('{'))).status).toBe(401);
  });

  it('validates PUT fields', async () => {
    const memory = mockMemory();
    const router = createMemoryRouter(memory, { authorize: vi.fn().mockResolvedValue(trusted) });
    for (const bad of [{ content: 'x' }, { sourceKey: 'k' }, { sourceKey: 'k', content: 'x', extract: 'yes' },
      { sourceKey: 'k', content: 'x', type: 'secret' }, { sourceKey: 'k', content: 'x', chunking: { targetChars: 100, extra: 1 } }]) {
      expect((await router.handle(json('PUT', '/v1/documents', bad))).status).toBe(400);
    }
    expect(memory.upsertDocument).not.toHaveBeenCalled();
    const full = { sourceKey: 'k', content: 'x', contentHash: 'etag-1', metadata: { a: 1 }, type: 'document', extract: false, chunking: { targetChars: 200, overlapChars: 20 } };
    expect((await router.handle(json('PUT', '/v1/documents', full))).status).toBe(200);
    expect(memory.upsertDocument.mock.calls[0][0]).toEqual({ ...full, tenantId: 'trusted', containerTags: ['private'] });
  });

  it('stores, skips, replaces and forgets a source end to end', async () => {
    const vector = (text: string) => [text.length % 7, text.includes('v2') ? 1 : 0, 1];
    const embedder = { embed: vi.fn(async (text: string) => vector(text)), embedBatch: vi.fn(async (texts: string[]) => texts.map(vector)) };
    const memory = new MemoryFn({ storage: { kind: 'memory' } }, new MemoryStorageAdapter(), embedder);
    const router = createMemoryRouter(memory, { authorize: vi.fn().mockResolvedValue(trusted) });
    const put = async (content: string) => router.handle(json('PUT', '/v1/documents', { sourceKey: 'guide.md', containerTags: ['docs'], content }));
    const search = async () => (await (await router.handle(json('POST', '/v1/memories/search', { q: 'guide', containerTags: ['docs'], limit: 100 }))).json()).results;

    const first = await (await put('# A\n\nv1 one\n\n# B\n\nv1 two')).json();
    expect(first).toMatchObject({ sourceKey: 'guide.md', unchanged: false, chunks: 2 });
    expect(await (await put('# A\n\nv1 one\n\n# B\n\nv1 two')).json()).toMatchObject({ unchanged: true, chunks: 2, memories: [] });
    await put('# A\n\nv2 only');
    expect((await search()).map((entry: { content: string }) => entry.content)).toEqual(['# A\n\nv2 only']);
    // The tag set must match the PUT's: other tags name another source.
    const wrongTags = await router.handle(json('DELETE', '/v1/documents', { sourceKey: 'guide.md' }));
    expect(await wrongTags.json()).toEqual({ sourceKey: 'guide.md', deleted: 0 });
    const forgotten = await router.handle(json('DELETE', '/v1/documents', { sourceKey: 'guide.md', containerTags: ['docs'] }));
    expect(await forgotten.json()).toEqual({ sourceKey: 'guide.md', deleted: 1 });
    expect(await search()).toEqual([]);
  });

  it('maps pipeline input errors to 400 and source limits to 413', async () => {
    const embedder = { embed: vi.fn(async () => [1]), embedBatch: vi.fn(async (texts: string[]) => texts.map(() => [1])) };
    const memory = new MemoryFn({ storage: { kind: 'memory' } }, new MemoryStorageAdapter(), embedder);
    const router = createMemoryRouter(memory, { authorize: vi.fn().mockResolvedValue(trusted) });
    const blankKey = await router.handle(json('PUT', '/v1/documents', { sourceKey: ' ', content: 'x' }));
    expect(blankKey.status).toBe(400);
    expect(await blankKey.json()).toEqual({ error: 'INVALID_INPUT', code: 'MEMORY_SOURCE_KEY_REQUIRED' });
    expect((await router.handle(json('PUT', '/v1/documents', { sourceKey: 'k', content: ' \n ' }))).status).toBe(400);
    expect((await router.handle(json('PUT', '/v1/documents', { sourceKey: 'k', content: 'x', chunking: { targetChars: 10 } }))).status).toBe(400);
    expect((await router.handle(json('DELETE', '/v1/documents', { sourceKey: 'k', containerTags: [' '] }))).status).toBe(400);
    const tooLong = await router.handle(json('DELETE', '/v1/documents', { sourceKey: 'k'.repeat(1025) }));
    expect(tooLong.status).toBe(413);
    expect(await tooLong.json()).toEqual({ error: 'MEMORY_SOURCE_LIMIT_EXCEEDED' });
    expect(embedder.embedBatch).not.toHaveBeenCalled();
  });

  it('answers 413 before embedding when the per-record tag copies exceed the byte budget, leaving the source unchanged', async () => {
    const embedder = { embed: vi.fn(async () => [1]), embedBatch: vi.fn(async (texts: string[]) => texts.map(() => [1])) };
    const storage = new MemoryStorageAdapter();
    const router = createMemoryRouter(new MemoryFn({ storage: { kind: 'memory' } }, storage, embedder), { authorize: vi.fn().mockResolvedValue(trusted) });
    // About 64 KB of distinct tags, copied onto each of 3,600 chunks, exceeds 256 MiB inside a body of about 100 KB.
    const containerTags = Array.from({ length: 4_000 }, (_, index) => `${index}`.padEnd(16, 't'));
    const seeded = await router.handle(json('PUT', '/v1/documents', { sourceKey: 'k', containerTags, content: '# Seed' }));
    expect(seeded.status).toBe(200);
    embedder.embedBatch.mockClear();
    const content = Array.from({ length: 3_600 }, (_, index) => `# H${index}`).join('\n');
    const response = await router.handle(json('PUT', '/v1/documents', { sourceKey: 'k', containerTags, content }));
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: 'MEMORY_SOURCE_LIMIT_EXCEEDED' });
    expect(embedder.embedBatch).not.toHaveBeenCalled();
    expect(await storage.getSourceState({ tenantId: trusted.tenantId, containerTags: [...trusted.containerTags, ...containerTags], sourceKey: 'k' }))
      .toMatchObject({ chunkCount: 1 });
  });

  it('rejects an oversized or unstorable contentHash before any provider call', async () => {
    const embedder = { embed: vi.fn(), embedBatch: vi.fn(async () => { throw new Error('provider down'); }) };
    const memory = new MemoryFn({ storage: { kind: 'memory' } }, new MemoryStorageAdapter(), embedder);
    const router = createMemoryRouter(memory, { authorize: vi.fn().mockResolvedValue(trusted) });
    const tooLong = await router.handle(json('PUT', '/v1/documents', { sourceKey: 'k', content: 'x', contentHash: 'h'.repeat(1_025) }));
    expect(tooLong.status).toBe(413);
    expect(await tooLong.json()).toEqual({ error: 'MEMORY_SOURCE_LIMIT_EXCEEDED' });
    const nul = await router.handle(json('PUT', '/v1/documents', { sourceKey: 'k', content: 'x', contentHash: `etag${String.fromCharCode(0)}` }));
    expect(nul.status).toBe(400);
    expect(await nul.json()).toEqual({ error: 'INVALID_INPUT', code: 'MEMORY_SOURCE_HASH_REQUIRED' });
    expect(embedder.embedBatch).not.toHaveBeenCalled();
  });

  it('answers 501 when the memory implementation has no document methods', async () => {
    const legacy: IMemoryFn = { add: vi.fn(), search: vi.fn() };
    const router = createMemoryRouter(legacy, { authorize: vi.fn().mockResolvedValue(trusted) });
    for (const [method, body] of [['PUT', { sourceKey: 'k', content: 'x' }], ['DELETE', { sourceKey: 'k' }]] as const) {
      const response = await router.handle(json(method, '/v1/documents', body));
      expect(response.status).toBe(501);
      expect(await response.json()).toEqual({ error: 'MEMORY_DOCUMENTS_UNSUPPORTED' });
    }
  });

  it('answers 400 for document text or metadata with a lone surrogate or NUL, before any provider call', async () => {
    const embedder = { embed: vi.fn(), embedBatch: vi.fn(async (texts: string[]) => texts.map(() => [1])) };
    const storage = new MemoryStorageAdapter();
    const router = createMemoryRouter(new MemoryFn({ storage: { kind: 'memory' } }, storage, embedder), { authorize: vi.fn().mockResolvedValue(trusted) });
    for (const content of ['Install \uD800 now', `Install ${String.fromCharCode(0)} now`]) {
      // JSON.stringify writes both as \u escapes, so the body itself is valid JSON.
      const response = await router.handle(json('PUT', '/v1/documents', { sourceKey: 'k', content }));
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: 'INVALID_INPUT', code: 'MEMORY_CONTENT_INVALID' });
    }
    const metadata = await router.handle(json('PUT', '/v1/documents', { sourceKey: 'k', content: 'x', metadata: { note: 'a\uD800' } }));
    expect(metadata.status).toBe(400);
    expect(await metadata.json()).toEqual({ error: 'INVALID_INPUT', code: 'MEMORY_METADATA_INVALID' });
    expect(embedder.embedBatch).not.toHaveBeenCalled();
    const emoji = await router.handle(json('PUT', '/v1/documents', { sourceKey: 'k', content: 'Smile \u{1F600}' }));
    expect(emoji.status).toBe(200);
    expect((await emoji.json()).memories[0].content).toBe('Smile \u{1F600}');
  });

  it('answers 501 when the storage cannot replace a source atomically, before any provider call', async () => {
    const inner = new MemoryStorageAdapter();
    const storage = Object.assign(Object.create(inner) as MemoryStorageAdapter, { replaceSourceIfChanged: undefined });
    const embedder = { embed: vi.fn(), embedBatch: vi.fn(async (texts: string[]) => texts.map(() => [1])) };
    const router = createMemoryRouter(new MemoryFn({ storage: { kind: 'memory' } }, storage, embedder), { authorize: vi.fn().mockResolvedValue(trusted) });
    const response = await router.handle(json('PUT', '/v1/documents', { sourceKey: 'k', content: 'x' }));
    expect(response.status).toBe(501);
    expect(await response.json()).toEqual({ error: 'MEMORY_DOCUMENTS_UNSUPPORTED' });
    expect(embedder.embedBatch).not.toHaveBeenCalled();
  });

  it('leaves other pipeline failures to the router error handler', async () => {
    const memory = new MemoryFn({ storage: { kind: 'memory' } }, new MemoryStorageAdapter());
    const router = createMemoryRouter(memory, { authorize: vi.fn().mockResolvedValue(trusted) });
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect((await router.handle(json('PUT', '/v1/documents', { sourceKey: 'k', content: 'x' }))).status).toBe(500);
    errors.mockRestore();
  });
});

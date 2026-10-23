import { describe, it, expect } from 'vitest';
import {
  createTestServer,
  req,
  json,
} from './helpers.js';
import {
  createRecFnServer,
  createMemoryStore,
  MemoryStorageAdapter,
  createNoopLogger,
  createSearchFnClient,
} from '../src/index.js';

describe('limits (TV-LIMIT-001, TV-LIMIT-002, TV-LIMIT-003)', () => {
  it('rejects limit > 100 on list bots (TV-LIMIT-002)', async () => {
    const { server } = createTestServer();
    const res = await server.router.handle(req('GET', '/api/v1/bots?limit=200'));
    expect(res.status).toBe(400);
    const body = await json(res);
    expect(body.ok).toBe(false);
    expect((body.error as { code: string }).code).toBe('BAD_REQUEST');
    expect((body.error as { message: string }).message).toContain('limit');
  });

  it('accepts limit 100 on list bots', async () => {
    const { server } = createTestServer();
    const res = await server.router.handle(req('GET', '/api/v1/bots?limit=100'));
    expect(res.status).toBe(200);
  });

  it('rejects search query > 500 chars', async () => {
    const store = createMemoryStore();
    const storage = new MemoryStorageAdapter();
    const server = createRecFnServer({
      store,
      storage,
      logger: createNoopLogger(),
      rateLimit: false,
      searchClient: createSearchFnClient(),
      validateApiKey: () => ({ namespace: 'ns_test', apiKey: 'sk' }),
    });
    const longQuery = 'a'.repeat(501);
    const res = await server.router.handle(
      new Request(`http://localhost/api/v1/transcripts/search?q=${encodeURIComponent(longQuery)}`, {
        method: 'GET',
        headers: { Authorization: 'Bearer sk' },
      }),
    );
    expect(res.status).toBe(400);
    const body = await json(res);
    expect(body.ok).toBe(false);
    expect((body.error as { message: string }).message).toContain('500');
  });
});

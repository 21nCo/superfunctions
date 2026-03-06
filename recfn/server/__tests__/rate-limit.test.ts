import { describe, it, expect } from 'vitest';
import {
  createRecFnServer,
  createMemoryStore,
  MemoryStorageAdapter,
  createNoopLogger,
} from '../src/index.js';

describe('rate limiting (TV-SEC-001)', () => {
  it('returns 429 when rate limit exceeded', async () => {
    const store = createMemoryStore();
    const storage = new MemoryStorageAdapter();
    const server = createRecFnServer({
      store,
      storage,
      logger: createNoopLogger(),
      rateLimit: true,
      validateApiKey: () => ({ namespace: 'ns', apiKey: 'sk' }),
    });

    const req = (method: string, path: string) =>
      new Request(`http://localhost${path}`, {
        method,
        headers: { Authorization: 'Bearer sk' },
      });

    const requests = Array.from({ length: 105 }, () =>
      server.router.handle(req('GET', '/api/v1/bots')),
    );

    const responses = await Promise.all(requests);
    const statuses = responses.map((r) => r.status);
    const rateLimited = statuses.filter((s) => s === 429);
    expect(rateLimited.length).toBeGreaterThan(0);
  });

  it('does not rate limit when rateLimit: false', async () => {
    const store = createMemoryStore();
    const storage = new MemoryStorageAdapter();
    const server = createRecFnServer({
      store,
      storage,
      logger: createNoopLogger(),
      rateLimit: false,
      validateApiKey: () => ({ namespace: 'ns', apiKey: 'sk' }),
    });

    const req = (method: string, path: string) =>
      new Request(`http://localhost${path}`, {
        method,
        headers: { Authorization: 'Bearer sk' },
      });

    const requests = Array.from({ length: 105 }, () =>
      server.router.handle(req('GET', '/api/v1/bots')),
    );

    const responses = await Promise.all(requests);
    const rateLimited = responses.filter((r) => r.status === 429);
    expect(rateLimited.length).toBe(0);
  });
});

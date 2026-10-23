import { describe, it, expect, beforeEach } from 'vitest';
import { createTestServer, req, json } from './helpers.js';
import type { RecFnServer } from '../src/index.js';

describe('API authentication (TV-API-003, TV-SEC-001)', () => {
  let server: RecFnServer;

  beforeEach(() => {
    ({ server } = createTestServer());
  });

  it('returns 401 for missing Authorization header', async () => {
    const res = await server.router.handle(
      req('GET', '/api/v1/bots', { apiKey: '' }),
    );
    expect(res.status).toBe(401);
    const body = await json(res);
    expect(body.ok).toBe(false);
    expect((body.error as Record<string, unknown>).code).toBe('UNAUTHORIZED');
    expect((body.error as Record<string, unknown>).message).toContain(
      'Missing',
    );
  });

  it('returns 401 for invalid API key', async () => {
    const res = await server.router.handle(
      req('GET', '/api/v1/bots', { apiKey: 'sk-invalid-key' }),
    );
    expect(res.status).toBe(401);
    const body = await json(res);
    expect(body.ok).toBe(false);
    expect((body.error as Record<string, unknown>).code).toBe('UNAUTHORIZED');
    expect((body.error as Record<string, unknown>).message).toContain(
      'Invalid',
    );
  });

  it('succeeds with valid API key', async () => {
    const res = await server.router.handle(
      req('GET', '/api/v1/bots', { apiKey: 'sk-valid-key' }),
    );
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.ok).toBe(true);
  });

  it('returns 401 for POST without auth', async () => {
    const res = await server.router.handle(
      req('POST', '/api/v1/bots', {
        body: { meetingUrl: 'https://zoom.us/j/123' },
        apiKey: '',
      }),
    );
    expect(res.status).toBe(401);
  });

  it('authenticates POST with valid key', async () => {
    const res = await server.router.handle(
      req('POST', '/api/v1/bots', {
        body: { meetingUrl: 'https://zoom.us/j/123' },
        apiKey: 'sk-valid-key',
      }),
    );
    expect(res.status).toBe(201);
  });
});

import { describe, it, expect, beforeEach } from 'vitest';
import { createTestServer, req, json } from './helpers.js';
import type { RecFnServer } from '../src/index.js';

describe('Namespace isolation (TV-API-005, TV-SEC-002)', () => {
  let server: RecFnServer;

  beforeEach(() => {
    ({ server } = createTestServer());
  });

  it('bots created by namespace A are not visible to namespace B', async () => {
    // Create a bot as namespace A
    const createRes = await server.router.handle(
      req('POST', '/api/v1/bots', {
        body: { meetingUrl: 'https://zoom.us/j/123' },
        apiKey: 'sk-ns-a',
      }),
    );
    const botId = (
      (await json(createRes)).data as Record<string, unknown>
    ).id as string;

    // Try to access from namespace B → 404 (not 403)
    const res = await server.router.handle(
      req('GET', `/api/v1/bots/${botId}`, { apiKey: 'sk-ns-b' }),
    );
    expect(res.status).toBe(404);
    const body = await json(res);
    expect(body.ok).toBe(false);
    expect((body.error as Record<string, unknown>).code).toBe('BOT_NOT_FOUND');
  });

  it('listing bots only shows bots from own namespace', async () => {
    // Create bots in different namespaces
    await server.router.handle(
      req('POST', '/api/v1/bots', {
        body: { meetingUrl: 'https://zoom.us/j/111' },
        apiKey: 'sk-ns-a',
      }),
    );
    await server.router.handle(
      req('POST', '/api/v1/bots', {
        body: { meetingUrl: 'https://zoom.us/j/222' },
        apiKey: 'sk-ns-a',
      }),
    );
    await server.router.handle(
      req('POST', '/api/v1/bots', {
        body: { meetingUrl: 'https://zoom.us/j/333' },
        apiKey: 'sk-ns-b',
      }),
    );

    // Namespace A sees 2 bots
    const resA = await server.router.handle(
      req('GET', '/api/v1/bots', { apiKey: 'sk-ns-a' }),
    );
    const bodyA = await json(resA);
    expect(
      (bodyA.data as Record<string, unknown>).bots as unknown[],
    ).toHaveLength(2);

    // Namespace B sees 1 bot
    const resB = await server.router.handle(
      req('GET', '/api/v1/bots', { apiKey: 'sk-ns-b' }),
    );
    const bodyB = await json(resB);
    expect(
      (bodyB.data as Record<string, unknown>).bots as unknown[],
    ).toHaveLength(1);
  });

  it('cannot leave a bot from another namespace', async () => {
    const createRes = await server.router.handle(
      req('POST', '/api/v1/bots', {
        body: { meetingUrl: 'https://zoom.us/j/123' },
        apiKey: 'sk-ns-a',
      }),
    );
    const botId = (
      (await json(createRes)).data as Record<string, unknown>
    ).id as string;

    const res = await server.router.handle(
      req('POST', `/api/v1/bots/${botId}/leave`, { apiKey: 'sk-ns-b' }),
    );
    expect(res.status).toBe(404);
  });

  it('cannot delete a bot from another namespace', async () => {
    const createRes = await server.router.handle(
      req('POST', '/api/v1/bots', {
        body: { meetingUrl: 'https://zoom.us/j/123' },
        apiKey: 'sk-ns-a',
      }),
    );
    const botId = (
      (await json(createRes)).data as Record<string, unknown>
    ).id as string;

    const res = await server.router.handle(
      req('DELETE', `/api/v1/bots/${botId}`, { apiKey: 'sk-ns-b' }),
    );
    expect(res.status).toBe(404);
  });

  it('participants, chat, metadata return 404 for cross-namespace bot', async () => {
    const createRes = await server.router.handle(
      req('POST', '/api/v1/bots', {
        body: { meetingUrl: 'https://zoom.us/j/123' },
        apiKey: 'sk-ns-a',
      }),
    );
    const botId = (
      (await json(createRes)).data as Record<string, unknown>
    ).id as string;

    for (const path of [
      `/api/v1/bots/${botId}/participants`,
      `/api/v1/bots/${botId}/chat`,
      `/api/v1/bots/${botId}/metadata`,
      `/api/v1/bots/${botId}/recordings`,
    ]) {
      const res = await server.router.handle(
        req('GET', path, { apiKey: 'sk-ns-b' }),
      );
      expect(res.status).toBe(404);
    }
  });
});

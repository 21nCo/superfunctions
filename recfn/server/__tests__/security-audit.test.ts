import { describe, it, expect } from 'vitest';
import {
  createTestServer,
  req,
  json,
} from './helpers.js';

describe('security audit (TV-SEC-001–004)', () => {
  it('API responses do not contain raw storageRef without downloadUrl (TV-SEC-003)', async () => {
    const { server, store } = createTestServer();
    const createRes = await server.router.handle(
      req('POST', '/api/v1/bots', {
        body: { meetingUrl: 'https://zoom.us/j/123' },
      }),
    );
    expect(createRes.status).toBe(201);
    const bot = (await json(createRes)).data;

    const recRes = await server.router.handle(
      req('GET', `/api/v1/bots/${bot.id}/recordings`),
    );
    expect(recRes.status).toBe(200);
    const data = await json(recRes);
    const recordings = (data.data as { recordings: unknown[] }).recordings ?? [];
    for (const rec of recordings) {
      const r = rec as Record<string, unknown>;
      if (r.storageRef && !r.downloadUrl) {
        expect(r.storageRef).not.toContain('sk-');
        expect(r.storageRef).not.toMatch(/^[a-zA-Z0-9_-]{20,}$/);
      }
    }
  });

  it('webhook create does not return secret in response', async () => {
    const { server } = createTestServer();
    const res = await server.router.handle(
      req('POST', '/api/v1/webhooks', {
        body: {
          url: 'https://example.com/webhook',
          events: ['recording.ready'],
          secret: 'my-secret-key',
        },
      }),
    );
    expect(res.status).toBe(201);
    const body = await json(res);
    const webhook = body.data as Record<string, unknown>;
    expect(webhook.secret).toBeUndefined();
  });

  it('list webhooks does not include secret', async () => {
    const { server } = createTestServer();
    await server.router.handle(
      req('POST', '/api/v1/webhooks', {
        body: {
          url: 'https://example.com/wh',
          events: ['recording.ready'],
          secret: 'hidden-secret',
        },
      }),
    );
    const res = await server.router.handle(req('GET', '/api/v1/webhooks'));
    expect(res.status).toBe(200);
    const body = await json(res);
    const webhooks = (body.data as { webhooks: Record<string, unknown>[] }).webhooks ?? [];
    for (const wh of webhooks) {
      expect(wh.secret).toBeUndefined();
    }
  });
});

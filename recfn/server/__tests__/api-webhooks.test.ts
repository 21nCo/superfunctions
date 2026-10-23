import { describe, it, expect, beforeEach } from 'vitest';
import { createTestServer, req, json } from './helpers.js';
import type { RecFnServer } from '../src/index.js';
import type { RecFnStore } from '../src/store/types.js';

describe('Webhook API (TV-WH-001)', () => {
  let server: RecFnServer;
  let store: RecFnStore;

  beforeEach(() => {
    ({ server, store } = createTestServer());
  });

  it('POST /webhooks creates webhook (TV-WH-001)', async () => {
    const res = await server.router.handle(
      req('POST', '/api/v1/webhooks', {
        body: {
          url: 'https://my-app.com/hooks/recfn',
          events: ['bot.joined', 'recording.ready', 'transcript.ready'],
          secret: 'whsec_myverysecretkey',
        },
      }),
    );

    expect(res.status).toBe(201);
    const body = await json(res);
    expect(body.ok).toBe(true);
    const data = body.data as { id: string; url: string; events: string[] };
    expect(data.id).toMatch(/^wh_/);
    expect(data.url).toBe('https://my-app.com/hooks/recfn');
    expect(data.events).toEqual(['bot.joined', 'recording.ready', 'transcript.ready']);
    expect(data).not.toHaveProperty('secret');
  });

  it('GET /webhooks lists webhooks without secret', async () => {
    await store.createWebhook(
      {
        url: 'https://example.com/hook',
        events: ['bot.joined'],
        secret: 'whsec_secret',
      },
      'ns_test',
    );

    const res = await server.router.handle(req('GET', '/api/v1/webhooks'));
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.ok).toBe(true);
    const webhooks = (body.data as { webhooks: Array<{ url: string }> }).webhooks;
    expect(webhooks.length).toBe(1);
    expect(webhooks[0].url).toBe('https://example.com/hook');
    expect(webhooks[0]).not.toHaveProperty('secret');
  });

  it('DELETE /webhooks/:webhookId deletes webhook', async () => {
    const wh = await store.createWebhook(
      { url: 'https://example.com/hook', events: ['bot.left'] },
      'ns_test',
    );

    const res = await server.router.handle(
      req('DELETE', `/api/v1/webhooks/${wh.id}`),
    );
    expect(res.status).toBe(200);
    const body = await json(res);
    expect((body.data as { deleted: boolean }).deleted).toBe(true);

    const getRes = await server.router.handle(req('GET', '/api/v1/webhooks'));
    const listBody = await json(getRes);
    expect((listBody.data as { webhooks: unknown[] }).webhooks).toHaveLength(0);
  });

  it('returns 404 for non-existent webhook on DELETE', async () => {
    const res = await server.router.handle(
      req('DELETE', '/api/v1/webhooks/wh_nonexistent'),
    );
    expect(res.status).toBe(404);
    const body = await json(res);
    expect((body.error as { code: string }).code).toBe('WEBHOOK_NOT_FOUND');
  });

  it('returns 400 for invalid url', async () => {
    const res = await server.router.handle(
      req('POST', '/api/v1/webhooks', {
        body: {
          url: 'not-a-url',
          events: ['bot.joined'],
        },
      }),
    );
    expect(res.status).toBe(400);
  });

  it('returns 400 for invalid events', async () => {
    const res = await server.router.handle(
      req('POST', '/api/v1/webhooks', {
        body: {
          url: 'https://example.com/hook',
          events: ['invalid.event'],
        },
      }),
    );
    expect(res.status).toBe(400);
  });

  it('enforces namespace isolation', async () => {
    const wh = await store.createWebhook(
      { url: 'https://example.com/hook', events: ['bot.joined'] },
      'ns_test',
    );

    const res = await server.router.handle(
      req('DELETE', `/api/v1/webhooks/${wh.id}`, { apiKey: 'sk-ns-a' }),
    );
    expect(res.status).toBe(404);
  });
});

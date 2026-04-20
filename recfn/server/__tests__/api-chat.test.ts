import { beforeEach, describe, expect, it } from 'vitest';
import { createTestServer, json, req } from './helpers.js';
import type { RecFnServer } from '../src/index.js';

describe('Chat API routes', () => {
  let server: RecFnServer;
  let store: ReturnType<typeof createTestServer>['store'];

  beforeEach(() => {
    ({ server, store } = createTestServer());
  });

  it('returns persisted chat messages for a bot (TV-DATA-001)', async () => {
    const createRes = await server.router.handle(
      req('POST', '/api/v1/bots', {
        body: { meetingUrl: 'https://zoom.us/j/123' },
      }),
    );
    const botId = ((await json(createRes)).data as { id: string }).id;

    await store.addChatMessage(
      botId,
      {
        participantId: 'par_1',
        text: 'hello world',
        timestamp: '2026-04-01T10:00:00.000Z',
      },
      'ns_test',
    );
    await store.addChatMessage(
      botId,
      {
        participantId: 'par_2',
        text: 'second message',
        timestamp: '2026-04-01T10:01:00.000Z',
      },
      'ns_test',
    );

    const res = await server.router.handle(
      req('GET', `/api/v1/bots/${botId}/chat`),
    );

    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.ok).toBe(true);
    expect(body.data).toEqual({
      messages: [
        {
          participantId: 'par_1',
          text: 'hello world',
          timestamp: '2026-04-01T10:00:00.000Z',
        },
        {
          participantId: 'par_2',
          text: 'second message',
          timestamp: '2026-04-01T10:01:00.000Z',
        },
      ],
    });
  });

  it('returns 404 for a bot in another namespace', async () => {
    const createRes = await server.router.handle(
      req('POST', '/api/v1/bots', {
        body: { meetingUrl: 'https://zoom.us/j/123' },
        apiKey: 'sk-ns-a',
      }),
    );
    const botId = ((await json(createRes)).data as { id: string }).id;

    const res = await server.router.handle(
      req('GET', `/api/v1/bots/${botId}/chat`, { apiKey: 'sk-ns-b' }),
    );

    expect(res.status).toBe(404);
  });
});

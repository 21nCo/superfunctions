import { beforeEach, describe, expect, it } from 'vitest';
import { createTestServer, json, req } from './helpers.js';
import type { RecFnServer } from '../src/index.js';

describe('Metadata API routes', () => {
  let server: RecFnServer;
  let store: ReturnType<typeof createTestServer>['store'];

  beforeEach(() => {
    ({ server, store } = createTestServer());
  });

  it('returns persisted metadata for a bot (TV-DATA-001)', async () => {
    const createRes = await server.router.handle(
      req('POST', '/api/v1/bots', {
        body: { meetingUrl: 'https://zoom.us/j/123' },
      }),
    );
    const botId = ((await json(createRes)).data as { id: string }).id;

    await store.upsertMetadata(
      botId,
      {
        id: 'meta_1',
        botId: 'wrong_bot_id',
        title: 'Planning',
        platform: 'zoom',
        startTime: '2026-04-01T10:00:00.000Z',
        endTime: '2026-04-01T10:45:00.000Z',
        chatMessages: [
          {
            participantId: 'par_1',
            text: 'notes',
            timestamp: '2026-04-01T10:02:00.000Z',
          },
        ],
      },
      'ns_test',
    );

    const res = await server.router.handle(
      req('GET', `/api/v1/bots/${botId}/metadata`),
    );

    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.ok).toBe(true);
    expect(body.data).toEqual({
      id: 'meta_1',
      botId,
      title: 'Planning',
      platform: 'zoom',
      startTime: '2026-04-01T10:00:00.000Z',
      endTime: '2026-04-01T10:45:00.000Z',
      chatMessages: [
        {
          participantId: 'par_1',
          text: 'notes',
          timestamp: '2026-04-01T10:02:00.000Z',
        },
      ],
    });
  });

  it('returns placeholder metadata when none is stored', async () => {
    const createRes = await server.router.handle(
      req('POST', '/api/v1/bots', {
        body: { meetingUrl: 'https://zoom.us/j/123' },
      }),
    );
    const botId = ((await json(createRes)).data as { id: string }).id;

    const res = await server.router.handle(
      req('GET', `/api/v1/bots/${botId}/metadata`),
    );

    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.ok).toBe(true);
    expect(body.data).toEqual({
      id: botId,
      botId,
      platform: 'zoom',
      chatMessages: [],
    });
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RecFn } from '../src/index.js';

describe('RecFn client (TV-SDK-001, TV-SDK-003)', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
  });

  it('creates bot with valid meeting URL (TV-SDK-001)', async () => {
    const bot = {
      id: 'bot_abc123',
      namespace: 'ns_test',
      meetingUrl: 'https://zoom.us/j/123',
      platform: 'zoom',
      status: 'creating',
      config: { displayName: 'RecFn Bot', joinTimeout: 30000 },
      createdAt: '2026-02-28T14:00:00Z',
      updatedAt: '2026-02-28T14:00:00Z',
    };

    fetchMock.mockResolvedValue({
      ok: true,
      status: 201,
      headers: new Headers({ 'Content-Type': 'application/json' }),
      json: () => Promise.resolve({ ok: true, data: bot }),
    });

    const client = new RecFn({
      baseUrl: 'http://localhost:3000',
      apiKey: 'sk-test',
      fetch: fetchMock,
    });

    const result = await client.bots.create({
      meetingUrl: 'https://zoom.us/j/123',
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.id).toBe('bot_abc123');
      expect(result.data.status).toBe('creating');
    }

    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:3000/api/v1/bots',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer sk-test',
          'Content-Type': 'application/json',
        }),
      }),
    );
  });

  it('returns error envelope for API errors (TV-SDK-003)', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 404,
      headers: new Headers({ 'Content-Type': 'application/json' }),
      json: () =>
        Promise.resolve({
          ok: false,
          error: {
            code: 'BOT_NOT_FOUND',
            message: 'Bot not found.',
            details: {},
          },
        }),
    });

    const client = new RecFn({
      baseUrl: 'http://localhost:3000',
      apiKey: 'sk-test',
      fetch: fetchMock,
    });

    const result = await client.bots.get('nonexistent');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('BOT_NOT_FOUND');
      expect(result.error.message).toBe('Bot not found.');
    }
  });

  it('lists bots with pagination', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'Content-Type': 'application/json' }),
      json: () =>
        Promise.resolve({
          ok: true,
          data: {
            bots: [],
            nextCursor: null,
          },
        }),
    });

    const client = new RecFn({
      baseUrl: 'http://localhost:3000',
      apiKey: 'sk-test',
      fetch: fetchMock,
    });

    const result = await client.bots.list({ limit: 10, status: 'recording' });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.bots).toEqual([]);
    }
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('limit=10'),
      expect.any(Object),
    );
  });

  it('gets participants', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'Content-Type': 'application/json' }),
      json: () =>
        Promise.resolve({
          ok: true,
          data: { participants: [] },
        }),
    });

    const client = new RecFn({
      baseUrl: 'http://localhost:3000',
      apiKey: 'sk-test',
      fetch: fetchMock,
    });

    const result = await client.participants.list('bot_123');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.participants).toEqual([]);
    }
  });

  it('gets chat messages', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'Content-Type': 'application/json' }),
      json: () =>
        Promise.resolve({
          ok: true,
          data: { messages: [] },
        }),
    });

    const client = new RecFn({
      baseUrl: 'http://localhost:3000',
      apiKey: 'sk-test',
      fetch: fetchMock,
    });

    const result = await client.chat.list('bot_123');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.messages).toEqual([]);
    }
  });

  it('creates webhook', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 201,
      headers: new Headers({ 'Content-Type': 'application/json' }),
      json: () =>
        Promise.resolve({
          ok: true,
          data: {
            id: 'wh_123',
            url: 'https://example.com/hook',
            events: ['bot.joined'],
            createdAt: '2026-02-28T14:00:00Z',
          },
        }),
    });

    const client = new RecFn({
      baseUrl: 'http://localhost:3000',
      apiKey: 'sk-test',
      fetch: fetchMock,
    });

    const result = await client.webhooks.create({
      url: 'https://example.com/hook',
      events: ['bot.joined'],
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.id).toBe('wh_123');
    }
  });
});

it('preserves blocked deletion data from HTTP 202 instead of reporting completed deletion', async () => {
  const data = { botId: 'bot', deleted: false, state: 'blocked', producerIds: ['producer'], reason: 'External operation remains unresolved.' };
  const client = new RecFn({ baseUrl: 'http://localhost', apiKey: 'key', fetch: vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true, data }), { status: 202, headers: { 'Content-Type': 'application/json' } })) });
  const result = await client.bots.delete('bot');
  expect(result).toEqual({ ok: true, data });
  if (result.ok) expect(result.data.state).toBe('blocked');
});

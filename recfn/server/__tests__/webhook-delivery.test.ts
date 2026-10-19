import { createHmac } from 'node:crypto';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  createMemoryStore,
  createBotWorker,
  MemoryQueueAdapter,
  MemoryLogger,
  QUEUE_NAMES,
  transitionBot,
} from '../src/index.js';
import type { RecFnStore } from '../src/store/types.js';
import type { PlatformAdapter, Participant } from '@recfn/core';

const { transport } = vi.hoisted(() => ({ transport: vi.fn() }));
vi.mock('undici', async () => ({
  ...await vi.importActual<typeof import('undici')>('undici'), fetch: transport,
}));
const resolvePublicHostname = vi.fn(async () => ['93.184.216.34']);

function createMockPlatformAdapter(): PlatformAdapter {
  const participantJoinCbs: ((p: Participant) => void)[] = [];
  const participantLeaveCbs: ((id: string) => void)[] = [];

  return {
    platform: 'zoom',
    async join() {},
    async leave() {},
    getAudioStream: () => new ReadableStream(),
    async getParticipants() {
      return [];
    },
    onParticipantJoin(cb) {
      participantJoinCbs.push(cb);
    },
    onParticipantLeave(cb) {
      participantLeaveCbs.push(cb);
    },
    async getChatMessages() {
      return [];
    },
    onChatMessage() {},
    async sendChatMessage() {},
    async getMetadata() {
      return {
        id: 'meta_1',
        botId: '',
        platform: 'zoom',
        chatMessages: [],
      };
    },
    isConnected: () => true,
  };
}

describe('Webhook delivery (TV-WH-002, TV-WH-003, TV-WH-005)', () => {
  let store: RecFnStore;
  let queue: MemoryQueueAdapter;
  let logger: MemoryLogger;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    store = createMemoryStore();
    queue = new MemoryQueueAdapter();
    logger = new MemoryLogger();
    transport.mockReset().mockResolvedValue({ ok: true, status: 200 });
    resolvePublicHostname.mockClear();
    fetchMock = transport;
  });

  it('delivers bot.joined event to configured webhook (TV-WH-002)', async () => {
    const bot = await store.createBot({
      meetingUrl: 'https://zoom.us/j/123',
      platform: 'zoom',
      config: {
        displayName: 'Bot',
        joinTimeout: 30000,
        autoLeaveOnEmpty: true,
        autoLeaveEmptyTimeout: 30000,
        consentMessage: 'Rec',
        enableRealTimeTranscript: false,
        asrProvider: 'whisper',
        recordingFormat: 'mp4',
        language: 'en-US',
      },
      namespace: 'ns_test',
    });

    await store.createWebhook(
      {
        url: 'https://my-app.com/hooks/recfn',
        events: ['bot.joined'],
        secret: 'whsec_test',
      },
      'ns_test',
    );

    const webhookDeliverer = {
      deliver: (ns: string, ev: string, payload: Record<string, unknown>) =>
        import('../src/integrations/plugfn.js').then(({ deliverWebhookEvent }) =>
          deliverWebhookEvent(ns, ev, payload, { store, resolveHostname: resolvePublicHostname }),
        ),
    };

    await transitionBot(
      { store, logger, webhookDeliverer },
      bot.id,
      'ns_test',
      'joining',
    );
    await transitionBot(
      { store, logger, webhookDeliverer },
      bot.id,
      'ns_test',
      'joined',
    );

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const call = fetchMock.mock.calls[0];
    expect(call[0]).toBe('https://my-app.com/hooks/recfn');
    expect(call[1].method).toBe('POST');
    const body = JSON.parse(call[1].body);
    expect(body.event).toBe('bot.joined');
    expect(body.eventId).toBeDefined();
    expect(body.timestamp).toBeDefined();
    expect(body.data.botId).toBe(bot.id);
    expect(body.data.meetingUrl).toBe('https://zoom.us/j/123');
    expect(body.data.platform).toBe('zoom');
    expect(call[1].headers['X-RecFn-Signature']).toBe(createHmac('sha256', 'whsec_test').update(call[1].body).digest('hex'));
    expect(resolvePublicHostname).toHaveBeenCalledWith('my-app.com', expect.any(AbortSignal));
    expect(call[1].dispatcher).toBeDefined();
    expect(call[1].redirect).toBe('manual');
  });

  it('does not include X-RecFn-Signature when webhook has no secret (TV-WH-004 negative)', async () => {
    const bot = await store.createBot({
      meetingUrl: 'https://zoom.us/j/123',
      platform: 'zoom',
      config: {
        displayName: 'Bot',
        joinTimeout: 30000,
        autoLeaveOnEmpty: true,
        autoLeaveEmptyTimeout: 30000,
        consentMessage: 'Rec',
        enableRealTimeTranscript: false,
        asrProvider: 'whisper',
        recordingFormat: 'mp4',
        language: 'en-US',
      },
      namespace: 'ns_test',
    });

    await store.createWebhook(
      {
        url: 'https://my-app.com/hooks/recfn',
        events: ['bot.joined'],
      },
      'ns_test',
    );

    const webhookDeliverer = {
      deliver: (ns: string, ev: string, payload: Record<string, unknown>) =>
        import('../src/integrations/plugfn.js').then(({ deliverWebhookEvent }) =>
          deliverWebhookEvent(ns, ev, payload, { store, resolveHostname: resolvePublicHostname }),
        ),
    };

    await transitionBot(
      { store, logger, webhookDeliverer },
      bot.id,
      'ns_test',
      'joining',
    );
    await transitionBot(
      { store, logger, webhookDeliverer },
      bot.id,
      'ns_test',
      'joined',
    );

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const call = fetchMock.mock.calls[0];
    expect(call[1].headers['X-RecFn-Signature']).toBeUndefined();
  });

  it('retries on failure (TV-WH-005)', async () => {
    const bot = await store.createBot({
      meetingUrl: 'https://zoom.us/j/123',
      platform: 'zoom',
      config: {
        displayName: 'Bot',
        joinTimeout: 30000,
        autoLeaveOnEmpty: true,
        autoLeaveEmptyTimeout: 30000,
        consentMessage: 'Rec',
        enableRealTimeTranscript: false,
        asrProvider: 'whisper',
        recordingFormat: 'mp4',
        language: 'en-US',
      },
      namespace: 'ns_test',
    });

    await store.createWebhook(
      {
        url: 'https://my-app.com/hooks/recfn',
        events: ['bot.joined'],
      },
      'ns_test',
    );

    let attempt = 0;
    const failingFetch = transport.mockImplementation(() => {
      attempt++;
      if (attempt < 2) {
        return Promise.resolve({ ok: false, status: 500 });
      }
      return Promise.resolve({ ok: true });
    });

    const webhookDeliverer = {
      deliver: (ns: string, ev: string, payload: Record<string, unknown>) =>
        import('../src/integrations/plugfn.js').then(({ deliverWebhookEvent }) =>
          deliverWebhookEvent(ns, ev, payload, {
            store,
            resolveHostname: resolvePublicHostname,
            initialDelayMs: 0,
            maxRetries: 3,
          }),
        ),
    };

    await transitionBot(
      { store, logger, webhookDeliverer },
      bot.id,
      'ns_test',
      'joining',
    );
    await transitionBot(
      { store, logger, webhookDeliverer },
      bot.id,
      'ns_test',
      'joined',
    );

    await vi.waitFor(() => expect(failingFetch).toHaveBeenCalledTimes(2));
    expect(failingFetch).toHaveBeenCalledTimes(2);
  });

  it('eventId is unique per delivery', async () => {
    const bot = await store.createBot({
      meetingUrl: 'https://zoom.us/j/123',
      platform: 'zoom',
      config: {
        displayName: 'Bot',
        joinTimeout: 30000,
        autoLeaveOnEmpty: true,
        autoLeaveEmptyTimeout: 30000,
        consentMessage: 'Rec',
        enableRealTimeTranscript: false,
        asrProvider: 'whisper',
        recordingFormat: 'mp4',
        language: 'en-US',
      },
      namespace: 'ns_test',
    });

    await store.createWebhook(
      {
        url: 'https://my-app.com/hook1',
        events: ['bot.joined', 'bot.left'],
      },
      'ns_test',
    );
    await store.createWebhook(
      {
        url: 'https://my-app.com/hook2',
        events: ['bot.joined'],
      },
      'ns_test',
    );

    const webhookDeliverer = {
      deliver: (ns: string, ev: string, payload: Record<string, unknown>) =>
        import('../src/integrations/plugfn.js').then(({ deliverWebhookEvent }) =>
          deliverWebhookEvent(ns, ev, payload, { store, resolveHostname: resolvePublicHostname }),
        ),
    };

    await transitionBot(
      { store, logger, webhookDeliverer },
      bot.id,
      'ns_test',
      'joining',
    );
    await transitionBot(
      { store, logger, webhookDeliverer },
      bot.id,
      'ns_test',
      'joined',
    );
    await transitionBot(
      { store, logger, webhookDeliverer },
      bot.id,
      'ns_test',
      'recording',
    );
    await transitionBot(
      { store, logger, webhookDeliverer },
      bot.id,
      'ns_test',
      'leaving',
    );
    await transitionBot(
      { store, logger, webhookDeliverer },
      bot.id,
      'ns_test',
      'left',
    );

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    const eventIds = fetchMock.mock.calls.map((c) => JSON.parse(c[1].body).eventId);
    expect(eventIds.length).toBe(3);
    expect(eventIds.every((id) => typeof id === 'string' && id.startsWith('evt_'))).toBe(true);
    const uniqueIds = new Set(eventIds);
    expect(uniqueIds.size).toBe(2);
  });
});

it('rejects literal and DNS-resolved private targets before calling the transport', async () => {
  const { deliverWebhook } = await import('../src/webhooks/deliver.js');
  const payload = { event: 'bot.joined' as const, eventId: 'evt_security', timestamp: new Date().toISOString(), data: {} };
  transport.mockClear();
  for (const url of ['http://127.0.0.1/hook', 'http://[::1]/hook', 'https://private.example/hook']) {
    await expect(deliverWebhook({ url }, payload, { resolveHostname: async () => ['93.184.216.34', '10.0.0.1'] })).rejects.toThrow(/non-public/);
  }
  expect(transport).not.toHaveBeenCalled();
});

it('passes delivery policy through the shared transport', async () => {
  const { deliverWebhook } = await import('../src/webhooks/deliver.js');
  transport.mockReset().mockResolvedValue({ ok: true, status: 200 });
  await expect(deliverWebhook({ url: 'https://my-app.com/hook' }, { event: 'bot.joined', eventId: 'evt_policy', timestamp: new Date().toISOString(), data: {} }, { resolveHostname: resolvePublicHostname, maxRetries: 1 })).resolves.toEqual({ ok: true, attempt: 1 });
});


it('bounds DNS validation and aborts the resolver before transport', async () => {
  const { deliverWebhook } = await import('../src/webhooks/deliver.js');
  transport.mockClear();
  let resolverSignal: AbortSignal | undefined;
  await expect(deliverWebhook({ url: 'https://slow.example/hook' }, {
    event: 'bot.joined', eventId: 'evt_timeout', timestamp: new Date().toISOString(), data: {},
  }, {
    perAttemptTimeoutMs: 10,
    resolveHostname: async (_hostname, signal) => {
      resolverSignal = signal;
      return new Promise<readonly string[]>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    },
  })).rejects.toThrow(/timed out/);
  expect(resolverSignal?.aborted).toBe(true);
  expect(transport).not.toHaveBeenCalled();
});

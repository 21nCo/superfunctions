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
import type { PlatformAdapter, Participant } from 'recfn';

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
    fetchMock = vi.fn().mockResolvedValue({ ok: true });
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
          deliverWebhookEvent(ns, ev, payload, { store, fetch: fetchMock }),
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

    await new Promise((r) => setTimeout(r, 20));
    expect(fetchMock).toHaveBeenCalled();
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
    expect(call[1].headers['X-RecFn-Signature']).toBeDefined();
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
          deliverWebhookEvent(ns, ev, payload, { store, fetch: fetchMock }),
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

    await new Promise((r) => setTimeout(r, 20));
    expect(fetchMock).toHaveBeenCalled();
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
    const failingFetch = vi.fn().mockImplementation(() => {
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
            fetch: failingFetch,
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

    await new Promise((r) => setTimeout(r, 2500));
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
          deliverWebhookEvent(ns, ev, payload, { store, fetch: fetchMock }),
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

    await new Promise((r) => setTimeout(r, 20));
    const eventIds = fetchMock.mock.calls.map((c) => JSON.parse(c[1].body).eventId);
    expect(eventIds.length).toBe(3);
    expect(eventIds.every((id) => typeof id === 'string' && id.startsWith('evt_'))).toBe(true);
    const uniqueIds = new Set(eventIds);
    expect(uniqueIds.size).toBe(2);
  });
});

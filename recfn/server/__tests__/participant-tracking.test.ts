import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { PlatformAdapter, Participant } from '@recfn/core';
import {
  createMemoryStore,
  createBotWorker,
  createRecFnServer,
  MemoryQueueAdapter,
  MemoryLogger,
  MemoryStorageAdapter,
  QUEUE_NAMES,
} from '../src/index.js';
import type { RecFnStore } from '../src/store/types.js';
import { req, json } from './helpers.js';

const API_KEYS: Record<string, { namespace: string; apiKey: string }> = {
  'sk-valid-key': { namespace: 'ns_test', apiKey: 'sk-valid-key' },
};

function createMockPlatformAdapterWithParticipants(): {
  adapter: PlatformAdapter;
  triggerJoin: (p: Participant) => void;
  triggerLeave: (id: string) => void;
} {
  const participantJoinCbs: ((p: Participant) => void)[] = [];
  const participantLeaveCbs: ((id: string) => void)[] = [];
  const participants: Participant[] = [];

  return {
    adapter: {
      platform: 'zoom',
      async join() {},
      async leave() {},
      getAudioStream: () => new ReadableStream(),
      async getParticipants() {
        return participants;
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
    },
    triggerJoin(p: Participant) {
      participants.push(p);
      participantJoinCbs.forEach((cb) => cb(p));
    },
    triggerLeave(id: string) {
      const idx = participants.findIndex((x) => x.id === id);
      if (idx >= 0) {
        participants[idx] = { ...participants[idx], leftAt: new Date().toISOString() };
      }
      participantLeaveCbs.forEach((cb) => cb(id));
    },
  };
}

describe('Participant tracking (TV-PAR-002, TV-PAR-003)', () => {
  let store: RecFnStore;
  let queue: MemoryQueueAdapter;
  let logger: MemoryLogger;

  beforeEach(() => {
    store = createMemoryStore();
    queue = new MemoryQueueAdapter();
    logger = new MemoryLogger();
  });

  it('tracks consent status and includes in API responses (TV-PAR-002)', async () => {
    const bot = await store.createBot({
      meetingUrl: 'https://zoom.us/j/123',
      platform: 'zoom',
      config: {
        displayName: 'RecFn Bot',
        joinTimeout: 30000,
        autoLeaveOnEmpty: true,
        autoLeaveEmptyTimeout: 30000,
        consentMessage: 'Recording',
        enableRealTimeTranscript: false,
        asrProvider: 'whisper',
        recordingFormat: 'mp4',
        language: 'en-US',
      },
      namespace: 'ns_test',
    });

    await store.addParticipant(
      bot.id,
      {
        id: 'par_001',
        botId: bot.id,
        name: 'Alice',
        role: 'host',
        joinedAt: '2026-02-28T14:00:00Z',
        consent: 'granted',
      },
      'ns_test',
    );
    await store.addParticipant(
      bot.id,
      {
        id: 'par_002',
        botId: bot.id,
        name: 'Bob',
        role: 'attendee',
        joinedAt: '2026-02-28T14:01:00Z',
        consent: 'unknown',
      },
      'ns_test',
    );

    const server = createRecFnServer({
      store,
      storage: new MemoryStorageAdapter(),
      validateApiKey: (key) => API_KEYS[key] ?? null,
    });

    const res = await server.router.handle(
      req('GET', `/api/v1/bots/${bot.id}/participants`),
    );

    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.ok).toBe(true);
    const participants = (body.data as { participants: Participant[] }).participants;
    expect(participants).toHaveLength(2);

    const alice = participants.find((p: Participant) => p.name === 'Alice');
    const bob = participants.find((p: Participant) => p.name === 'Bob');
    expect(alice?.consent).toBe('granted');
    expect(bob?.consent).toBe('unknown');
  });

  it('fires participant.joined and participant.left webhooks (TV-PAR-003)', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    const originalFetch = globalThis.fetch;
    vi.stubGlobal('fetch', fetchMock);

    const bot = await store.createBot({
      meetingUrl: 'https://zoom.us/j/123',
      platform: 'zoom',
      config: {
        displayName: 'RecFn Bot',
        joinTimeout: 30000,
        autoLeaveOnEmpty: true,
        autoLeaveEmptyTimeout: 30000,
        consentMessage: 'Recording',
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
        events: ['participant.joined', 'participant.left'],
      },
      'ns_test',
    );

    await queue.enqueue(QUEUE_NAMES.BOT_JOIN, {
      type: 'bot.join',
      data: { botId: bot.id, namespace: 'ns_test' },
      createdAt: new Date().toISOString(),
    });

    const { adapter, triggerJoin, triggerLeave } =
      createMockPlatformAdapterWithParticipants();

    const worker = createBotWorker({
      store,
      queue,
      logger,
      platformAdapters: new Map([['zoom', adapter]]),
    });

    await worker.processNext();

    const alice: Participant = {
      id: 'par_alice',
      botId: bot.id,
      name: 'Alice',
      role: 'host',
      joinedAt: new Date().toISOString(),
      consent: 'pending',
    };
    triggerJoin(alice);

    await new Promise((r) => setTimeout(r, 50));

    const joinedCalls = fetchMock.mock.calls.filter(
      (c: [string, { body: string }]) =>
        JSON.parse(c[1].body).event === 'participant.joined',
    );
    expect(joinedCalls.length).toBeGreaterThanOrEqual(1);
    const joinedPayload = JSON.parse(joinedCalls[0][1].body);
    expect(joinedPayload.event).toBe('participant.joined');
    expect(joinedPayload.data.botId).toBe(bot.id);
    expect(joinedPayload.data.participant.id).toBe('par_alice');
    expect(joinedPayload.data.participant.name).toBe('Alice');
    expect(joinedPayload.data.participant.consent).toBe('pending');

    triggerLeave('par_alice');
    await new Promise((r) => setTimeout(r, 50));

    const leftCalls = fetchMock.mock.calls.filter(
      (c: [string, { body: string }]) =>
        JSON.parse(c[1].body).event === 'participant.left',
    );
    expect(leftCalls.length).toBeGreaterThanOrEqual(1);
    const leftPayload = JSON.parse(leftCalls[0][1].body);
    expect(leftPayload.event).toBe('participant.left');
    expect(leftPayload.data.botId).toBe(bot.id);
    expect(leftPayload.data.participantId).toBe('par_alice');

    vi.stubGlobal('fetch', originalFetch);
  });

  it('updates participant leftAt when they leave', async () => {
    const bot = await store.createBot({
      meetingUrl: 'https://zoom.us/j/123',
      platform: 'zoom',
      config: {
        displayName: 'RecFn Bot',
        joinTimeout: 30000,
        autoLeaveOnEmpty: true,
        autoLeaveEmptyTimeout: 30000,
        consentMessage: 'Recording',
        enableRealTimeTranscript: false,
        asrProvider: 'whisper',
        recordingFormat: 'mp4',
        language: 'en-US',
      },
      namespace: 'ns_test',
    });

    await queue.enqueue(QUEUE_NAMES.BOT_JOIN, {
      type: 'bot.join',
      data: { botId: bot.id, namespace: 'ns_test' },
      createdAt: new Date().toISOString(),
    });

    const { adapter, triggerJoin, triggerLeave } =
      createMockPlatformAdapterWithParticipants();

    const worker = createBotWorker({
      store,
      queue,
      logger,
      platformAdapters: new Map([['zoom', adapter]]),
    });

    await worker.processNext();

    const alice: Participant = {
      id: 'par_alice',
      botId: bot.id,
      name: 'Alice',
      role: 'host',
      joinedAt: new Date().toISOString(),
      consent: 'pending',
    };
    triggerJoin(alice);

    await new Promise((r) => setTimeout(r, 20));

    let participants = await store.getParticipants(bot.id, 'ns_test');
    expect(participants).toHaveLength(1);
    expect(participants[0].leftAt).toBeUndefined();

    triggerLeave('par_alice');
    await new Promise((r) => setTimeout(r, 20));

    participants = await store.getParticipants(bot.id, 'ns_test');
    expect(participants).toHaveLength(1);
    expect(participants[0].leftAt).toBeDefined();
  });
});

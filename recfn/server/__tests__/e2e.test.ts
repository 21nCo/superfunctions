import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ZoomAdapter } from '../../platforms/zoom/src/index.js';
import type {
  ZoomAudioFrame,
  ZoomChatMessageInfo,
  ZoomMeetingSdk,
  ZoomMeetingSdkConfig,
  ZoomParticipantInfo,
  ZoomVideoFrame,
} from '../../platforms/zoom/src/meeting-sdk.js';
import {
  createMetricsEmitter,
  createRecFnServer,
  createSearchFnClient,
  createBotWorker,
  MemoryLogger,
  MemoryQueueAdapter,
  MemoryStorageAdapter,
} from '../src/index.js';
import type { RecFnStore } from '../src/store/types.js';
import { createMemoryStore } from '../src/store/memory.js';

type EventMap = {
  'audio-frame': (frame: ZoomAudioFrame) => void;
  'participant-audio-frame': (frame: ZoomAudioFrame) => void;
  'video-frame': (frame: ZoomVideoFrame) => void;
  'participant-joined': (info: ZoomParticipantInfo) => void;
  'participant-left': (info: { participantId: string }) => void;
  'chat-message': (msg: ZoomChatMessageInfo) => void;
  'meeting-ended': () => void;
};

function createMockSdk(): ZoomMeetingSdk & {
  emit<K extends keyof EventMap>(event: K, ...args: Parameters<EventMap[K]>): void;
} {
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>();

  const sdk: ZoomMeetingSdk & {
    emit<K extends keyof EventMap>(event: K, ...args: Parameters<EventMap[K]>): void;
  } = {
    init: vi.fn(async () => {}),
    join: vi.fn(async () => {}),
    leave: vi.fn(async () => {
      sdk.emit('meeting-ended');
    }),
    getMeetingInfo: vi.fn(() => ({
      meetingNumber: '1234567890',
      meetingTopic: 'Quarterly Planning',
      hostName: 'Host User',
    })),
    getParticipants: vi.fn(() => []),
    sendChat: vi.fn(async () => {}),
    startRawAudio: vi.fn(),
    stopRawAudio: vi.fn(),
    startRawVideo: vi.fn(),
    stopRawVideo: vi.fn(),
    isInMeeting: vi.fn(() => true),
    on(event: string, cb: (...args: unknown[]) => void) {
      if (!listeners.has(event)) {
        listeners.set(event, []);
      }
      listeners.get(event)!.push(cb);
    },
    off(event: string, cb: (...args: unknown[]) => void) {
      const callbacks = listeners.get(event);
      if (!callbacks) {
        return;
      }
      const index = callbacks.indexOf(cb);
      if (index >= 0) {
        callbacks.splice(index, 1);
      }
    },
    emit(event: string, ...args: unknown[]) {
      for (const callback of listeners.get(event) ?? []) {
        callback(...args);
      }
    },
  };

  return sdk;
}

const API_KEYS: Record<string, { namespace: string; apiKey: string }> = {
  'sk-valid-key': { namespace: 'ns_e2e', apiKey: 'sk-valid-key' },
};

const SDK_CONFIG: ZoomMeetingSdkConfig = {
  sdkKey: 'sdk-key',
  sdkSecret: 'sdk-secret',
};

describe('End-to-end integration (Zoom production path)', () => {
  let store: RecFnStore;
  let queue: MemoryQueueAdapter;
  let logger: MemoryLogger;

  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    store = createMemoryStore();
    queue = new MemoryQueueAdapter();
    logger = new MemoryLogger();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL) => {
        const target = typeof url === 'string' ? url : url.toString();
        if (target.includes('webhook.example.com')) {
          return new Response('OK', { status: 200 });
        }
        return new Response('Not Found', { status: 404 });
      }),
    );
  });

  afterEach(() => {
    vi.stubGlobal('fetch', originalFetch);
  });

  it('Zoom full flow yields aggregate bot data with recording, metadata, participants, and chat (TV-PLAT-001)', async () => {
    const storage = new MemoryStorageAdapter();
    const searchClient = createSearchFnClient();
    const metrics = createMetricsEmitter();
    const sdk = createMockSdk();
    const zoomAdapter = new ZoomAdapter({ sdk, sdkConfig: SDK_CONFIG });

    const server = createRecFnServer({
      store,
      storage,
      queue,
      logger,
      searchClient,
      metrics,
      rateLimit: false,
      validateApiKey: (key: string) => API_KEYS[key] ?? null,
    });

    const createRes = await server.router.handle(
      new Request('http://localhost/api/v1/bots', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer sk-valid-key',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ meetingUrl: 'https://zoom.us/j/1234567890?pwd=abc123' }),
      }),
    );
    expect(createRes.status).toBe(201);
    const createBody = (await createRes.json()) as { data: { id: string } };
    const botId = createBody.data.id;

    const worker = createBotWorker({
      store,
      queue,
      logger,
      storage,
      platformAdapters: new Map([['zoom', zoomAdapter]]),
      metrics,
    });

    expect(await worker.processNext()).toBe(true);

    sdk.emit('participant-joined', {
      participantId: 'par_1',
      name: 'Alice',
      email: 'alice@example.com',
      isHost: true,
    });
    sdk.emit('chat-message', {
      senderId: 'par_1',
      senderName: 'Alice',
      message: 'Budget review starts now',
      timestamp: Date.now(),
    });
    sdk.emit('audio-frame', {
      buffer: new Uint8Array([1, 2, 3, 4]),
      sampleRate: 48000,
      channels: 1,
    });
    sdk.emit('audio-frame', {
      buffer: new Uint8Array([5, 6, 7, 8]),
      sampleRate: 48000,
      channels: 1,
    });

    await new Promise((resolve) => setTimeout(resolve, 20));

    const leaveRes = await server.router.handle(
      new Request(`http://localhost/api/v1/bots/${botId}/leave`, {
        method: 'POST',
        headers: { Authorization: 'Bearer sk-valid-key' },
      }),
    );
    expect(leaveRes.status).toBe(200);
    expect(await worker.processNext()).toBe(true);

    const aggregateRes = await server.router.handle(
      new Request(`http://localhost/api/v1/bots/${botId}`, {
        headers: { Authorization: 'Bearer sk-valid-key' },
      }),
    );
    expect(aggregateRes.status).toBe(200);
    const aggregate = (await aggregateRes.json()) as {
      ok: true;
      data: {
        id: string;
        status: string;
        participants: Array<{ id: string; botId: string; name: string }>;
        recordings: Array<{ id: string; botId: string; storageRef: string; size: number }>;
        metadata: { botId: string; title?: string; startTime?: string; endTime?: string } | null;
        chatMessages: Array<{ participantId: string; text: string }>;
      };
    };

    expect(aggregate.data.status).toBe('done');
    expect(aggregate.data.participants).toHaveLength(1);
    expect(aggregate.data.participants[0]).toMatchObject({
      id: 'par_1',
      botId,
      name: 'Alice',
    });
    expect(aggregate.data.chatMessages).toHaveLength(1);
    expect(aggregate.data.chatMessages[0]).toMatchObject({
      participantId: 'par_1',
      text: 'Budget review starts now',
    });
    expect(aggregate.data.metadata).not.toBeNull();
    expect(aggregate.data.metadata).toMatchObject({
      botId,
      title: 'Quarterly Planning',
    });
    expect(aggregate.data.metadata?.startTime).toBeDefined();
    expect(aggregate.data.metadata?.endTime).toBeDefined();
    expect(aggregate.data.recordings).toHaveLength(1);
    expect(aggregate.data.recordings[0].botId).toBe(botId);
    expect(aggregate.data.recordings[0].storageRef).toContain(`recordings/ns_e2e/`);
    expect(aggregate.data.recordings[0].size).toBeGreaterThan(0);

    const persistedParticipants = await store.getParticipants(botId, 'ns_e2e');
    const persistedMetadata = await store.getMetadata(botId, 'ns_e2e');
    const persistedChat = await store.getChatMessages(botId, 'ns_e2e');
    const persistedRecordings = await store.getRecordings(botId, 'ns_e2e');

    expect(persistedParticipants[0].botId).toBe(botId);
    expect(persistedMetadata?.botId).toBe(botId);
    expect(persistedChat[0].participantId).toBe('par_1');
    expect(persistedRecordings[0].botId).toBe(botId);
  });
});

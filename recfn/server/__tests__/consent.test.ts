import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { PlatformAdapter, Participant } from '@recfn/core';
import {
  createMemoryStore,
  createBotWorker,
  MemoryQueueAdapter,
  MemoryLogger,
  QUEUE_NAMES,
} from '../src/index.js';
import type { RecFnStore } from '../src/store/types.js';

function createMockPlatformAdapter(opts: {
  sendChatMessageError?: boolean;
  consentMessage?: string;
} = {}): { adapter: PlatformAdapter; sendChatMessage: ReturnType<typeof vi.fn> } {
  const participantJoinCbs: ((p: Participant) => void)[] = [];
  const participantLeaveCbs: ((id: string) => void)[] = [];
  const participants: Participant[] = [];
  const sendChatMessage = vi.fn().mockImplementation(async (msg: string) => {
    if (opts.sendChatMessageError) {
      throw new Error('Chat send failed');
    }
  });

  const adapter: PlatformAdapter = {
    platform: 'zoom',
    async join() {},
    async leave() {},
    getAudioStream: () => new ReadableStream({ start(c) { c.enqueue({ data: new Uint8Array(32000), encoding: 'pcm_s16le', sampleRate: 16000, channels: 1, timestamp: 1000 }); c.close(); } }),
    getVideoStream: () => new ReadableStream({ start(c) { c.enqueue({ data: new Uint8Array(16 * 16 * 3), encoding: 'rgb24', frameRate: 1, width: 16, height: 16, timestamp: 1000 }); c.close(); } }),
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
    sendChatMessage,
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

  return { adapter, sendChatMessage };
}

describe('Consent mechanism (TV-BOT-010, BOT-008, SEC-006)', () => {
  let store: RecFnStore;
  let queue: MemoryQueueAdapter;
  let logger: MemoryLogger;
  let temporaryDirectory: string;

  beforeEach(async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), 'recfn-worker-test-'));
    store = createMemoryStore();
    queue = new MemoryQueueAdapter();
    logger = new MemoryLogger();
  });

  afterEach(async () => {
    vi.useRealTimers();
    await vi.waitFor(async () => expect(await readdir(temporaryDirectory)).toEqual([]), { timeout: 10000 });
    await rm(temporaryDirectory, { recursive: true, force: true });
  });

  it('sends consent message before transitioning to recording (TV-BOT-010)', async () => {
    const bot = await store.createBot({
      meetingUrl: 'https://zoom.us/j/123',
      platform: 'zoom',
      config: {
        displayName: 'RecFn Bot',
        joinTimeout: 30000,
        autoLeaveOnEmpty: true,
        autoLeaveEmptyTimeout: 30000,
        consentMessage: 'Recording in progress',
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

    const { adapter, sendChatMessage } = createMockPlatformAdapter();
    const worker = createBotWorker({
      captureOptions: { temporaryDirectory },
      store,
      queue,
      logger,
      platformAdapters: new Map([['zoom', adapter]]),
    });

    await worker.processNext();

    expect(sendChatMessage).toHaveBeenCalledWith('Recording in progress');
    expect(sendChatMessage).toHaveBeenCalledTimes(1);

    const consentLogs = logger.findByEvent('bot.consent_sent');
    expect(consentLogs.length).toBe(1);
    expect(consentLogs[0].data.message).toBe('Recording in progress');

    const updated = await store.getBot(bot.id, 'ns_test');
    expect(updated!.status).toBe('recording');

    const statusChanges = logger.findByEvent('bot.status_change');
    const joinedIdx = statusChanges.findIndex(
      (e) => e.data.from === 'joining' && e.data.to === 'joined',
    );
    const recordingIdx = statusChanges.findIndex(
      (e) => e.data.from === 'joined' && e.data.to === 'recording',
    );
    expect(joinedIdx).toBeGreaterThanOrEqual(0);
    expect(recordingIdx).toBeGreaterThan(joinedIdx);
  });

  it('uses default consent message when not configured', async () => {
    const bot = await store.createBot({
      meetingUrl: 'https://zoom.us/j/123',
      platform: 'zoom',
      config: {
        displayName: 'RecFn Bot',
        joinTimeout: 30000,
        autoLeaveOnEmpty: true,
        autoLeaveEmptyTimeout: 30000,
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

    const { adapter, sendChatMessage } = createMockPlatformAdapter();
    const worker = createBotWorker({
      captureOptions: { temporaryDirectory },
      store,
      queue,
      logger,
      platformAdapters: new Map([['zoom', adapter]]),
    });

    await worker.processNext();

    expect(sendChatMessage).toHaveBeenCalledWith('This meeting is being recorded');
  });

  it('proceeds to recording when consent message fails (non-fatal, TV-BOT-010 negative)', async () => {
    const bot = await store.createBot({
      meetingUrl: 'https://zoom.us/j/123',
      platform: 'zoom',
      config: {
        displayName: 'RecFn Bot',
        joinTimeout: 30000,
        autoLeaveOnEmpty: true,
        autoLeaveEmptyTimeout: 30000,
        consentMessage: 'Recording in progress',
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

    const { adapter } = createMockPlatformAdapter({ sendChatMessageError: true });
    const worker = createBotWorker({
      captureOptions: { temporaryDirectory },
      store,
      queue,
      logger,
      platformAdapters: new Map([['zoom', adapter]]),
    });

    await worker.processNext();

    const failedLogs = logger.findByEvent('bot.consent_failed');
    expect(failedLogs.length).toBe(1);
    expect(failedLogs[0].data.botId).toBe(bot.id);

    const updated = await store.getBot(bot.id, 'ns_test');
    expect(updated!.status).toBe('recording');
  });
});

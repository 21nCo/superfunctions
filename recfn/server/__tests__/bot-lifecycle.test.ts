import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { PlatformAdapter, Participant } from 'recfn';
import {
  createMemoryStore,
  createBotWorker,
  MemoryQueueAdapter,
  MemoryLogger,
  QUEUE_NAMES,
  transitionBot,
} from '../src/index.js';
import type { RecFnStore } from '../src/store/types.js';
import type { QueueAdapter } from '../src/integrations/flowfn.js';

function createMockPlatformAdapter(
  opts: { joinDelay?: number; joinError?: string } = {},
): PlatformAdapter {
  const participantJoinCbs: ((p: Participant) => void)[] = [];
  const participantLeaveCbs: ((id: string) => void)[] = [];
  const participants: Participant[] = [];

  return {
    platform: 'zoom',
    async join(_url, _config) {
      if (opts.joinDelay) {
        await new Promise((r) => setTimeout(r, opts.joinDelay));
      }
      if (opts.joinError) {
        throw new Error(opts.joinError);
      }
    },
    async leave() {},
    getAudioStream() {
      return new ReadableStream();
    },
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
    isConnected() {
      return true;
    },
  };
}

describe('Bot lifecycle (TV-BOT-003)', () => {
  let store: RecFnStore;
  let queue: MemoryQueueAdapter;
  let logger: MemoryLogger;

  beforeEach(() => {
    store = createMemoryStore();
    queue = new MemoryQueueAdapter();
    logger = new MemoryLogger();
  });

  it('full happy path: creating → joining → joined → recording', async () => {
    const bot = await store.createBot({
      meetingUrl: 'https://zoom.us/j/123',
      platform: 'zoom',
      config: {
        displayName: 'RecFn Bot',
        joinTimeout: 30000,
        autoLeaveOnEmpty: true,
        autoLeaveEmptyTimeout: 30000,
        consentMessage: 'This meeting is being recorded',
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

    const adapter = createMockPlatformAdapter();
    const worker = createBotWorker({
      store,
      queue,
      logger,
      platformAdapters: new Map([['zoom', adapter]]),
    });

    const processed = await worker.processNext();
    expect(processed).toBe(true);

    const updated = await store.getBot(bot.id, 'ns_test');
    expect(updated).not.toBeNull();
    expect(updated!.status).toBe('recording');

    // Verify transitions were logged
    const statusChanges = logger.findByEvent('bot.status_change');
    expect(statusChanges.length).toBe(3); // creating→joining, joining→joined, joined→recording
    expect(statusChanges[0].data.from).toBe('creating');
    expect(statusChanges[0].data.to).toBe('joining');
    expect(statusChanges[1].data.from).toBe('joining');
    expect(statusChanges[1].data.to).toBe('joined');
    expect(statusChanges[2].data.from).toBe('joined');
    expect(statusChanges[2].data.to).toBe('recording');
  });

  it('transitions through leaving → left → done (TV-BOT-003 terminal)', async () => {
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

    const deps = { store, logger };

    await transitionBot(deps, bot.id, 'ns_test', 'joining');
    await transitionBot(deps, bot.id, 'ns_test', 'joined');
    await transitionBot(deps, bot.id, 'ns_test', 'recording');
    await transitionBot(deps, bot.id, 'ns_test', 'leaving');
    await transitionBot(deps, bot.id, 'ns_test', 'left');
    await transitionBot(deps, bot.id, 'ns_test', 'done');

    const final = await store.getBot(bot.id, 'ns_test');
    expect(final!.status).toBe('done');

    // Verify no further transitions possible
    await expect(
      transitionBot(deps, bot.id, 'ns_test', 'creating'),
    ).rejects.toThrow();
  });

  it('rejects backward transitions (TV-BOT-003 negative)', async () => {
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

    const deps = { store, logger };
    await transitionBot(deps, bot.id, 'ns_test', 'joining');
    await transitionBot(deps, bot.id, 'ns_test', 'joined');
    await transitionBot(deps, bot.id, 'ns_test', 'recording');

    await expect(
      transitionBot(deps, bot.id, 'ns_test', 'joined'),
    ).rejects.toThrow('Invalid bot status transition');
  });

  it('logs join latency (TV-OBS-003)', async () => {
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

    const deps = { store, logger };
    await transitionBot(deps, bot.id, 'ns_test', 'joining');
    await transitionBot(deps, bot.id, 'ns_test', 'joined');

    const latencyLogs = logger.findByEvent('bot.join_latency');
    expect(latencyLogs.length).toBe(1);
    expect(latencyLogs[0].data.botId).toBe(bot.id);
    expect(typeof latencyLogs[0].data.latencyMs).toBe('number');
    expect(latencyLogs[0].data.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('logs all lifecycle events (TV-OBS-001)', async () => {
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

    const deps = { store, logger };
    await transitionBot(deps, bot.id, 'ns_test', 'joining');
    await transitionBot(deps, bot.id, 'ns_test', 'joined');
    await transitionBot(deps, bot.id, 'ns_test', 'recording');
    await transitionBot(deps, bot.id, 'ns_test', 'leaving');
    await transitionBot(deps, bot.id, 'ns_test', 'left');
    await transitionBot(deps, bot.id, 'ns_test', 'done');

    const statusChanges = logger.findByEvent('bot.status_change');
    expect(statusChanges.length).toBe(6);
    const transitions = statusChanges.map(
      (e) => `${e.data.from}→${e.data.to}`,
    );
    expect(transitions).toEqual([
      'creating→joining',
      'joining→joined',
      'joined→recording',
      'recording→leaving',
      'leaving→left',
      'left→done',
    ]);
  });

  it('join timeout transitions to error (TV-BOT-011)', async () => {
    const bot = await store.createBot({
      meetingUrl: 'https://zoom.us/j/123',
      platform: 'zoom',
      config: {
        displayName: 'RecFn Bot',
        joinTimeout: 50, // very short for test
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

    // Platform adapter that takes too long
    const adapter = createMockPlatformAdapter({ joinDelay: 200 });
    const worker = createBotWorker({
      store,
      queue,
      logger,
      platformAdapters: new Map([['zoom', adapter]]),
    });

    await worker.processNext();

    const updated = await store.getBot(bot.id, 'ns_test');
    expect(updated!.status).toBe('error');
    expect(updated!.errorMessage).toContain('Join timeout exceeded');
  });

  it('join error transitions to error', async () => {
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

    const adapter = createMockPlatformAdapter({
      joinError: 'Meeting not found',
    });
    const worker = createBotWorker({
      store,
      queue,
      logger,
      platformAdapters: new Map([['zoom', adapter]]),
    });

    await worker.processNext();

    const updated = await store.getBot(bot.id, 'ns_test');
    expect(updated!.status).toBe('error');
    expect(updated!.errorMessage).toBe('Meeting not found');
  });

  it('missing platform adapter transitions to error', async () => {
    const bot = await store.createBot({
      meetingUrl: 'https://meet.google.com/abc',
      platform: 'meet',
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

    // No 'meet' adapter registered
    const worker = createBotWorker({
      store,
      queue,
      logger,
      platformAdapters: new Map(),
    });

    await worker.processNext();

    const updated = await store.getBot(bot.id, 'ns_test');
    expect(updated!.status).toBe('error');
    expect(updated!.errorMessage).toContain('No platform adapter');
  });

  it('processNext returns false when queue is empty', async () => {
    const worker = createBotWorker({
      store,
      queue,
      logger,
      platformAdapters: new Map(),
    });

    const result = await worker.processNext();
    expect(result).toBe(false);
  });
});

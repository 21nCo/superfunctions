import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { AudioChunk, PlatformAdapter, Participant } from 'recfn';
import {
  createMemoryStore,
  createBotWorker,
  MemoryQueueAdapter,
  MemoryLogger,
  QUEUE_NAMES,
  transitionBot,
  MemoryStorageAdapter,
} from '../src/index.js';
import type { RecFnStore } from '../src/store/types.js';

interface MockPlatformAdapter extends PlatformAdapter {
  emitParticipantLeave(participantId?: string): Promise<void>;
}

function createMockPlatformAdapter(
  opts: {
    joinDelay?: number;
    joinError?: string;
    audioChunks?: AudioChunk[];
    leaveError?: string;
  } = {},
): MockPlatformAdapter {
  const participantJoinCbs: ((p: Participant) => void)[] = [];
  const participantLeaveCbs: ((id: string) => void | Promise<void>)[] = [];
  const participants: Participant[] = [];
  const audioChunks =
    opts.audioChunks ??
    [
      {
        data: new Uint8Array([1, 2, 3]),
        timestamp: 1000,
        sampleRate: 48000,
        channels: 1,
      },
      {
        data: new Uint8Array([4, 5, 6]),
        timestamp: 2000,
        sampleRate: 48000,
        channels: 1,
      },
    ];

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
    async leave() {
      if (opts.leaveError) {
        throw new Error(opts.leaveError);
      }
    },
    getAudioStream() {
      return new ReadableStream<AudioChunk>({
        start(controller) {
          for (const chunk of audioChunks) {
            controller.enqueue(chunk);
          }
          controller.close();
        },
      });
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
    async emitParticipantLeave(participantId = 'participant_1') {
      await Promise.all(participantLeaveCbs.map((cb) => cb(participantId)));
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

  it('finalizes and uploads a recording automatically after leave (TV-BOT-001)', async () => {
    const storage = new MemoryStorageAdapter();
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

    const worker = createBotWorker({
      store,
      queue,
      logger,
      storage,
      platformAdapters: new Map([['zoom', createMockPlatformAdapter()]]),
    });

    expect(await worker.processNext()).toBe(true);

    await transitionBot({ store, logger, queue }, bot.id, 'ns_test', 'leaving');
    expect(queue.size(QUEUE_NAMES.RECORDING_UPLOAD)).toBe(1);

    expect(await worker.processNext()).toBe(true);

    const updated = await store.getBot(bot.id, 'ns_test');
    const recordings = await store.getRecordings(bot.id, 'ns_test');

    expect(updated!.status).toBe('done');
    expect(recordings).toHaveLength(1);
    expect(storage.has(recordings[0].storageRef)).toBe(true);

    const transitions = logger
      .findByEvent('bot.status_change')
      .map((entry) => `${entry.data.from}→${entry.data.to}`);
    expect(transitions).toContain('recording→leaving');
    expect(transitions).toContain('leaving→finalizing');
    expect(transitions).toContain('finalizing→done');
    expect(logger.findByEvent('recording.finalization.complete')).toHaveLength(1);
  });

  it('leaves a join-only bot without requiring a recording upload', async () => {
    const previousJoinOnly = process.env.RECFN_POC_JOIN_ONLY;
    process.env.RECFN_POC_JOIN_ONLY = '1';

    try {
      const storage = new MemoryStorageAdapter();
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

      const worker = createBotWorker({
        store,
        queue,
        logger,
        storage,
        platformAdapters: new Map([['zoom', createMockPlatformAdapter()]]),
      });

      expect(await worker.processNext()).toBe(true);

      const joined = await store.getBot(bot.id, 'ns_test');
      expect(joined!.status).toBe('joined');

      await transitionBot({ store, logger, queue }, bot.id, 'ns_test', 'leaving');
      expect(queue.size(QUEUE_NAMES.RECORDING_UPLOAD)).toBe(1);
      expect(await worker.processNext()).toBe(true);

      const updated = await store.getBot(bot.id, 'ns_test');
      const recordings = await store.getRecordings(bot.id, 'ns_test');
      expect(updated!.status).toBe('left');
      expect(recordings).toHaveLength(0);
      expect(logger.findByEvent('bot.join_only.finalization.complete')).toHaveLength(1);
    } finally {
      if (previousJoinOnly === undefined) {
        delete process.env.RECFN_POC_JOIN_ONLY;
      } else {
        process.env.RECFN_POC_JOIN_ONLY = previousJoinOnly;
      }
    }
  });

  it('starts auto-leave when the last participant leaves a join-only bot', async () => {
    vi.useFakeTimers();
    const previousJoinOnly = process.env.RECFN_POC_JOIN_ONLY;
    process.env.RECFN_POC_JOIN_ONLY = '1';

    const bot = await store.createBot({
      meetingUrl: 'https://zoom.us/j/123',
      platform: 'zoom',
      config: {
        displayName: 'RecFn Bot',
        joinTimeout: 30000,
        autoLeaveOnEmpty: true,
        autoLeaveEmptyTimeout: 25,
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

    try {
      expect(await worker.processNext()).toBe(true);
      expect((await store.getBot(bot.id, 'ns_test'))!.status).toBe('joined');

      await adapter.emitParticipantLeave();
      await vi.advanceTimersByTimeAsync(25);

      expect((await store.getBot(bot.id, 'ns_test'))!.status).toBe('leaving');
    } finally {
      worker.getAutoLeaveTimer().cancelAll();
      vi.useRealTimers();
      if (previousJoinOnly === undefined) {
        delete process.env.RECFN_POC_JOIN_ONLY;
      } else {
        process.env.RECFN_POC_JOIN_ONLY = previousJoinOnly;
      }
    }
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

  it('transitions to error when automatic finalization upload fails (TV-BOT-001 negative)', async () => {
    class FailingStorageAdapter extends MemoryStorageAdapter {
      override async openUploadStream(): Promise<WritableStream<Uint8Array>> {
        throw new Error('storage offline');
      }
    }

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

    const worker = createBotWorker({
      store,
      queue,
      logger,
      storage: new FailingStorageAdapter(),
      platformAdapters: new Map([['zoom', createMockPlatformAdapter()]]),
    });

    await worker.processNext();
    await transitionBot({ store, logger, queue }, bot.id, 'ns_test', 'leaving');
    await worker.processNext();

    const updated = await store.getBot(bot.id, 'ns_test');
    expect(updated!.status).toBe('error');
    expect(updated!.errorMessage).toContain('RECORDING_FINALIZATION_FAILED');

    const failures = logger.findByEvent('recording.finalization.failed');
    expect(failures).toHaveLength(1);
    expect(failures[0].data.code).toBe('RECORDING_FINALIZATION_FAILED');
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

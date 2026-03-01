import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  createMemoryStore,
  createAutoLeaveTimer,
  MemoryLogger,
  transitionBot,
} from '../src/index.js';
import type { RecFnStore } from '../src/store/types.js';
import type { Bot } from 'recfn';

describe('Auto-leave on empty (TV-BOT-006)', () => {
  let store: RecFnStore;
  let logger: MemoryLogger;

  beforeEach(() => {
    vi.useFakeTimers();
    store = createMemoryStore();
    logger = new MemoryLogger();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function createRecordingBot(
    timeout = 5000,
    autoLeave = true,
  ): Promise<Bot> {
    const bot = await store.createBot({
      meetingUrl: 'https://zoom.us/j/123',
      platform: 'zoom',
      config: {
        displayName: 'RecFn Bot',
        joinTimeout: 30000,
        autoLeaveOnEmpty: autoLeave,
        autoLeaveEmptyTimeout: timeout,
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
    return (await store.getBot(bot.id, 'ns_test'))!;
  }

  it('auto-leaves after timeout when room empties', async () => {
    const bot = await createRecordingBot(5000);
    const timer = createAutoLeaveTimer({ store, logger });

    // Simulate last non-bot participant leaving
    timer.onParticipantLeave(bot, 0);

    // Not yet left
    let current = await store.getBot(bot.id, 'ns_test');
    expect(current!.status).toBe('recording');

    // Advance past timeout
    await vi.advanceTimersByTimeAsync(5100);

    current = await store.getBot(bot.id, 'ns_test');
    expect(current!.status).toBe('leaving');

    timer.cancelAll();
  });

  it('cancels auto-leave when a participant joins', async () => {
    const bot = await createRecordingBot(5000);
    const timer = createAutoLeaveTimer({ store, logger });

    // Simulate room emptying
    timer.onParticipantLeave(bot, 0);

    // Participant joins before timeout
    await vi.advanceTimersByTimeAsync(2000);
    timer.onParticipantJoin(bot.id);

    // Advance past original timeout
    await vi.advanceTimersByTimeAsync(5000);

    const current = await store.getBot(bot.id, 'ns_test');
    expect(current!.status).toBe('recording'); // Still recording

    timer.cancelAll();
  });

  it('does not auto-leave when autoLeaveOnEmpty is false', async () => {
    const bot = await createRecordingBot(5000, false);
    const timer = createAutoLeaveTimer({ store, logger });

    timer.onParticipantLeave(bot, 0);

    await vi.advanceTimersByTimeAsync(10000);

    const current = await store.getBot(bot.id, 'ns_test');
    expect(current!.status).toBe('recording'); // Still recording

    timer.cancelAll();
  });

  it('does not auto-leave when non-bot participants remain', async () => {
    const bot = await createRecordingBot(5000);
    const timer = createAutoLeaveTimer({ store, logger });

    // One non-bot participant still present
    timer.onParticipantLeave(bot, 1);

    await vi.advanceTimersByTimeAsync(10000);

    const current = await store.getBot(bot.id, 'ns_test');
    expect(current!.status).toBe('recording');

    timer.cancelAll();
  });
});

import { describe, expect, it } from 'vitest';
import { memoryAdapter } from '@superfunctions/db/adapters';
import { assertProductionStore, createDbStore } from '../src/store/db.js';
import type { BotConfig, MeetingMetadata } from 'recfn';
import { createMemoryStore } from '../src/store/memory.js';

const DEFAULT_CONFIG: Required<BotConfig> = {
  displayName: 'RecFn Bot',
  joinTimeout: 30_000,
  autoLeaveOnEmpty: true,
  autoLeaveEmptyTimeout: 30_000,
  consentMessage: 'This meeting is being recorded',
  enableRealTimeTranscript: false,
  asrProvider: 'whisper',
  recordingFormat: 'mp4',
  language: 'en-US',
};

describe('db store', () => {
  it('isolates namespaces and preserves aggregates across store instances (TV-ARCH-001)', async () => {
    const adapter = memoryAdapter({ debug: false });
    const store = createDbStore({ adapter, adapterName: '@superfunctions/db/memory' });

    const bot = await store.createBot({
      namespace: 'ns_a',
      meetingUrl: 'https://meet.google.com/abc-defg-hij',
      platform: 'meet',
      config: DEFAULT_CONFIG,
    });

    await store.addParticipant(
      bot.id,
      {
        id: 'participant-1',
        botId: bot.id,
        name: 'Alice',
        role: 'host',
        joinedAt: '2026-04-01T10:00:00.000Z',
        consent: 'granted',
      },
      'ns_a',
    );

    const metadata: MeetingMetadata & { namespace: string } = {
      id: 'meta_1',
      namespace: 'ns_a',
      botId: bot.id,
      title: 'Platform sync',
      platform: 'meet',
      startTime: '2026-04-01T10:00:00.000Z',
      chatMessages: [
        {
          participantId: 'participant-1',
          text: 'hello',
          timestamp: '2026-04-01T10:00:05.000Z',
        },
      ],
    };
    await adapter.create({
      model: 'meetingMetadata',
      data: metadata,
    });

    const storeAfterRestart = createDbStore({
      adapter,
      adapterName: '@superfunctions/db/memory',
    });

    expect(await storeAfterRestart.getBot(bot.id, 'ns_a')).toMatchObject({
      id: bot.id,
      namespace: 'ns_a',
      platform: 'meet',
    });
    expect(await storeAfterRestart.getBot(bot.id, 'ns_b')).toBeNull();

    const participants = await storeAfterRestart.getParticipants(bot.id, 'ns_a');
    expect(participants).toEqual([
      expect.objectContaining({
        id: 'participant-1',
        name: 'Alice',
        role: 'host',
      }),
    ]);
    expect(await storeAfterRestart.getParticipants(bot.id, 'ns_b')).toEqual([]);

    expect(await storeAfterRestart.getMetadata(bot.id, 'ns_a')).toEqual(
      expect.objectContaining({
        id: 'meta_1',
        title: 'Platform sync',
      }),
    );
    expect(await storeAfterRestart.getMetadata(bot.id, 'ns_b')).toBeNull();
  });

  it('fails fast in production when a durable store is not configured', () => {
    expect(() => assertProductionStore(createMemoryStore())).toThrow(
      /durable @superfunctions\/db-backed store/i,
    );
  });
});

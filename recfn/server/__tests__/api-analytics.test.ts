import { describe, it, expect, beforeEach } from 'vitest';
import { createTestServer, req, json } from './helpers.js';
import type { RecFnServer } from '../src/index.js';
import type { RecFnStore } from '../src/store/types.js';

describe('Analytics API routes', () => {
  let server: RecFnServer;
  let store: RecFnStore;

  beforeEach(() => {
    ({ server, store } = createTestServer());
  });

  async function createBotWithRecordingAndTranscript() {
    const bot = await store.createBot({
      meetingUrl: 'https://zoom.us/j/123',
      platform: 'zoom',
      config: {
        displayName: 'RecFn Bot', joinTimeout: 30000,
        autoLeaveOnEmpty: true, autoLeaveEmptyTimeout: 30000,
        consentMessage: 'This meeting is being recorded',
        enableRealTimeTranscript: false, asrProvider: 'whisper',
        recordingFormat: 'mp4', language: 'en-US',
      },
      namespace: 'ns_test',
    });

    await store.createRecording({
      id: 'rec_xyz789', botId: bot.id, format: 'mp4',
      duration: 120000, storageRef: 'recordings/ns_test/rec_xyz789.mp4',
      size: 1024, createdAt: '2026-02-28T15:00:00Z',
    }, 'ns_test');

    await store.createTranscript({
      id: 'trx_abc456',
      recordingId: 'rec_xyz789',
      language: 'en-US',
      status: 'ready',
      segments: [
        { speakerId: 'participant_1', startTime: 0, endTime: 60000, text: 'Hello', confidence: 0.9 },
        { speakerId: 'participant_2', startTime: 60000, endTime: 90000, text: 'Hi', confidence: 0.9 },
      ],
      createdAt: '2026-02-28T15:05:00Z',
    }, 'ns_test');

    return { bot };
  }

  describe('GET /api/v1/recordings/:recordingId/analytics', () => {
    it('returns analytics when transcript is ready (TV-ANA-001)', async () => {
      await createBotWithRecordingAndTranscript();

      const res = await server.router.handle(
        req('GET', '/api/v1/recordings/rec_xyz789/analytics'),
      );

      expect(res.status).toBe(200);
      const body = await json(res);
      expect(body.ok).toBe(true);
      const data = body.data as { recordingId: string; totalDuration: number; talkTime: Record<string, number>; silencePercentage: number };
      expect(data.recordingId).toBe('rec_xyz789');
      expect(data.totalDuration).toBe(120000);
      expect(data.talkTime.participant_1).toBe(60000);
      expect(data.talkTime.participant_2).toBe(30000);
      expect(data.silencePercentage).toBe(0.25);
    });

    it('returns 422 ANALYTICS_NOT_READY when transcript not ready', async () => {
      const bot = await store.createBot({
        meetingUrl: 'https://zoom.us/j/123', platform: 'zoom',
        config: {
          displayName: 'Bot', joinTimeout: 30000, autoLeaveOnEmpty: true,
          autoLeaveEmptyTimeout: 30000, consentMessage: 'Rec',
          enableRealTimeTranscript: false, asrProvider: 'whisper',
          recordingFormat: 'mp4', language: 'en-US',
        },
        namespace: 'ns_test',
      });

      await store.createRecording({
        id: 'rec_no_trx', botId: bot.id, format: 'mp4',
        duration: 60000, storageRef: 'recordings/ns_test/rec_no_trx.mp4',
        size: 512, createdAt: new Date().toISOString(),
      }, 'ns_test');

      const res = await server.router.handle(
        req('GET', '/api/v1/recordings/rec_no_trx/analytics'),
      );

      expect(res.status).toBe(422);
      const body = await json(res);
      expect((body.error as { code: string }).code).toBe('ANALYTICS_NOT_READY');
    });

    it('returns 404 for non-existent recording', async () => {
      const res = await server.router.handle(
        req('GET', '/api/v1/recordings/nonexistent/analytics'),
      );
      expect(res.status).toBe(404);
    });
  });
});

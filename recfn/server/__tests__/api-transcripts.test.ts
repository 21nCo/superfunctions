import { describe, it, expect, beforeEach } from 'vitest';
import { createTestServer, req, json } from './helpers.js';
import type { RecFnServer } from '../src/index.js';
import { MemoryQueueAdapter, QUEUE_NAMES, createMemoryStore, MemoryStorageAdapter } from '../src/index.js';
import { createRecFnServer } from '../src/index.js';
import type { RecFnStore } from '../src/store/types.js';
import type { Transcript } from 'recfn';

describe('Transcript API routes', () => {
  let server: RecFnServer;
  let store: RecFnStore;

  beforeEach(() => {
    ({ server, store } = createTestServer());
  });

  async function createBotWithRecording() {
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
      duration: 60000, storageRef: 'recordings/ns_test/rec_xyz789.mp4',
      size: 1024, createdAt: '2026-02-28T15:00:00Z',
    }, 'ns_test');

    return { bot };
  }

  describe('POST /api/v1/recordings/:recordingId/transcribe', () => {
    it('triggers batch transcription (TV-TRX-002)', async () => {
      await createBotWithRecording();

      const res = await server.router.handle(
        req('POST', '/api/v1/recordings/rec_xyz789/transcribe', {
          body: { asrProvider: 'whisper', language: 'en-US' },
        }),
      );

      expect(res.status).toBe(202);
      const body = await json(res);
      expect(body.ok).toBe(true);
      const data = body.data as { transcriptId: string; status: string };
      expect(data.transcriptId).toMatch(/^trx_/);
      expect(data.status).toBe('processing');
    });

    it('uses default provider and language when not specified', async () => {
      await createBotWithRecording();

      const res = await server.router.handle(
        req('POST', '/api/v1/recordings/rec_xyz789/transcribe', {
          body: {},
        }),
      );

      expect(res.status).toBe(202);
      const body = await json(res);
      expect(body.ok).toBe(true);
    });

    it('returns 404 for non-existent recording', async () => {
      const res = await server.router.handle(
        req('POST', '/api/v1/recordings/nonexistent/transcribe', {
          body: { asrProvider: 'whisper' },
        }),
      );

      expect(res.status).toBe(404);
      const body = await json(res);
      expect((body.error as { code: string }).code).toBe('RECORDING_NOT_FOUND');
    });

    it('returns 409 if transcription already in progress (TV-TRX-004)', async () => {
      await createBotWithRecording();

      // First request - should succeed
      const res1 = await server.router.handle(
        req('POST', '/api/v1/recordings/rec_xyz789/transcribe', {
          body: { asrProvider: 'whisper' },
        }),
      );
      expect(res1.status).toBe(202);

      // Second request - should be 409
      const res2 = await server.router.handle(
        req('POST', '/api/v1/recordings/rec_xyz789/transcribe', {
          body: { asrProvider: 'whisper' },
        }),
      );
      expect(res2.status).toBe(409);
      const body = await json(res2);
      expect((body.error as { code: string }).code).toBe('TRANSCRIPTION_IN_PROGRESS');
    });

    it('allows re-transcription after previous completes (TV-TRX-004)', async () => {
      await createBotWithRecording();

      // First transcription
      const res1 = await server.router.handle(
        req('POST', '/api/v1/recordings/rec_xyz789/transcribe', {
          body: { asrProvider: 'whisper' },
        }),
      );
      expect(res1.status).toBe(202);
      const data1 = (await json(res1)).data as { transcriptId: string };

      // Complete the first transcription
      await store.updateTranscript(data1.transcriptId, 'ns_test', {
        status: 'ready',
        segments: [{ speakerId: 'a', startTime: 0, endTime: 1000, text: 'Hi', confidence: 0.9 }],
      });

      // Second request should succeed (re-transcription)
      const res2 = await server.router.handle(
        req('POST', '/api/v1/recordings/rec_xyz789/transcribe', {
          body: { asrProvider: 'whisper' },
        }),
      );
      expect(res2.status).toBe(202);
    });

    it('enqueues job to flowfn when queue is configured', async () => {
      const store2 = createMemoryStore();
      const queue = new MemoryQueueAdapter();
      const storage = new MemoryStorageAdapter();
      const server2 = createRecFnServer({
        store: store2,
        storage,
        queue,
        validateApiKey: (key: string) =>
          key === 'sk-valid-key' ? { namespace: 'ns_test', apiKey: key } : null,
      });

      const bot = await store2.createBot({
        meetingUrl: 'https://zoom.us/j/123', platform: 'zoom',
        config: {
          displayName: 'Bot', joinTimeout: 30000, autoLeaveOnEmpty: true,
          autoLeaveEmptyTimeout: 30000, consentMessage: 'Rec',
          enableRealTimeTranscript: false, asrProvider: 'whisper',
          recordingFormat: 'mp4', language: 'en-US',
        },
        namespace: 'ns_test',
      });

      await store2.createRecording({
        id: 'rec_q1', botId: bot.id, format: 'mp4',
        duration: 30000, storageRef: 'recordings/ns_test/rec_q1.mp4',
        size: 256, createdAt: new Date().toISOString(),
      }, 'ns_test');

      const res = await server2.router.handle(
        req('POST', '/api/v1/recordings/rec_q1/transcribe', {
          body: { asrProvider: 'whisper', language: 'en-US' },
        }),
      );

      expect(res.status).toBe(202);
      expect(queue.size(QUEUE_NAMES.TRANSCRIPTION)).toBe(1);

      const job = await queue.dequeue(QUEUE_NAMES.TRANSCRIPTION);
      expect(job).not.toBeNull();
      expect(job!.data.recordingId).toBe('rec_q1');
      expect(job!.data.asrProvider).toBe('whisper');
      expect(job!.data.language).toBe('en-US');
    });
  });

  describe('GET /api/v1/recordings/:recordingId/transcript', () => {
    it('returns transcript as JSON (TV-TRX-005)', async () => {
      await createBotWithRecording();

      await store.createTranscript({
        id: 'trx_abc456',
        recordingId: 'rec_xyz789',
        language: 'en-US',
        status: 'ready',
        segments: [
          { speakerId: 'participant_1', startTime: 5000, endTime: 7000, text: 'Hello everyone.', confidence: 0.96 },
          { speakerId: 'participant_2', startTime: 7500, endTime: 9000, text: 'Sounds good.', confidence: 0.93 },
        ],
        createdAt: '2026-02-28T15:05:00Z',
      }, 'ns_test');

      const res = await server.router.handle(
        req('GET', '/api/v1/recordings/rec_xyz789/transcript'),
      );

      expect(res.status).toBe(200);
      const body = await json(res);
      expect(body.ok).toBe(true);
      const data = body.data as Transcript;
      expect(data.id).toBe('trx_abc456');
      expect(data.recordingId).toBe('rec_xyz789');
      expect(data.language).toBe('en-US');
      expect(data.status).toBe('ready');
      expect(data.segments).toHaveLength(2);
      expect(data.segments[0].speakerId).toBe('participant_1');
      expect(data.segments[0].text).toBe('Hello everyone.');
      expect(data.segments[1].speakerId).toBe('participant_2');
    });

    it('returns segments sorted by startTime then speakerId (TV-TRX-006)', async () => {
      await createBotWithRecording();

      await store.createTranscript({
        id: 'trx_sorted',
        recordingId: 'rec_xyz789',
        language: 'en-US',
        status: 'ready',
        segments: [
          { speakerId: 'b', startTime: 1000, endTime: 2000, text: 'B', confidence: 0.9 },
          { speakerId: 'a', startTime: 1000, endTime: 1500, text: 'A1', confidence: 0.9 },
          { speakerId: 'a', startTime: 500, endTime: 1000, text: 'A0', confidence: 0.9 },
        ],
        createdAt: new Date().toISOString(),
      }, 'ns_test');

      const res = await server.router.handle(
        req('GET', '/api/v1/recordings/rec_xyz789/transcript'),
      );

      const body = await json(res);
      const data = body.data as Transcript;
      expect(data.segments[0]).toEqual(expect.objectContaining({ startTime: 500, speakerId: 'a' }));
      expect(data.segments[1]).toEqual(expect.objectContaining({ startTime: 1000, speakerId: 'a' }));
      expect(data.segments[2]).toEqual(expect.objectContaining({ startTime: 1000, speakerId: 'b' }));
    });

    it('returns 404 for non-existent recording', async () => {
      const res = await server.router.handle(
        req('GET', '/api/v1/recordings/nonexistent/transcript'),
      );
      expect(res.status).toBe(404);
    });

    it('returns 404 when no transcript exists', async () => {
      await createBotWithRecording();

      const res = await server.router.handle(
        req('GET', '/api/v1/recordings/rec_xyz789/transcript'),
      );
      expect(res.status).toBe(404);
      const body = await json(res);
      expect((body.error as { code: string }).code).toBe('TRANSCRIPT_NOT_FOUND');
    });

    it('enforces namespace isolation', async () => {
      await createBotWithRecording();
      await store.createTranscript({
        id: 'trx_ns', recordingId: 'rec_xyz789',
        language: 'en-US', status: 'ready', segments: [],
        createdAt: new Date().toISOString(),
      }, 'ns_test');

      const res = await server.router.handle(
        req('GET', '/api/v1/recordings/rec_xyz789/transcript', { apiKey: 'sk-ns-a' }),
      );
      expect(res.status).toBe(404);
    });
  });
});

import { describe, it, expect, beforeEach } from 'vitest';
import { createTestServer, req, json } from './helpers.js';
import type { RecFnServer } from '../src/index.js';
import type { RecFnStore } from '../src/store/types.js';
import type { MemoryStorageAdapter } from '../src/integrations/filefn.js';
import type { Recording } from 'recfn';

describe('Recording API routes', () => {
  let server: RecFnServer;
  let store: RecFnStore;
  let storage: MemoryStorageAdapter;

  beforeEach(() => {
    ({ server, store, storage } = createTestServer());
  });

  async function createBotAndRecording(): Promise<{
    botId: string;
    recording: Recording;
  }> {
    const bot = await store.createBot({
      meetingUrl: 'https://zoom.us/j/1234567890?pwd=abc123',
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

    const storageRef = `recordings/ns_test/rec_test123.mp4`;
    await storage.upload(storageRef, new Uint8Array([1, 2, 3, 4, 5]), {
      contentType: 'video/mp4',
      encryption: true,
    });

    const recording = await store.createRecording(
      {
        id: 'rec_test123',
        botId: bot.id,
        format: 'mp4',
        duration: 1800000,
        storageRef,
        size: 52428800,
        createdAt: '2026-02-28T15:00:00Z',
      },
      'ns_test',
    );

    return { botId: bot.id, recording };
  }

  describe('GET /api/v1/bots/:botId/recordings', () => {
    it('returns recordings for a bot (TV-REC-005)', async () => {
      const { botId } = await createBotAndRecording();

      const res = await server.router.handle(
        req('GET', `/api/v1/bots/${botId}/recordings`),
      );

      expect(res.status).toBe(200);
      const body = await json(res);
      expect(body.ok).toBe(true);
      const data = body.data as { recordings: Recording[] };
      expect(data.recordings).toHaveLength(1);
      expect(data.recordings[0].id).toBe('rec_test123');
      expect(data.recordings[0].botId).toBe(botId);
      expect(data.recordings[0].format).toBe('mp4');
      expect(data.recordings[0].duration).toBe(1800000);
      expect(data.recordings[0].storageRef).toMatch(/^recordings\/ns_test\//);
      expect(data.recordings[0].size).toBe(52428800);
      expect(data.recordings[0].createdAt).toBe('2026-02-28T15:00:00Z');
    });

    it('returns empty array for bot with no recordings', async () => {
      const bot = await store.createBot({
        meetingUrl: 'https://zoom.us/j/999',
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

      const res = await server.router.handle(
        req('GET', `/api/v1/bots/${bot.id}/recordings`),
      );

      expect(res.status).toBe(200);
      const body = await json(res);
      expect(body.ok).toBe(true);
      const data = body.data as { recordings: Recording[] };
      expect(data.recordings).toHaveLength(0);
    });

    it('returns 404 for non-existent bot', async () => {
      const res = await server.router.handle(
        req('GET', '/api/v1/bots/nonexistent/recordings'),
      );

      expect(res.status).toBe(404);
      const body = await json(res);
      expect(body.ok).toBe(false);
      expect((body.error as { code: string }).code).toBe('BOT_NOT_FOUND');
    });
  });

  describe('GET /api/v1/recordings/:recordingId', () => {
    it('returns recording with downloadUrl (TV-REC-004)', async () => {
      await createBotAndRecording();

      const res = await server.router.handle(
        req('GET', '/api/v1/recordings/rec_test123'),
      );

      expect(res.status).toBe(200);
      const body = await json(res);
      expect(body.ok).toBe(true);
      const data = body.data as Recording & { downloadUrl: string };
      expect(data.id).toBe('rec_test123');
      expect(data.format).toBe('mp4');
      expect(data.duration).toBe(1800000);
      expect(data.downloadUrl).toBeDefined();
      expect(data.downloadUrl).toContain('signed');
      expect(data.downloadUrl).toContain('expires');
    });

    it('returns 404 for non-existent recording (TV-REC-004 negative)', async () => {
      const res = await server.router.handle(
        req('GET', '/api/v1/recordings/nonexistent'),
      );

      expect(res.status).toBe(404);
      const body = await json(res);
      expect(body.ok).toBe(false);
      expect((body.error as { code: string }).code).toBe(
        'RECORDING_NOT_FOUND',
      );
    });

    it('enforces namespace isolation', async () => {
      await createBotAndRecording(); // Created in ns_test

      const res = await server.router.handle(
        req('GET', '/api/v1/recordings/rec_test123', {
          apiKey: 'sk-ns-a',
        }),
      );

      expect(res.status).toBe(404);
    });
  });

  describe('GET /api/v1/recordings/:recordingId/download', () => {
    it('returns 302 redirect to signed URL (TV-REC-004)', async () => {
      await createBotAndRecording();

      const res = await server.router.handle(
        req('GET', '/api/v1/recordings/rec_test123/download'),
      );

      expect(res.status).toBe(302);
      const location = res.headers.get('Location');
      expect(location).toBeDefined();
      expect(location).toContain('signed');
      expect(location).toContain('expires');
    });

    it('returns 404 for non-existent recording', async () => {
      const res = await server.router.handle(
        req('GET', '/api/v1/recordings/nonexistent/download'),
      );

      expect(res.status).toBe(404);
      const body = await json(res);
      expect(body.ok).toBe(false);
      expect((body.error as { code: string }).code).toBe(
        'RECORDING_NOT_FOUND',
      );
    });

    it('requires authentication', async () => {
      const res = await server.router.handle(
        req('GET', '/api/v1/recordings/rec_test123/download', {
          apiKey: '',
        }),
      );

      expect(res.status).toBe(401);
    });
  });

  describe('Recording entity shape (TV-REC-001)', () => {
    it('recording has all required fields', async () => {
      const { recording } = await createBotAndRecording();

      expect(recording.id).toBeDefined();
      expect(recording.botId).toBeDefined();
      expect(recording.format).toBe('mp4');
      expect(recording.duration).toBe(1800000);
      expect(recording.storageRef).toBeDefined();
      expect(recording.size).toBe(52428800);
      expect(recording.createdAt).toBeDefined();
    });
  });

  describe('Encryption at rest (TV-SEC-003)', () => {
    it('recording file is encrypted in storage', async () => {
      const { recording } = await createBotAndRecording();

      expect(storage.isEncrypted(recording.storageRef)).toBe(true);
    });
  });
});

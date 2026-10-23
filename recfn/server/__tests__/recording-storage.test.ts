import { describe, it, expect } from 'vitest';
import { uploadRecording } from '../src/recording/storage.js';
import { MemoryStorageAdapter } from '../src/integrations/filefn.js';
import { MemoryLogger } from '../src/integrations/logfn.js';
import { createMemoryStore } from '../src/store/memory.js';
import type { CaptureResult } from '../src/recording/capture.js';
import { createMetricsEmitter } from '../src/integrations/watchfn.js';

describe('uploadRecording', () => {
  it('uploads recording to storage and creates store entry (TV-INT-002)', async () => {
    const storage = new MemoryStorageAdapter();
    const store = createMemoryStore();
    const logger = new MemoryLogger();

    // Create a bot first so getRecordings can find it
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

    const capture: CaptureResult = {
      data: new Uint8Array([1, 2, 3, 4, 5]),
      format: 'mp4',
      duration: 1800000,
      size: 5,
    };

    const result = await uploadRecording(
      { botId: bot.id, namespace: 'ns_test', capture },
      { storage, store, logger },
    );

    // Recording entity created
    expect(result.recording.id).toMatch(/^rec_/);
    expect(result.recording.botId).toBe(bot.id);
    expect(result.recording.format).toBe('mp4');
    expect(result.recording.duration).toBe(1800000);
    expect(result.recording.size).toBe(5);
    expect(result.recording.storageRef).toMatch(
      /^recordings\/ns_test\/rec_.*\.mp4$/,
    );
    expect(result.recording.createdAt).toBeDefined();

    // File in storage
    expect(storage.has(result.recording.storageRef)).toBe(true);

    // Encrypted at rest (TV-SEC-003)
    expect(storage.isEncrypted(result.recording.storageRef)).toBe(true);

    // Store has the recording
    const recordings = await store.getRecordings(bot.id, 'ns_test');
    expect(recordings).toHaveLength(1);
    expect(recordings[0].id).toBe(result.recording.id);

    // Logger recorded events
    const uploadStart = logger.findByEvent('recording.upload.start');
    expect(uploadStart).toHaveLength(1);
    expect(uploadStart[0].data.botId).toBe(bot.id);

    const uploadComplete = logger.findByEvent('recording.upload.complete');
    expect(uploadComplete).toHaveLength(1);
    expect(uploadComplete[0].data.storageRef).toBe(result.recording.storageRef);
  });

  it('generates wav storageRef for audio-only recordings', async () => {
    const storage = new MemoryStorageAdapter();
    const store = createMemoryStore();
    const logger = new MemoryLogger();

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
        recordingFormat: 'audio_only',
        language: 'en-US',
      },
      namespace: 'ns_test',
    });

    const capture: CaptureResult = {
      data: new Uint8Array([10, 20]),
      format: 'wav',
      duration: 60000,
      size: 2,
    };

    const result = await uploadRecording(
      { botId: bot.id, namespace: 'ns_test', capture },
      { storage, store, logger },
    );

    expect(result.recording.format).toBe('wav');
    expect(result.recording.storageRef).toMatch(/\.wav$/);
  });

  it('upload completes within reasonable time (TV-REC-003)', async () => {
    const storage = new MemoryStorageAdapter();
    const store = createMemoryStore();
    const logger = new MemoryLogger();

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

    const capture: CaptureResult = {
      data: new Uint8Array(1024 * 1024), // 1MB
      format: 'mp4',
      duration: 3600000,
      size: 1024 * 1024,
    };

    const start = Date.now();
    await uploadRecording(
      { botId: bot.id, namespace: 'ns_test', capture },
      { storage, store, logger },
    );
    const elapsed = Date.now() - start;

    // In-memory upload should complete well under 60s
    expect(elapsed).toBeLessThan(60000);

    // Verify uploadDurationMs is logged
    const uploadComplete = logger.findByEvent('recording.upload.complete');
    expect(uploadComplete).toHaveLength(1);
    expect(uploadComplete[0].data.uploadDurationMs).toBeTypeOf('number');
  });

  it('emits recording.ready and upload latency metrics for automatic finalization (TV-BOT-001, TV-OBS-001)', async () => {
    const storage = new MemoryStorageAdapter();
    const store = createMemoryStore();
    const logger = new MemoryLogger();
    const webhookEvents: Array<{ namespace: string; eventType: string }> = [];
    const metricEvents: Array<{ event: string; props?: Record<string, unknown> }> = [];
    const metrics = createMetricsEmitter((event, props) => {
      metricEvents.push({ event, props });
    });

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

    const capture: CaptureResult = {
      data: new Uint8Array([1, 2, 3, 4, 5]),
      format: 'mp4',
      duration: 1800000,
      size: 5,
    };

    const result = await uploadRecording(
      {
        botId: bot.id,
        namespace: 'ns_test',
        capture,
        source: 'bot_finalization',
      },
      {
        storage,
        store,
        logger,
        metrics,
        webhookDeliverer: {
          async deliver(namespace, eventType) {
            webhookEvents.push({ namespace, eventType });
          },
        },
      },
    );

    expect(result.recording.botId).toBe(bot.id);
    expect(webhookEvents).toContainEqual({
      namespace: 'ns_test',
      eventType: 'recording.ready',
    });
    expect(metricEvents).toContainEqual({
      event: 'recfn.recording.upload_latency_ms',
      props: expect.objectContaining({
        botId: bot.id,
        recordingId: result.recording.id,
        namespace: 'ns_test',
      }),
    });
  });

  it('fails with deterministic finalization code on storage errors (TV-BOT-001 negative)', async () => {
    class FailingStorageAdapter extends MemoryStorageAdapter {
      override async openUploadStream(): Promise<WritableStream<Uint8Array>> {
        throw new Error('storage offline');
      }
    }

    const storage = new FailingStorageAdapter();
    const store = createMemoryStore();
    const logger = new MemoryLogger();

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

    const capture: CaptureResult = {
      data: new Uint8Array([1, 2, 3]),
      format: 'mp4',
      duration: 1000,
      size: 3,
    };

    await expect(
      uploadRecording(
        {
          botId: bot.id,
          namespace: 'ns_test',
          capture,
          source: 'bot_finalization',
        },
        { storage, store, logger },
      ),
    ).rejects.toMatchObject({
      code: 'RECORDING_FINALIZATION_FAILED',
    });

    const failures = logger.findByEvent('recording.upload.failed');
    expect(failures).toHaveLength(1);
    expect(failures[0].data.code).toBe('RECORDING_FINALIZATION_FAILED');
  });
});

describe('producer finalization failure', () => {
  for (const uploadFails of [false, true]) for (const diagnosticFails of [false, true]) {
    it(`preserves ${uploadFails ? 'upload failure' : 'committed recording'} when producer finalization fails (diagnostic failure: ${diagnosticFails})`, async () => {
      const store = createMemoryStore();
      const { validateBotConfig } = await import('@recfn/core');
      const bot = await store.createBot({ namespace: 'cleanup', platform: 'zoom', meetingUrl: 'https://zoom.us/j/123', config: validateBotConfig({}) });
      const storage = new MemoryStorageAdapter();
      const logger = new MemoryLogger();
      const logError = logger.error.bind(logger);
      if (diagnosticFails) logger.error = (event, data) => {
        if (event === 'recording.producer.finish_failed') throw new Error('diagnostic unavailable');
        logError(event, data);
      };
      const originalFinish = store.finishBotProducer.bind(store);
      store.finishBotProducer = async () => { throw new Error('producer database unavailable'); };
      if (uploadFails) storage.openUploadStream = async () => { throw new Error('upload unavailable'); };
      const operation = uploadRecording({ botId: bot.id, namespace: 'cleanup', capture: { data: new Uint8Array([1]), size: 1, duration: 1, format: 'wav' } }, { store, storage, logger });
      if (uploadFails) {
        await expect(operation).rejects.toMatchObject({ code: 'RECORDING_FINALIZATION_FAILED', message: `Recording upload failed for ${bot.id}.` });
        expect(await store.getRecordings(bot.id, 'cleanup')).toEqual([]);
      }
      else {
        const result = await operation;
        expect(await store.getRecordings(bot.id, 'cleanup')).toEqual([result.recording]);
        expect(storage.has(result.recording.storageRef)).toBe(true);
      }
      const intents = await store.listBotProducers(bot.id, 'cleanup');
      expect(intents).toHaveLength(1);
      expect(intents[0].state).toBe('active');
      expect(logger.findByEvent('recording.producer.finish_failed')).toHaveLength(diagnosticFails ? 0 : 1);
      store.finishBotProducer = originalFinish;
    });
  }
});

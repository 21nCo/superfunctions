import { describe, it, expect, vi } from 'vitest';
import { processTranscriptionJob } from '../src/transcription/pipeline.js';
import { createAsrRegistry } from '../src/transcription/registry.js';
import { createMemoryStore } from '../src/store/memory.js';
import { MemoryLogger } from '../src/integrations/logfn.js';
import { createSearchFnClient } from '../src/integrations/searchfn.js';
import type { AsrAdapter, AsrOpts, Segment } from 'recfn';

function createMockAsrAdapter(segments: Segment[]): AsrAdapter {
  return {
    name: 'whisper',
    async *transcribeStream(): AsyncIterable<Segment> {
      throw new Error('Not supported');
    },
    async transcribeBatch(_audioRef: string, _opts: AsrOpts): Promise<Segment[]> {
      return segments;
    },
    supportedLanguages(): string[] {
      return ['en', 'es'];
    },
  };
}

describe('processTranscriptionJob', () => {
  it('transcribes recording and creates transcript (TV-TRX-002)', async () => {
    const store = createMemoryStore();
    const logger = new MemoryLogger();
    const registry = createAsrRegistry();

    const mockSegments: Segment[] = [
      { speakerId: 'speaker_0', startTime: 5000, endTime: 7000, text: 'Hello everyone.', confidence: 0.96 },
      { speakerId: 'speaker_1', startTime: 7500, endTime: 9000, text: 'Sounds good.', confidence: 0.93 },
    ];
    registry.register(createMockAsrAdapter(mockSegments));

    // Create bot and recording in store
    const bot = await store.createBot({
      meetingUrl: 'https://zoom.us/j/123',
      platform: 'zoom',
      config: {
        displayName: 'RecFn Bot', joinTimeout: 30000,
        autoLeaveOnEmpty: true, autoLeaveEmptyTimeout: 30000,
        consentMessage: 'Recording', enableRealTimeTranscript: false,
        asrProvider: 'whisper', recordingFormat: 'mp4', language: 'en-US',
      },
      namespace: 'ns_test',
    });

    await store.createRecording({
      id: 'rec_test1', botId: bot.id, format: 'mp4',
      duration: 60000, storageRef: 'recordings/ns_test/rec_test1.mp4',
      size: 1024, createdAt: new Date().toISOString(),
    }, 'ns_test');

    const result = await processTranscriptionJob(
      {
        recordingId: 'rec_test1',
        namespace: 'ns_test',
        audioRef: 'recordings/ns_test/rec_test1.mp4',
        asrProvider: 'whisper',
        language: 'en-US',
      },
      { store, logger, asrRegistry: registry },
    );

    expect(result.id).toMatch(/^trx_/);
    expect(result.recordingId).toBe('rec_test1');
    expect(result.status).toBe('ready');
    expect(result.language).toBe('en-US');
    expect(result.segments).toHaveLength(2);
    expect(result.segments[0].text).toBe('Hello everyone.');
    expect(result.segments[1].text).toBe('Sounds good.');

    // Verify transcript in store
    const stored = await store.getTranscript('rec_test1', 'ns_test');
    expect(stored).not.toBeNull();
    expect(stored!.status).toBe('ready');
    expect(stored!.segments).toHaveLength(2);

    // Verify logging
    expect(logger.findByEvent('transcription.start')).toHaveLength(1);
    expect(logger.findByEvent('transcription.complete')).toHaveLength(1);
    expect(logger.findByEvent('transcription.complete')[0].data.segmentCount).toBe(2);
  });

  it('produces segments with speaker diarization (TV-TRX-003)', async () => {
    const store = createMemoryStore();
    const logger = new MemoryLogger();
    const registry = createAsrRegistry();

    const mockSegments: Segment[] = [
      { speakerId: 'participant_1', startTime: 0, endTime: 3000, text: 'Speaker one.', confidence: 0.9 },
      { speakerId: 'participant_2', startTime: 3500, endTime: 6000, text: 'Speaker two.', confidence: 0.88 },
      { speakerId: 'participant_1', startTime: 6500, endTime: 9000, text: 'Back to one.', confidence: 0.91 },
    ];
    registry.register(createMockAsrAdapter(mockSegments));

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
      id: 'rec_diar', botId: bot.id, format: 'mp4',
      duration: 10000, storageRef: 'recordings/ns_test/rec_diar.mp4',
      size: 512, createdAt: new Date().toISOString(),
    }, 'ns_test');

    const result = await processTranscriptionJob(
      {
        recordingId: 'rec_diar', namespace: 'ns_test',
        audioRef: 'recordings/ns_test/rec_diar.mp4',
        asrProvider: 'whisper', language: 'en-US',
      },
      { store, logger, asrRegistry: registry },
    );

    expect(result.segments).toHaveLength(3);
    const speakerIds = new Set(result.segments.map((s) => s.speakerId));
    expect(speakerIds.size).toBe(2);
    expect(speakerIds.has('participant_1')).toBe(true);
    expect(speakerIds.has('participant_2')).toBe(true);
  });

  it('sorts segments by startTime then speakerId (TV-TRX-006)', async () => {
    const store = createMemoryStore();
    const logger = new MemoryLogger();
    const registry = createAsrRegistry();

    const unsorted: Segment[] = [
      { speakerId: 'b', startTime: 1000, endTime: 2000, text: 'B1', confidence: 0.9 },
      { speakerId: 'a', startTime: 1000, endTime: 1500, text: 'A1', confidence: 0.9 },
      { speakerId: 'a', startTime: 500, endTime: 1000, text: 'A0', confidence: 0.9 },
    ];
    registry.register(createMockAsrAdapter(unsorted));

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
      id: 'rec_sort', botId: bot.id, format: 'mp4',
      duration: 3000, storageRef: 'recordings/ns_test/rec_sort.mp4',
      size: 100, createdAt: new Date().toISOString(),
    }, 'ns_test');

    const result = await processTranscriptionJob(
      {
        recordingId: 'rec_sort', namespace: 'ns_test',
        audioRef: 'recordings/ns_test/rec_sort.mp4',
        asrProvider: 'whisper', language: 'en-US',
      },
      { store, logger, asrRegistry: registry },
    );

    expect(result.segments[0]).toEqual(expect.objectContaining({ startTime: 500, speakerId: 'a' }));
    expect(result.segments[1]).toEqual(expect.objectContaining({ startTime: 1000, speakerId: 'a' }));
    expect(result.segments[2]).toEqual(expect.objectContaining({ startTime: 1000, speakerId: 'b' }));
  });

  it('returns error transcript when adapter not found', async () => {
    const store = createMemoryStore();
    const logger = new MemoryLogger();
    const registry = createAsrRegistry();

    const bot = await store.createBot({
      meetingUrl: 'https://zoom.us/j/123', platform: 'zoom',
      config: {
        displayName: 'Bot', joinTimeout: 30000, autoLeaveOnEmpty: true,
        autoLeaveEmptyTimeout: 30000, consentMessage: 'Rec',
        enableRealTimeTranscript: false, asrProvider: 'nonexistent',
        recordingFormat: 'mp4', language: 'en-US',
      },
      namespace: 'ns_test',
    });

    await store.createRecording({
      id: 'rec_err', botId: bot.id, format: 'mp4',
      duration: 1000, storageRef: 'recordings/ns_test/rec_err.mp4',
      size: 50, createdAt: new Date().toISOString(),
    }, 'ns_test');

    const result = await processTranscriptionJob(
      {
        recordingId: 'rec_err', namespace: 'ns_test',
        audioRef: 'recordings/ns_test/rec_err.mp4',
        asrProvider: 'nonexistent', language: 'en-US',
      },
      { store, logger, asrRegistry: registry },
    );

    expect(result.status).toBe('error');
    expect(logger.findByEvent('transcription.adapter_not_found')).toHaveLength(1);
  });

  it('handles ASR adapter error gracefully', async () => {
    const store = createMemoryStore();
    const logger = new MemoryLogger();
    const registry = createAsrRegistry();

    const failingAdapter: AsrAdapter = {
      name: 'whisper',
      async *transcribeStream(): AsyncIterable<Segment> { throw new Error('fail'); },
      async transcribeBatch(): Promise<Segment[]> {
        throw new Error('Whisper process crashed');
      },
      supportedLanguages() { return ['en']; },
    };
    registry.register(failingAdapter);

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
      id: 'rec_fail', botId: bot.id, format: 'mp4',
      duration: 1000, storageRef: 'recordings/ns_test/rec_fail.mp4',
      size: 50, createdAt: new Date().toISOString(),
    }, 'ns_test');

    const result = await processTranscriptionJob(
      {
        recordingId: 'rec_fail', namespace: 'ns_test',
        audioRef: 'recordings/ns_test/rec_fail.mp4',
        asrProvider: 'whisper', language: 'en-US',
      },
      { store, logger, asrRegistry: registry },
    );

    expect(result.status).toBe('error');
    expect(logger.findByEvent('transcription.error')).toHaveLength(1);
    expect(logger.findByEvent('transcription.error')[0].data.error).toBe('Whisper process crashed');
  });

  it('indexes transcript in searchfn when searchClient provided (TV-SRCH-001)', async () => {
    const store = createMemoryStore();
    const logger = new MemoryLogger();
    const registry = createAsrRegistry();
    const searchClient = createSearchFnClient();

    const mockSegments: Segment[] = [
      { speakerId: 'p1', startTime: 0, endTime: 5000, text: 'Action items for next week', confidence: 0.9 },
    ];
    registry.register(createMockAsrAdapter(mockSegments));

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
      id: 'rec_idx', botId: bot.id, format: 'mp4',
      duration: 10000, storageRef: 'recordings/ns_test/rec_idx.mp4',
      size: 256, createdAt: new Date().toISOString(),
    }, 'ns_test');

    await processTranscriptionJob(
      {
        recordingId: 'rec_idx', namespace: 'ns_test',
        audioRef: 'recordings/ns_test/rec_idx.mp4',
        asrProvider: 'whisper', language: 'en-US',
      },
      { store, logger, asrRegistry: registry, searchClient },
    );

    const results = searchClient.search('action items');
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]?.document?.text).toContain('Action items');
  });
});

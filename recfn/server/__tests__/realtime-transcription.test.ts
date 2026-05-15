import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  RealtimeTranscriptionPipeline,
  assertRealtimeTranscriptionSupported,
  getRealtimeTranscriptionMatrix,
} from '../src/transcription/realtime.js';
import type { AsrAdapter, AudioChunk, Segment } from '@recfn/core';
import type { TranscriptStreamManager } from '../src/ws/transcript-stream.js';
import type { Logger } from '../src/integrations/logfn.js';

describe('RealtimeTranscriptionPipeline', () => {
  let streamManager: TranscriptStreamManager;
  let logger: Logger;
  let asrAdapter: AsrAdapter;
  let pipeline: RealtimeTranscriptionPipeline;

  beforeEach(() => {
    streamManager = {
      broadcast: vi.fn(),
    } as unknown as TranscriptStreamManager;

    logger = {
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
    } as unknown as Logger;

    asrAdapter = {
      name: 'test-asr',
      transcribeStream: vi.fn(),
      transcribeBatch: vi.fn(),
      supportedLanguages: vi.fn(),
    } as AsrAdapter;

    pipeline = new RealtimeTranscriptionPipeline({
      asrAdapter,
      streamManager,
      logger,
    });
  });

  it('transcribes stream and broadcasts segments', async () => {
    const audioStream = new ReadableStream<AudioChunk>({
      start(controller) {
        controller.enqueue({
          data: new Uint8Array([1, 2, 3]),
          timestamp: 0,
          sampleRate: 48000,
          channels: 1,
        });
        controller.close();
      },
    });
    
    const mockSegments: Segment[] = [
      { speakerId: 's1', startTime: 0, endTime: 1000, text: 'Hello', confidence: 0.9 },
      { speakerId: 's2', startTime: 1000, endTime: 2000, text: 'World', confidence: 0.8 },
    ];

    async function* generateSegments() {
      for (const seg of mockSegments) {
        yield seg;
      }
    }

    vi.mocked(asrAdapter.transcribeStream).mockReturnValue(generateSegments());

    await pipeline.start('bot_realtime', audioStream, {
      platform: 'meet',
      asrProvider: 'deepgram',
    });

    expect(asrAdapter.transcribeStream).toHaveBeenCalledTimes(1);
    expect(vi.mocked(asrAdapter.transcribeStream).mock.calls[0]?.[1]).toEqual({
      language: 'en',
      speakerDiarization: true,
    });
    expect(streamManager.broadcast).toHaveBeenCalledTimes(2);
    expect(streamManager.broadcast).toHaveBeenNthCalledWith(1, 'bot_realtime', 'segment', mockSegments[0]);
    expect(streamManager.broadcast).toHaveBeenNthCalledWith(2, 'bot_realtime', 'segment', mockSegments[1]);
  });

  it('handles abort correctly', async () => {
    const audioStream = new ReadableStream<AudioChunk>();
    
    async function* generateSegments() {
      yield { speakerId: 's1', startTime: 0, endTime: 1000, text: 'First', confidence: 0.9 };
      // simulate delay to allow abort to take effect
      await new Promise(r => setTimeout(r, 50));
      yield { speakerId: 's1', startTime: 1000, endTime: 2000, text: 'Second', confidence: 0.9 };
    }

    vi.mocked(asrAdapter.transcribeStream).mockReturnValue(generateSegments());

    const startPromise = pipeline.start('bot_abort', audioStream, {
      platform: 'zoom',
      asrProvider: 'deepgram',
    });
    
    // allow first segment to yield
    await new Promise(r => setTimeout(r, 10));
    pipeline.stop('bot_abort');
    
    await startPromise;

    expect(streamManager.broadcast).toHaveBeenCalledTimes(1); // Only the first one should be broadcasted before abort takes effect in next iteration
  });

  it('handles ASR errors and broadcasts error frame', async () => {
    const audioStream = new ReadableStream<AudioChunk>();

    async function* generateSegments() {
      throw new Error('ASR failure');
      yield { speakerId: 's1', startTime: 0, endTime: 1000, text: 'Never', confidence: 0.9 };
    }

    vi.mocked(asrAdapter.transcribeStream).mockReturnValue(generateSegments());

    await pipeline.start('bot_error', audioStream, {
      platform: 'zoom',
      asrProvider: 'deepgram',
    });

    expect(streamManager.broadcast).toHaveBeenCalledWith('bot_error', 'error', {
      code: 'ASR_ERROR',
      message: 'Real-time transcription failed.'
    });
    expect(logger.error).toHaveBeenCalled();
  });

  it('rejects unsupported real-time provider combinations before work starts', () => {
    expect(() =>
      assertRealtimeTranscriptionSupported('meet', 'assemblyai'),
    ).toThrow('Real-time transcription is not supported for meet with assemblyai.');
  });

  it('publishes the supported real-time matrix', () => {
    expect(getRealtimeTranscriptionMatrix()).toEqual({
      zoom: ['deepgram'],
      meet: ['deepgram'],
      teams: ['deepgram'],
      desktop: [],
    });
  });
});

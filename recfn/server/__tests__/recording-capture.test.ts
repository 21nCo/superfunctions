import { describe, it, expect } from 'vitest';
import {
  assertCaptureHasData,
  captureFromStream,
} from '../src/recording/capture.js';
import {
  ErrorCode,
  createError,
  type AudioChunk,
} from 'recfn';

function createAudioStream(chunks: AudioChunk[]): ReadableStream<AudioChunk> {
  return new ReadableStream<AudioChunk>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk);
      }
      controller.close();
    },
  });
}

describe('captureFromStream', () => {
  it('captures audio chunks and produces a CaptureResult (TV-REC-001)', async () => {
    const chunks: AudioChunk[] = [
      { data: new Uint8Array([1, 2, 3]), timestamp: 1000, sampleRate: 48000, channels: 1 },
      { data: new Uint8Array([4, 5, 6]), timestamp: 2000, sampleRate: 48000, channels: 1 },
      { data: new Uint8Array([7, 8, 9]), timestamp: 3000, sampleRate: 48000, channels: 1 },
    ];
    const stream = createAudioStream(chunks);

    const result = await captureFromStream(stream, { recordingFormat: 'mp4' });

    expect(result.format).toBe('mp4');
    expect(result.duration).toBe(2000); // 3000 - 1000
    expect(result.size).toBe(9);
    expect(result.data).toEqual(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]));
  });

  it('produces wav format for audio_only', async () => {
    const chunks: AudioChunk[] = [
      { data: new Uint8Array([10, 20]), timestamp: 0, sampleRate: 44100, channels: 2 },
      { data: new Uint8Array([30, 40]), timestamp: 500, sampleRate: 44100, channels: 2 },
    ];
    const stream = createAudioStream(chunks);

    const result = await captureFromStream(stream, { recordingFormat: 'audio_only' });

    expect(result.format).toBe('wav');
    expect(result.duration).toBe(500);
    expect(result.size).toBe(4);
  });

  it('handles empty stream', async () => {
    const stream = createAudioStream([]);

    const result = await captureFromStream(stream, { recordingFormat: 'mp4' });

    expect(result.format).toBe('mp4');
    expect(result.duration).toBe(0);
    expect(result.size).toBe(0);
    expect(result.data).toEqual(new Uint8Array([]));
  });

  it('handles single-chunk stream', async () => {
    const chunks: AudioChunk[] = [
      { data: new Uint8Array([1, 2, 3, 4, 5]), timestamp: 5000, sampleRate: 48000, channels: 1 },
    ];
    const stream = createAudioStream(chunks);

    const result = await captureFromStream(stream, { recordingFormat: 'mp4' });

    expect(result.duration).toBe(0); // single chunk: same first/last timestamp
    expect(result.size).toBe(5);
  });

  it('rejects empty captured media for finalization', async () => {
    const stream = createAudioStream([]);
    const result = await captureFromStream(stream, { recordingFormat: 'mp4' });

    expect(() => assertCaptureHasData(result)).toThrow(
      'Captured recording stream was empty.',
    );
  });

  it('preserves capture prerequisite failures from platform streams', async () => {
    const stream = new ReadableStream<AudioChunk>({
      start(controller) {
        controller.error(
          createError(
            ErrorCode.PLATFORM_CAPTURE_UNAVAILABLE,
            'Meet audio capture requires display-media capture support in this browser runtime.',
          ),
        );
      },
    });

    await expect(
      captureFromStream(stream, { recordingFormat: 'mp4' }),
    ).rejects.toMatchObject({
      code: ErrorCode.PLATFORM_CAPTURE_UNAVAILABLE,
    });
  });

  it('preserves Teams capture prerequisite failures from platform streams', async () => {
    const stream = new ReadableStream<AudioChunk>({
      start(controller) {
        controller.error(
          createError(
            ErrorCode.PLATFORM_CAPTURE_UNAVAILABLE,
            'Teams audio capture requires display-media capture support in this browser runtime.',
          ),
        );
      },
    });

    await expect(
      captureFromStream(stream, { recordingFormat: 'mp4' }),
    ).rejects.toMatchObject({
      code: ErrorCode.PLATFORM_CAPTURE_UNAVAILABLE,
    });
  });
});

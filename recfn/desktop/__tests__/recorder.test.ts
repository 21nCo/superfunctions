import { describe, it, expect, vi } from 'vitest';
import {
  recordStreamsWithMock,
  createMockRecorder,
  type CaptureStreams,
  type RecorderOptions,
} from '../src/recorder.js';

describe('recorder', () => {
  it('recordStreamsWithMock returns mock result', async () => {
    const mockResult = {
      data: new Uint8Array([1, 2, 3]),
      format: 'mp4' as const,
      duration: 5.5,
      size: 3,
    };
    const mock = createMockRecorder(mockResult);
    const streams: CaptureStreams = {
      video: new MediaStream(),
      audio: new MediaStream(),
    };
    const result = await recordStreamsWithMock(mock, streams);
    expect(result.data).toEqual(mockResult.data);
    expect(result.format).toBe('mp4');
    expect(result.duration).toBe(5.5);
    expect(result.size).toBe(3);
  });

  it('createMockRecorder ignores options', async () => {
    const mock = createMockRecorder({
      data: new Uint8Array([]),
      format: 'wav',
      duration: 0,
      size: 0,
    });
    const result = await mock.record(
      { video: new MediaStream(), audio: new MediaStream() },
      { format: 'audio_only' },
    );
    expect(result.format).toBe('wav');
  });

  it('passes caller-controlled lifecycle options through to custom recorders (TV-DSK-001)', async () => {
    const signal = new AbortController().signal;
    const record = vi.fn().mockResolvedValue({
      data: new Uint8Array([1]),
      format: 'mp4' as const,
      duration: 45,
      size: 1,
    });
    const recorder = { record };
    const streams: CaptureStreams = {
      video: new MediaStream(),
      audio: new MediaStream(),
    };
    const options: RecorderOptions = {
      stopAfterMs: 45_000,
      signal,
    };

    const result = await recordStreamsWithMock(recorder, streams, options);

    expect(record).toHaveBeenCalledWith(streams, options);
    expect(result.duration).toBe(45);
  });
});

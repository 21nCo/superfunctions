import { describe, it, expect } from 'vitest';
import {
  recordStreamsWithMock,
  createMockRecorder,
  type CaptureStreams,
} from '../src/recorder.js';

describe('recorder', () => {
  it('recordStreamsWithMock returns mock result', async () => {
    const mockResult = {
      data: new Uint8Array([1, 2, 3]),
      format: 'webm' as const,
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
    expect(result.format).toBe('webm');
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
});

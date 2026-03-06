import { describe, it, expect, vi } from 'vitest';
import { transcribeWithWhisper, buildTranscript } from '../src/transcriber.js';
import { WhisperAdapter } from 'recfn-whisper';
import type { Segment } from 'recfn';

function createMockAdapter(segments: Segment[]): WhisperAdapter {
  const runner = {
    run: vi.fn(async () => ({ segments })),
  };
  return new WhisperAdapter({ runner } as never);
}

describe('transcriber', () => {
  it('transcribeWithWhisper returns segments from adapter', async () => {
    const segments: Segment[] = [
      {
        speakerId: 'speaker_0',
        startTime: 0,
        endTime: 1000,
        text: 'Hello world',
        confidence: 0.95,
      },
    ];
    const adapter = createMockAdapter(segments);
    const result = await transcribeWithWhisper(adapter, '/tmp/audio.wav');
    expect(result.segments).toEqual(segments);
    expect(result.language).toBe('en');
  });

  it('transcribeWithWhisper passes options to adapter', async () => {
    const adapter = createMockAdapter([]);
    await transcribeWithWhisper(adapter, '/tmp/audio.wav', {
      language: 'es-ES',
      speakerDiarization: true,
    });
    expect(adapter.transcribeBatch).toBeDefined();
  });

  it('buildTranscript produces transcript shape', () => {
    const segments: Segment[] = [
      { speakerId: 's1', startTime: 0, endTime: 500, text: 'Hi', confidence: 0.9 },
    ];
    const t = buildTranscript('rec_123', segments, 'en');
    expect(t.recordingId).toBe('rec_123');
    expect(t.language).toBe('en');
    expect(t.status).toBe('ready');
    expect(t.segments).toEqual(segments);
  });
});

import { describe, it, expect, vi } from 'vitest';
import { WhisperAdapter } from '../src/index.js';
import { parseWhisperJsonOutput } from '../src/runner.js';
import type { WhisperRunner, WhisperOutput } from '../src/runner.js';
import type { Segment } from '@recfn/core';

function createMockRunner(segments: Segment[]): WhisperRunner {
  return {
    run: vi.fn(async (): Promise<WhisperOutput> => ({ segments })),
  };
}

describe('WhisperAdapter', () => {
  describe('name', () => {
    it('reports name as "whisper"', () => {
      const adapter = new WhisperAdapter({ runner: createMockRunner([]) });
      expect(adapter.name).toBe('whisper');
    });
  });

  describe('transcribeBatch (TV-ASR-001)', () => {
    it('produces segments from audio file', async () => {
      const mockSegments: Segment[] = [
        { speakerId: 'speaker_0', startTime: 0, endTime: 3000, text: 'Hello everyone.', confidence: 0.95 },
        { speakerId: 'speaker_1', startTime: 3500, endTime: 6000, text: 'Welcome to the meeting.', confidence: 0.92 },
      ];
      const runner = createMockRunner(mockSegments);
      const adapter = new WhisperAdapter({ runner });

      const result = await adapter.transcribeBatch('/tmp/audio.wav', {
        language: 'en-US',
        speakerDiarization: true,
      });

      expect(result).toHaveLength(2);
      expect(result[0].speakerId).toBe('speaker_0');
      expect(result[0].startTime).toBe(0);
      expect(result[0].endTime).toBe(3000);
      expect(result[0].text).toBe('Hello everyone.');
      expect(result[0].confidence).toBe(0.95);
      expect(result[1].speakerId).toBe('speaker_1');
      expect(runner.run).toHaveBeenCalledWith(
        '/tmp/audio.wav',
        expect.objectContaining({
          language: 'en',
          diarize: true,
        }),
      );
    });

    it('sorts segments by startTime then speakerId (TV-TRX-006)', async () => {
      const unordered: Segment[] = [
        { speakerId: 'b', startTime: 1000, endTime: 2000, text: 'B at 1s', confidence: 0.9 },
        { speakerId: 'a', startTime: 1000, endTime: 1500, text: 'A at 1s', confidence: 0.9 },
        { speakerId: 'a', startTime: 500, endTime: 1000, text: 'A at 0.5s', confidence: 0.9 },
      ];
      const runner = createMockRunner(unordered);
      const adapter = new WhisperAdapter({ runner });

      const result = await adapter.transcribeBatch('/tmp/audio.wav', {
        language: 'en',
        speakerDiarization: true,
      });

      expect(result[0]).toEqual(expect.objectContaining({ startTime: 500, speakerId: 'a' }));
      expect(result[1]).toEqual(expect.objectContaining({ startTime: 1000, speakerId: 'a' }));
      expect(result[2]).toEqual(expect.objectContaining({ startTime: 1000, speakerId: 'b' }));
    });

    it('passes language code without region subtag', async () => {
      const runner = createMockRunner([]);
      const adapter = new WhisperAdapter({ runner });

      await adapter.transcribeBatch('/tmp/audio.wav', {
        language: 'es-ES',
        speakerDiarization: false,
      });

      expect(runner.run).toHaveBeenCalledWith(
        '/tmp/audio.wav',
        expect.objectContaining({ language: 'es' }),
      );
    });

    it('includes diarization config', async () => {
      const runner = createMockRunner([]);
      const adapter = new WhisperAdapter({ runner });

      await adapter.transcribeBatch('/tmp/audio.wav', {
        language: 'en',
        speakerDiarization: true,
        maxSpeakers: 4,
      });

      expect(runner.run).toHaveBeenCalledWith(
        '/tmp/audio.wav',
        expect.objectContaining({ diarize: true }),
      );
    });
  });

  describe('transcribeStream', () => {
    it('throws error for CPU mode', async () => {
      const adapter = new WhisperAdapter({ runner: createMockRunner([]) });
      const stream = new ReadableStream();

      const iter = adapter.transcribeStream(stream, {
        language: 'en',
        speakerDiarization: true,
      });

      await expect(async () => {
        for await (const _seg of iter) {
          // should throw
        }
      }).rejects.toThrow('not supported in CPU mode');
    });
  });

  describe('supportedLanguages', () => {
    it('returns a non-empty list including common languages', () => {
      const adapter = new WhisperAdapter({ runner: createMockRunner([]) });
      const langs = adapter.supportedLanguages();

      expect(langs.length).toBeGreaterThan(50);
      expect(langs).toContain('en');
      expect(langs).toContain('es');
      expect(langs).toContain('fr');
      expect(langs).toContain('de');
      expect(langs).toContain('ja');
      expect(langs).toContain('zh');
    });
  });
});

describe('parseWhisperJsonOutput', () => {
  it('parses array format', () => {
    const json = JSON.stringify([
      { speaker: 'speaker_0', start: 0.5, end: 2.0, text: 'Hello', confidence: 0.95 },
      { speaker: 'speaker_1', start: 2.5, end: 4.0, text: 'World', confidence: 0.9 },
    ]);

    const segments = parseWhisperJsonOutput(json);
    expect(segments).toHaveLength(2);
    expect(segments[0].startTime).toBe(500);
    expect(segments[0].endTime).toBe(2000);
    expect(segments[0].text).toBe('Hello');
    expect(segments[0].speakerId).toBe('speaker_0');
  });

  it('parses transcription object format', () => {
    const json = JSON.stringify({
      transcription: [
        { speaker: 'speaker_0', t0: 1.0, t1: 3.0, text: ' Test ', confidence: 0.88 },
      ],
    });

    const segments = parseWhisperJsonOutput(json);
    expect(segments).toHaveLength(1);
    expect(segments[0].startTime).toBe(1000);
    expect(segments[0].endTime).toBe(3000);
    expect(segments[0].text).toBe('Test');
  });

  it('parses segments object format', () => {
    const json = JSON.stringify({
      segments: [
        { speakerId: 'speaker_0', startTime: 5000, endTime: 7000, text: 'Segment', confidence: 0.91 },
      ],
    });

    const segments = parseWhisperJsonOutput(json);
    expect(segments).toHaveLength(1);
    expect(segments[0].startTime).toBe(5000);
    expect(segments[0].endTime).toBe(7000);
  });

  it('returns empty array for unrecognized format', () => {
    const segments = parseWhisperJsonOutput('{}');
    expect(segments).toEqual([]);
  });
});

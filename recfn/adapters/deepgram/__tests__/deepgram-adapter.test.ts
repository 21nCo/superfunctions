import { describe, it, expect, vi } from 'vitest';
import { DeepgramAdapter } from '../src/index.js';
import type { Segment } from 'recfn';

function createMockFetch(response: unknown) {
  return vi.fn().mockResolvedValue({
    ok: true,
    json: () => Promise.resolve(response),
    text: () => Promise.resolve(''),
  });
}

describe('DeepgramAdapter', () => {
  it('reports name as "deepgram"', () => {
    const adapter = new DeepgramAdapter({
      apiKey: 'test',
      fetch: createMockFetch({}),
    });
    expect(adapter.name).toBe('deepgram');
  });

  describe('transcribeBatch (TV-ASR-002)', () => {
    it('produces segments from API response', async () => {
      const mockResponse = {
        results: {
          channels: [
            {
              alternatives: [
                {
                  words: [
                    { word: 'Hello', start: 0, end: 0.5, confidence: 0.95, speaker: 0 },
                    { word: 'everyone', start: 0.5, end: 1.0, confidence: 0.93, speaker: 0 },
                    { word: 'Welcome', start: 1.5, end: 2.0, confidence: 0.92, speaker: 1 },
                  ],
                },
              ],
            },
          ],
        },
      };

      const fetchMock = createMockFetch(mockResponse);
      const adapter = new DeepgramAdapter({ apiKey: 'test', fetch: fetchMock });

      const result = await adapter.transcribeBatch('https://example.com/audio.wav', {
        language: 'en-US',
        speakerDiarization: true,
      });

      expect(result).toHaveLength(2);
      expect(result[0]?.speakerId).toBe('speaker_0');
      expect(result[0]?.text).toContain('Hello');
      expect(result[0]?.startTime).toBe(0);
      expect(result[1]?.speakerId).toBe('speaker_1');
      expect(result[1]?.text).toBe('Welcome');
    });

    it('throws on API error', async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        text: () => Promise.resolve('Invalid API key'),
      });
      const adapter = new DeepgramAdapter({ apiKey: 'invalid', fetch: fetchMock });

      await expect(
        adapter.transcribeBatch('https://example.com/audio.wav', {
          language: 'en',
          speakerDiarization: false,
        }),
      ).rejects.toThrow('Deepgram API error');
    });
  });

  describe('transcribeStream', () => {
    it('yields segments from streamed audio', async () => {
      const mockResponse = {
        results: {
          channels: [
            {
              alternatives: [
                {
                  words: [
                    { word: 'Hello', start: 0, end: 0.5, confidence: 0.9, speaker: 0 },
                  ],
                },
              ],
            },
          ],
        },
      };

      const fetchMock = createMockFetch(mockResponse);
      const adapter = new DeepgramAdapter({ apiKey: 'test', fetch: fetchMock });

      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array([0, 1, 2]));
          controller.close();
        },
      });

      const segments: Segment[] = [];
      for await (const seg of adapter.transcribeStream(stream, {
        language: 'en',
        speakerDiarization: true,
      })) {
        segments.push(seg);
      }

      expect(segments).toHaveLength(1);
      expect(segments[0]?.text).toBe('Hello');
    });
  });

  describe('supportedLanguages', () => {
    it('returns supported languages', () => {
      const adapter = new DeepgramAdapter({ apiKey: 'test', fetch: createMockFetch({}) });
      const langs = adapter.supportedLanguages();
      expect(langs).toContain('en');
      expect(langs).toContain('es');
      expect(langs.length).toBeGreaterThan(10);
    });
  });
});

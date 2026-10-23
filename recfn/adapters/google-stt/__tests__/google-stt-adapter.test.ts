import { describe, it, expect, vi } from 'vitest';
import { GoogleSttAdapter } from '../src/index.js';

function createMockFetch(response: unknown) {
  return vi.fn().mockImplementation(async (url: string) => {
    if (url.includes('example.com')) {
      return { ok: true, arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)) };
    }
    return {
      ok: true,
      json: () => Promise.resolve(response),
      text: () => Promise.resolve(''),
    };
  });
}

describe('GoogleSttAdapter', () => {
  it('reports name as "google-stt"', () => {
    const adapter = new GoogleSttAdapter({
      apiKey: 'test',
      fetch: createMockFetch({}),
    });
    expect(adapter.name).toBe('google-stt');
  });

  describe('transcribeBatch (TV-ASR-004)', () => {
    it('produces segments from API response', async () => {
      const mockResponse = {
        results: [
          {
            alternatives: [
              {
                words: [
                  {
                    word: 'Hello',
                    startTime: { seconds: '0', nanos: 0 },
                    endTime: { seconds: '0', nanos: 500000000 },
                    speakerTag: 1,
                  },
                  {
                    word: 'everyone',
                    startTime: { seconds: '0', nanos: 500000000 },
                    endTime: { seconds: '1', nanos: 0 },
                    speakerTag: 1,
                  },
                  {
                    word: 'Welcome',
                    startTime: { seconds: '1', nanos: 500000000 },
                    endTime: { seconds: '2', nanos: 0 },
                    speakerTag: 2,
                  },
                ],
              },
            ],
          },
        ],
      };

      const fetchMock = createMockFetch(mockResponse);
      const adapter = new GoogleSttAdapter({ apiKey: 'test', fetch: fetchMock });

      const result = await adapter.transcribeBatch('https://example.com/audio.raw', {
        language: 'en-US',
        speakerDiarization: true,
      });

      expect(result).toHaveLength(2);
      expect(result[0]?.speakerId).toBe('speaker_1');
      expect(result[0]?.text).toContain('Hello');
      expect(result[1]?.speakerId).toBe('speaker_2');
      expect(result[1]?.text).toBe('Welcome');
    });

    it('throws on API error', async () => {
      const fetchMock = vi.fn().mockImplementation(async (url: string) => {
        if (url.includes('example.com')) {
          return { ok: true, arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)) };
        }
        return {
          ok: false,
          status: 401,
          text: () => Promise.resolve('Invalid credentials'),
        };
      });
      const adapter = new GoogleSttAdapter({ apiKey: 'invalid', fetch: fetchMock });

      await expect(
        adapter.transcribeBatch('https://example.com/audio.raw', {
          language: 'en',
          speakerDiarization: false,
        }),
      ).rejects.toThrow('Google STT');
    });
  });

  describe('supportedLanguages', () => {
    it('returns supported languages', () => {
      const adapter = new GoogleSttAdapter({ apiKey: 'test', fetch: createMockFetch({}) });
      const langs = adapter.supportedLanguages();
      expect(langs).toContain('en');
      expect(langs).toContain('es');
    });
  });
});

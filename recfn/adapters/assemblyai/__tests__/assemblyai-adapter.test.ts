import { describe, it, expect, vi } from 'vitest';
import { AssemblyAIAdapter } from '../src/index.js';
import type { Segment } from 'recfn';

function createMockFetch(responses: unknown[]) {
  let callCount = 0;
  return vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
    const idx = Math.min(callCount++, responses.length - 1);
    const res = responses[idx] ?? responses[responses.length - 1];
    if (typeof res === 'function') return (res as (url: string, init?: RequestInit) => Promise<Response>)(url, init);
    return {
      ok: true,
      json: () => Promise.resolve(res),
      text: () => Promise.resolve(''),
    };
  });
}

describe('AssemblyAIAdapter', () => {
  it('reports name as "assemblyai"', () => {
    const adapter = new AssemblyAIAdapter({
      apiKey: 'test',
      fetch: createMockFetch([{}]),
    });
    expect(adapter.name).toBe('assemblyai');
  });

  describe('transcribeBatch (TV-ASR-003)', () => {
    it('produces segments from API response', async () => {
      const mockResponses = [
        { id: 'tx_123' },
        {
          status: 'completed',
          utterances: [
            { speaker: 'A', text: 'Hello everyone.', start: 0, end: 2000 },
            { speaker: 'B', text: 'Welcome to the meeting.', start: 2500, end: 5000 },
          ],
        },
      ];

      const fetchMock = createMockFetch(mockResponses);
      const adapter = new AssemblyAIAdapter({ apiKey: 'test', fetch: fetchMock });

      const result = await adapter.transcribeBatch('https://example.com/audio.wav', {
        language: 'en-US',
        speakerDiarization: true,
      });

      expect(result).toHaveLength(2);
      expect(result[0]?.speakerId).toBe('speaker_A');
      expect(result[0]?.text).toBe('Hello everyone.');
      expect(result[1]?.speakerId).toBe('speaker_B');
      expect(result[1]?.text).toBe('Welcome to the meeting.');
    });

    it('throws on API error', async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
      });
      const adapter = new AssemblyAIAdapter({ apiKey: 'invalid', fetch: fetchMock });

      await expect(
        adapter.transcribeBatch('https://example.com/audio.wav', {
          language: 'en',
          speakerDiarization: false,
        }),
      ).rejects.toThrow('AssemblyAI');
    });
  });

  describe('supportedLanguages', () => {
    it('returns supported languages', () => {
      const adapter = new AssemblyAIAdapter({ apiKey: 'test', fetch: createMockFetch([{}]) });
      const langs = adapter.supportedLanguages();
      expect(langs).toContain('en');
      expect(langs).toContain('es');
    });
  });
});

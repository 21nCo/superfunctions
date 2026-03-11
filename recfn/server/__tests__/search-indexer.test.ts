import { describe, it, expect } from 'vitest';
import { createSearchFnClient } from '../src/integrations/searchfn.js';
import { indexTranscript } from '../src/search/indexer.js';

describe('search indexer', () => {
  it('indexes transcript segments (TV-SRCH-001)', async () => {
    const searchClient = createSearchFnClient();

    await indexTranscript(
      {
        recordingId: 'rec_xyz789',
        botId: 'bot_abc123',
        segments: [
          { speakerId: 'participant_1', startTime: 45000, endTime: 48000, text: 'Let me summarize the action items.', confidence: 0.94 },
          { speakerId: 'participant_2', startTime: 50000, endTime: 52000, text: 'Sounds good.', confidence: 0.93 },
        ],
      },
      searchClient,
    );

    const results = await searchClient.search('action items', { limit: 5 });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]?.document?.text).toContain('action items');
    expect(results[0]?.document?.recordingId).toBe('rec_xyz789');
    expect(results[0]?.document?.botId).toBe('bot_abc123');
  });

  it('re-indexing replaces segments for same recording', async () => {
    const searchClient = createSearchFnClient();

    await indexTranscript(
      { recordingId: 'rec_1', botId: 'bot_1', segments: [{ speakerId: 'a', startTime: 0, endTime: 1000, text: 'first version', confidence: 0.9 }] },
      searchClient,
    );

    await indexTranscript(
      { recordingId: 'rec_1', botId: 'bot_1', segments: [{ speakerId: 'a', startTime: 0, endTime: 1000, text: 'second version', confidence: 0.9 }] },
      searchClient,
    );

    const results = await searchClient.search('first');
    expect(results.length).toBe(0);

    const results2 = await searchClient.search('second');
    expect(results2.length).toBe(1);
  });
});

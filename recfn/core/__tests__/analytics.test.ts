import { describe, it, expect } from 'vitest';
import {
  computeTalkTime,
  computeSilencePercentage,
  computeTopicSegments,
  computeAnalytics,
} from '../src/analytics/index.js';
import type { Segment } from '../src/types.js';

describe('analytics', () => {
  describe('computeTalkTime', () => {
    it('sums duration per speaker (TV-ANA-001)', () => {
      const segments: Segment[] = [
        { speakerId: 'participant_1', startTime: 0, endTime: 60000, text: 'Hello', confidence: 0.9 },
        { speakerId: 'participant_2', startTime: 60000, endTime: 90000, text: 'Hi', confidence: 0.9 },
      ];
      const talkTime = computeTalkTime(segments);
      expect(talkTime.participant_1).toBe(60000);
      expect(talkTime.participant_2).toBe(30000);
    });

    it('handles multiple segments from same speaker', () => {
      const segments: Segment[] = [
        { speakerId: 'a', startTime: 0, endTime: 1000, text: 'A', confidence: 0.9 },
        { speakerId: 'a', startTime: 2000, endTime: 3000, text: 'B', confidence: 0.9 },
      ];
      const talkTime = computeTalkTime(segments);
      expect(talkTime.a).toBe(2000);
    });
  });

  describe('computeSilencePercentage', () => {
    it('computes silence from total duration minus covered time (TV-ANA-002)', () => {
      const segments: Segment[] = [
        { speakerId: 'a', startTime: 0, endTime: 60000, text: 'A', confidence: 0.9 },
        { speakerId: 'b', startTime: 60000, endTime: 90000, text: 'B', confidence: 0.9 },
      ];
      const totalDuration = 120000;
      const silence = computeSilencePercentage(segments, totalDuration);
      expect(silence).toBe(0.25);
    });

    it('merges overlapping segments', () => {
      const segments: Segment[] = [
        { speakerId: 'a', startTime: 0, endTime: 5000, text: 'A', confidence: 0.9 },
        { speakerId: 'b', startTime: 3000, endTime: 7000, text: 'B', confidence: 0.9 },
      ];
      const totalDuration = 10000;
      const silence = computeSilencePercentage(segments, totalDuration);
      expect(silence).toBe(0.3);
    });
  });

  describe('computeTopicSegments', () => {
    it('returns empty for short transcripts (TV-ANA-003 negative)', () => {
      const segments: Segment[] = [
        { speakerId: 'a', startTime: 0, endTime: 5000, text: 'Short', confidence: 0.9 },
      ];
      const topics = computeTopicSegments(segments, 5000);
      expect(topics).toEqual([]);
    });

    it('produces topic segments with keywords for longer transcripts', () => {
      const segments: Segment[] = [
        { speakerId: 'a', startTime: 0, endTime: 10000, text: 'Budget discussion and costs', confidence: 0.9 },
        { speakerId: 'b', startTime: 10000, endTime: 20000, text: 'Timeline and deadlines', confidence: 0.9 },
        { speakerId: 'a', startTime: 20000, endTime: 30000, text: 'Next steps and action items', confidence: 0.9 },
        { speakerId: 'b', startTime: 30000, endTime: 40000, text: 'Summary of budget', confidence: 0.9 },
      ];
      const topics = computeTopicSegments(segments, 40000);
      expect(topics.length).toBeGreaterThan(0);
      expect(topics[0]).toHaveProperty('topic');
      expect(topics[0]).toHaveProperty('startTime');
      expect(topics[0]).toHaveProperty('endTime');
      expect(topics[0]).toHaveProperty('keywords');
    });
  });

  describe('computeAnalytics', () => {
    it('combines talk time, silence, and topics (TV-ANA-001)', () => {
      const segments: Segment[] = [
        { speakerId: 'participant_1', startTime: 0, endTime: 60000, text: 'Hello', confidence: 0.9 },
        { speakerId: 'participant_2', startTime: 60000, endTime: 90000, text: 'Hi', confidence: 0.9 },
      ];
      const analytics = computeAnalytics('rec_xyz789', segments, 120000);
      expect(analytics.recordingId).toBe('rec_xyz789');
      expect(analytics.totalDuration).toBe(120000);
      expect(analytics.talkTime.participant_1).toBe(60000);
      expect(analytics.talkTime.participant_2).toBe(30000);
      expect(analytics.silencePercentage).toBe(0.25);
    });
  });
});

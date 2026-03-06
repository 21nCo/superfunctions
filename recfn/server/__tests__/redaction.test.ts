import { describe, it, expect } from 'vitest';
import {
  redactSegmentText,
  getSpeakerDisplayLabel,
} from '../src/transcription/redact.js';
import type { Participant, Segment } from 'recfn';

describe('PII redaction (TV-TRX-008, TV-EXP-003)', () => {
  const participants: Participant[] = [
    {
      id: 'participant_1',
      botId: 'bot_1',
      name: 'John Smith',
      email: 'john@example.com',
      role: 'host',
      joinedAt: '2026-02-28T14:00:00Z',
      leftAt: '2026-02-28T15:00:00Z',
      consent: 'granted',
    },
    {
      id: 'participant_2',
      botId: 'bot_1',
      name: 'Jane Doe',
      role: 'attendee',
      joinedAt: '2026-02-28T14:01:00Z',
      consent: 'unknown',
    },
  ];

  describe('redactSegmentText', () => {
    it('replaces participant names in segment text', () => {
      const segments: Segment[] = [
        {
          speakerId: 'participant_1',
          startTime: 5000,
          endTime: 7000,
          text: 'John Smith said hello.',
          confidence: 0.96,
        },
      ];
      const result = redactSegmentText(segments, participants);
      expect(result[0].text).toBe('[REDACTED] said hello.');
    });

    it('replaces participant emails in segment text', () => {
      const segments: Segment[] = [
        {
          speakerId: 'participant_1',
          startTime: 5000,
          endTime: 7000,
          text: 'Contact me at john@example.com for details.',
          confidence: 0.96,
        },
      ];
      const result = redactSegmentText(segments, participants);
      expect(result[0].text).toBe('Contact me at [REDACTED] for details.');
    });

    it('replaces multiple occurrences of names', () => {
      const segments: Segment[] = [
        {
          speakerId: 'participant_1',
          startTime: 5000,
          endTime: 7000,
          text: 'John Smith introduced John Smith to the team.',
          confidence: 0.96,
        },
      ];
      const result = redactSegmentText(segments, participants);
      expect(result[0].text).toBe('[REDACTED] introduced [REDACTED] to the team.');
    });

    it('returns unchanged segments when participants is empty', () => {
      const segments: Segment[] = [
        {
          speakerId: 'participant_1',
          startTime: 5000,
          endTime: 7000,
          text: 'John Smith said hello.',
          confidence: 0.96,
        },
      ];
      const result = redactSegmentText(segments, []);
      expect(result[0].text).toBe('John Smith said hello.');
    });

    it('preserves segment structure (startTime, endTime, speakerId, confidence)', () => {
      const segments: Segment[] = [
        {
          speakerId: 'participant_1',
          startTime: 5000,
          endTime: 7000,
          text: 'Hello',
          confidence: 0.96,
        },
      ];
      const result = redactSegmentText(segments, participants);
      expect(result[0].speakerId).toBe('participant_1');
      expect(result[0].startTime).toBe(5000);
      expect(result[0].endTime).toBe(7000);
      expect(result[0].confidence).toBe(0.96);
    });
  });

  describe('getSpeakerDisplayLabel', () => {
    it('returns participant name when not redacting', () => {
      expect(getSpeakerDisplayLabel('participant_1', participants, false)).toBe(
        'John Smith',
      );
      expect(getSpeakerDisplayLabel('participant_2', participants, false)).toBe(
        'Jane Doe',
      );
    });

    it('returns [REDACTED] when redacting and speaker is a participant', () => {
      expect(getSpeakerDisplayLabel('participant_1', participants, true)).toBe(
        '[REDACTED]',
      );
      expect(getSpeakerDisplayLabel('participant_2', participants, true)).toBe(
        '[REDACTED]',
      );
    });

    it('returns speakerId when speaker is not in participants', () => {
      expect(getSpeakerDisplayLabel('speaker_0', participants, false)).toBe(
        'speaker_0',
      );
      expect(getSpeakerDisplayLabel('speaker_0', participants, true)).toBe(
        'speaker_0',
      );
    });

    it('returns speakerId when participants is empty', () => {
      expect(getSpeakerDisplayLabel('participant_1', [], false)).toBe(
        'participant_1',
      );
    });
  });
});

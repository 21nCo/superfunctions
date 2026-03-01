import { describe, it, expect } from 'vitest';
import { toSRT } from '../src/formatters/srt.js';
import { toVTT } from '../src/formatters/vtt.js';
import { toText } from '../src/formatters/text.js';
import type { Segment } from '../src/types.js';

const SEGMENTS: Segment[] = [
  {
    speakerId: 'participant_1',
    startTime: 5000,
    endTime: 7000,
    text: "Hello everyone, let's get started.",
    confidence: 0.96,
  },
  {
    speakerId: 'participant_2',
    startTime: 7500,
    endTime: 9000,
    text: 'Sounds good. I have the agenda here.',
    confidence: 0.93,
  },
];

describe('toSRT (TV-EXP-001)', () => {
  it('produces valid SRT output with sequence numbers, timestamps, and speaker labels', () => {
    const result = toSRT(SEGMENTS);
    const expected = [
      '1',
      '00:00:05,000 --> 00:00:07,000',
      "[participant_1] Hello everyone, let's get started.",
      '',
      '2',
      '00:00:07,500 --> 00:00:09,000',
      '[participant_2] Sounds good. I have the agenda here.',
    ].join('\n');
    expect(result).toBe(expected);
  });

  it('handles timestamps > 1 hour', () => {
    const segments: Segment[] = [
      {
        speakerId: 'speaker_1',
        startTime: 3_661_500,
        endTime: 3_665_000,
        text: 'Over an hour in.',
        confidence: 0.9,
      },
    ];
    const result = toSRT(segments);
    expect(result).toContain('01:01:01,500 --> 01:01:05,000');
  });

  it('returns empty string for empty segments', () => {
    expect(toSRT([])).toBe('');
  });
});

describe('toVTT (TV-EXP-002)', () => {
  it('produces valid WebVTT output with header and <v> tags', () => {
    const result = toVTT(SEGMENTS);
    const expected = [
      'WEBVTT',
      '',
      '00:00:05.000 --> 00:00:07.000',
      "<v participant_1>Hello everyone, let's get started.",
      '',
      '00:00:07.500 --> 00:00:09.000',
      '<v participant_2>Sounds good. I have the agenda here.',
    ].join('\n');
    expect(result).toBe(expected);
  });

  it('includes WEBVTT header for empty segments', () => {
    const result = toVTT([]);
    expect(result).toBe('WEBVTT\n\n');
  });

  it('handles timestamps > 1 hour', () => {
    const segments: Segment[] = [
      {
        speakerId: 'speaker_1',
        startTime: 3_661_500,
        endTime: 3_665_000,
        text: 'Over an hour.',
        confidence: 0.9,
      },
    ];
    const result = toVTT(segments);
    expect(result).toContain('01:01:01.500 --> 01:01:05.000');
  });
});

describe('toText', () => {
  it('produces [Speaker] (HH:MM:SS): text format', () => {
    const result = toText(SEGMENTS);
    const expected = [
      "[participant_1] (00:00:05): Hello everyone, let's get started.",
      '[participant_2] (00:00:07): Sounds good. I have the agenda here.',
    ].join('\n');
    expect(result).toBe(expected);
  });

  it('returns empty string for empty segments', () => {
    expect(toText([])).toBe('');
  });

  it('handles timestamps > 1 hour', () => {
    const segments: Segment[] = [
      {
        speakerId: 'speaker_1',
        startTime: 3_661_000,
        endTime: 3_665_000,
        text: 'Over an hour.',
        confidence: 0.9,
      },
    ];
    const result = toText(segments);
    expect(result).toBe('[speaker_1] (01:01:01): Over an hour.');
  });
});

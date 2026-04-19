import type { Segment } from 'recfn';

export function normalizeSpeakerId(
  speaker: string | number | undefined | null,
  fallback = 'speaker_0',
): string {
  if (speaker === undefined || speaker === null || speaker === '') {
    return fallback;
  }
  if (typeof speaker === 'number') {
    return `speaker_${speaker}`;
  }
  if (speaker.startsWith('speaker_')) {
    return speaker;
  }
  if (/^[A-Z]$/i.test(speaker)) {
    return `speaker_${speaker}`;
  }
  return speaker;
}

export function sortSegmentsDeterministically(segments: Segment[]): Segment[] {
  return segments
    .map((segment, index) => ({ segment, index }))
    .sort((left, right) => {
      if (left.segment.startTime !== right.segment.startTime) {
        return left.segment.startTime - right.segment.startTime;
      }
      if (left.segment.speakerId !== right.segment.speakerId) {
        return left.segment.speakerId.localeCompare(right.segment.speakerId);
      }
      if (left.segment.endTime !== right.segment.endTime) {
        return left.segment.endTime - right.segment.endTime;
      }
      if (left.segment.text !== right.segment.text) {
        return left.segment.text.localeCompare(right.segment.text);
      }
      if (left.segment.confidence !== right.segment.confidence) {
        return left.segment.confidence - right.segment.confidence;
      }
      return left.index - right.index;
    })
    .map(({ segment }) => segment);
}

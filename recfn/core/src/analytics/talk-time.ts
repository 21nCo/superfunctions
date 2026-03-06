import type { Segment } from '../types.js';

/**
 * Compute talk time per speaker from transcript segments.
 * Sums (endTime - startTime) for each speakerId.
 */
export function computeTalkTime(segments: Segment[]): Record<string, number> {
  const talkTime: Record<string, number> = {};

  for (const seg of segments) {
    const duration = Math.max(0, seg.endTime - seg.startTime);
    talkTime[seg.speakerId] = (talkTime[seg.speakerId] ?? 0) + duration;
  }

  return talkTime;
}

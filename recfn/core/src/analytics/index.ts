import type { Analytics, Segment } from '../types.js';
import { computeTalkTime } from './talk-time.js';
import { computeSilencePercentage } from './silence.js';
import { computeTopicSegments } from './topics.js';

export { computeTalkTime } from './talk-time.js';
export { computeSilencePercentage } from './silence.js';
export { computeTopicSegments } from './topics.js';

/**
 * Compute full analytics from transcript segments and total duration.
 */
export function computeAnalytics(
  recordingId: string,
  segments: Segment[],
  totalDurationMs: number,
): Analytics {
  const talkTime = computeTalkTime(segments);
  const silencePercentage = computeSilencePercentage(segments, totalDurationMs);
  const topicSegments = computeTopicSegments(segments, totalDurationMs);

  return {
    recordingId,
    totalDuration: totalDurationMs,
    talkTime,
    silencePercentage,
    topicSegments: topicSegments.length > 0 ? topicSegments : undefined,
  };
}

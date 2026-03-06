import type { Segment, TopicSegment } from '../types.js';

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
  'of', 'with', 'by', 'from', 'as', 'is', 'was', 'are', 'were', 'been',
  'be', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would',
  'could', 'should', 'may', 'might', 'must', 'shall', 'can', 'need',
  'this', 'that', 'these', 'those', 'i', 'you', 'he', 'she', 'it',
  'we', 'they', 'what', 'which', 'who', 'when', 'where', 'why', 'how',
]);

const WINDOW_SIZE = 5;
const MIN_SEGMENTS_FOR_TOPICS = 3;
const MIN_DURATION_MS = 30_000;

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOP_WORDS.has(t));
}

function getTermFrequencies(tokens: string[]): Map<string, number> {
  const tf = new Map<string, number>();
  for (const t of tokens) {
    tf.set(t, (tf.get(t) ?? 0) + 1);
  }
  return tf;
}

/**
 * Simple keyword-frequency clustering over sliding window of segments.
 * Produces TopicSegment[] with topic label, startTime, endTime, keywords.
 * Returns empty array for short transcripts (<30s or <3 segments).
 */
export function computeTopicSegments(
  segments: Segment[],
  totalDurationMs: number,
): TopicSegment[] {
  if (
    segments.length < MIN_SEGMENTS_FOR_TOPICS ||
    totalDurationMs < MIN_DURATION_MS
  ) {
    return [];
  }

  const topics: TopicSegment[] = [];
  const windowSize = Math.min(WINDOW_SIZE, segments.length);

  for (let i = 0; i <= segments.length - windowSize; i++) {
    const window = segments.slice(i, i + windowSize);
    const allText = window.map((s) => s.text).join(' ');
    const tokens = tokenize(allText);
    const tf = getTermFrequencies(tokens);

    const keywords = Array.from(tf.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([term]) => term);

    if (keywords.length === 0) continue;

    const startTime = window[0]!.startTime;
    const endTime = window[window.length - 1]!.endTime;
    const topic = keywords[0] ?? 'general';

    topics.push({
      topic,
      startTime,
      endTime,
      keywords,
    });
  }

  return mergeAdjacentTopics(topics);
}

function mergeAdjacentTopics(topics: TopicSegment[]): TopicSegment[] {
  if (topics.length <= 1) return topics;

  const merged: TopicSegment[] = [topics[0]!];
  for (let i = 1; i < topics.length; i++) {
    const prev = merged[merged.length - 1]!;
    const curr = topics[i]!;

    if (curr.startTime - prev.endTime < 5000 && prev.topic === curr.topic) {
      merged[merged.length - 1] = {
        topic: prev.topic,
        startTime: prev.startTime,
        endTime: curr.endTime,
        keywords: [...new Set([...prev.keywords, ...curr.keywords])].slice(0, 5),
      };
    } else {
      merged.push(curr);
    }
  }
  return merged;
}

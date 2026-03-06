import type { Segment } from '../types.js';

/**
 * Compute silence percentage.
 * silence = (totalDuration - sum of covered time) / totalDuration.
 * Handles overlapping segments by merging intervals.
 */
export function computeSilencePercentage(
  segments: Segment[],
  totalDurationMs: number,
): number {
  if (totalDurationMs <= 0) return 0;

  const merged = mergeOverlappingIntervals(
    segments.map((s) => [s.startTime, s.endTime] as [number, number]),
  );

  const coveredMs = merged.reduce((sum, [start, end]) => sum + (end - start), 0);
  const silenceMs = Math.max(0, totalDurationMs - coveredMs);
  return silenceMs / totalDurationMs;
}

function mergeOverlappingIntervals(
  intervals: [number, number][],
): [number, number][] {
  if (intervals.length === 0) return [];

  const sorted = [...intervals].sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [sorted[0]!];

  for (let i = 1; i < sorted.length; i++) {
    const [aStart, aEnd] = merged[merged.length - 1]!;
    const [bStart, bEnd] = sorted[i]!;

    if (bStart <= aEnd) {
      merged[merged.length - 1] = [aStart, Math.max(aEnd, bEnd)];
    } else {
      merged.push([bStart, bEnd]);
    }
  }

  return merged;
}

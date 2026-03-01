import type { Segment } from '../types.js';

function formatTextTimestamp(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  return (
    String(hours).padStart(2, '0') +
    ':' +
    String(minutes).padStart(2, '0') +
    ':' +
    String(seconds).padStart(2, '0')
  );
}

export function toText(segments: Segment[]): string {
  return segments
    .map((seg) => {
      const ts = formatTextTimestamp(seg.startTime);
      return `[${seg.speakerId}] (${ts}): ${seg.text}`;
    })
    .join('\n');
}

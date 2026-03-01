import type { Segment } from '../types.js';

function formatSrtTimestamp(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const milliseconds = ms % 1000;

  return (
    String(hours).padStart(2, '0') +
    ':' +
    String(minutes).padStart(2, '0') +
    ':' +
    String(seconds).padStart(2, '0') +
    ',' +
    String(milliseconds).padStart(3, '0')
  );
}

export function toSRT(segments: Segment[]): string {
  return segments
    .map((seg, i) => {
      const seq = i + 1;
      const start = formatSrtTimestamp(seg.startTime);
      const end = formatSrtTimestamp(seg.endTime);
      return `${seq}\n${start} --> ${end}\n[${seg.speakerId}] ${seg.text}`;
    })
    .join('\n\n');
}

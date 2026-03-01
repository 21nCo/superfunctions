import type { Segment } from '../types.js';

function formatVttTimestamp(ms: number): string {
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
    '.' +
    String(milliseconds).padStart(3, '0')
  );
}

export function toVTT(segments: Segment[]): string {
  const cues = segments
    .map((seg) => {
      const start = formatVttTimestamp(seg.startTime);
      const end = formatVttTimestamp(seg.endTime);
      return `${start} --> ${end}\n<v ${seg.speakerId}>${seg.text}`;
    })
    .join('\n\n');

  return `WEBVTT\n\n${cues}`;
}

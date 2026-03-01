import type { AudioChunk, RecordingFormat } from 'recfn';

export interface CaptureResult {
  data: Uint8Array;
  format: RecordingFormat;
  duration: number;
  size: number;
}

export interface CaptureOptions {
  recordingFormat: 'mp4' | 'audio_only';
}

export async function captureFromStream(
  stream: ReadableStream<AudioChunk>,
  options: CaptureOptions,
): Promise<CaptureResult> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let firstTimestamp: number | null = null;
  let lastTimestamp = 0;

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      if (firstTimestamp === null) {
        firstTimestamp = value.timestamp;
      }
      lastTimestamp = value.timestamp;
      chunks.push(value.data);
    }
  } finally {
    reader.releaseLock();
  }

  const totalSize = chunks.reduce((sum, c) => sum + c.byteLength, 0);
  const combined = new Uint8Array(totalSize);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }

  const duration = firstTimestamp !== null ? lastTimestamp - firstTimestamp : 0;
  const format: RecordingFormat =
    options.recordingFormat === 'audio_only' ? 'wav' : 'mp4';

  return {
    data: combined,
    format,
    duration,
    size: combined.byteLength,
  };
}

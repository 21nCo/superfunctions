/**
 * Media recorder — pipe captured streams to file (MP4 or audio-only).
 * Uses MediaRecorder when available (browser/Electron).
 * For Node tests, use recordStreamsWithMock.
 */

import type { RecordingFormat } from 'recfn';
import type { CaptureStreams } from './capture.js';

export interface RecorderOptions {
  format?: 'mp4' | 'audio_only';
  mimeType?: string;
  videoBitsPerSecond?: number;
  audioBitsPerSecond?: number;
}

export interface RecorderResult {
  data: Uint8Array;
  format: RecordingFormat;
  duration: number;
  size: number;
}

export interface StreamRecorder {
  record(streams: CaptureStreams, options?: RecorderOptions): Promise<RecorderResult>;
}

/**
 * Record streams to a blob, then return as Uint8Array.
 * Requires MediaRecorder (browser/Electron renderer).
 */
export async function recordStreams(
  streams: CaptureStreams,
  options: RecorderOptions = {},
): Promise<RecorderResult> {
  if (typeof MediaRecorder === 'undefined') {
    throw new Error(
      'MediaRecorder is not available. Use recordStreamsWithMock for Node tests.',
    );
  }

  const format = options.format ?? 'mp4';
  const outputFormat: RecordingFormat = format === 'audio_only' ? 'wav' : 'mp4';

  const stream = streams.audio
    ? (() => {
        const combined = new MediaStream();
        const vidTrack = streams.video.getTracks()[0];
        const audTrack = streams.audio.getTracks()[0];
        if (vidTrack) combined.addTrack(vidTrack);
        if (audTrack) combined.addTrack(audTrack);
        return combined;
      })()
    : streams.video;

  const mimeType =
    options.mimeType ??
    (format === 'audio_only' ? 'audio/webm' : 'video/webm;codecs=vp9,opus');

  const recorder = new MediaRecorder(stream, {
    mimeType,
    videoBitsPerSecond: options.videoBitsPerSecond ?? 2_500_000,
    audioBitsPerSecond: options.audioBitsPerSecond ?? 128_000,
  });

  const chunks: Blob[] = [];
  recorder.ondataavailable = (e) => {
    if (e.data.size > 0) chunks.push(e.data);
  };

  const startTime = Date.now();
  recorder.start(1000);

  await new Promise<void>((resolve, reject) => {
    recorder.onstop = () => resolve();
    recorder.onerror = () => reject(new Error('MediaRecorder error'));
    setTimeout(() => recorder.stop(), 2000);
  });

  const duration = (Date.now() - startTime) / 1000;
  const blob = new Blob(chunks, { type: mimeType });
  const buffer = await blob.arrayBuffer();
  const data = new Uint8Array(buffer);

  return {
    data,
    format: outputFormat,
    duration,
    size: data.byteLength,
  };
}

/**
 * Record using a custom recorder (e.g. mock for tests).
 */
export async function recordStreamsWithMock(
  recorder: StreamRecorder,
  streams: CaptureStreams,
  options?: RecorderOptions,
): Promise<RecorderResult> {
  return recorder.record(streams, options);
}

/**
 * Create a mock recorder for Node tests.
 */
export function createMockRecorder(result: RecorderResult): StreamRecorder {
  return {
    async record() {
      return result;
    },
  };
}

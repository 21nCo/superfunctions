/**
 * Local Whisper transcription wrapper.
 * Invokes Whisper ASR adapter on captured audio file.
 */

import type { Segment, Transcript } from 'recfn';
import type { WhisperAdapter } from 'recfn-whisper';

export interface TranscriberOptions {
  language?: string;
  speakerDiarization?: boolean;
}

export interface TranscriberResult {
  segments: Segment[];
  language: string;
}

/**
 * Transcribe an audio file using Whisper adapter.
 * Returns transcript segments.
 */
export async function transcribeWithWhisper(
  adapter: WhisperAdapter,
  audioPath: string,
  options: TranscriberOptions = {},
): Promise<TranscriberResult> {
  const segments = await adapter.transcribeBatch(audioPath, {
    language: options.language ?? 'en-US',
    speakerDiarization: options.speakerDiarization ?? false,
  });

  return {
    segments,
    language: options.language ?? 'en',
  };
}

/**
 * Build a Transcript object from segments.
 */
export function buildTranscript(
  recordingId: string,
  segments: Segment[],
  language: string,
): Omit<Transcript, 'id' | 'createdAt'> {
  return {
    recordingId,
    language,
    status: 'ready',
    segments,
  };
}

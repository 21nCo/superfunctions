import type { Segment } from '../types.js';

export interface AsrOpts {
  language: string;
  speakerDiarization: boolean;
  maxSpeakers?: number;
}

export interface AsrAdapter {
  readonly name: string;
  transcribeStream(
    audio: ReadableStream,
    opts: AsrOpts,
  ): AsyncIterable<Segment>;
  transcribeBatch(audioRef: string, opts: AsrOpts): Promise<Segment[]>;
  supportedLanguages(): string[];
}

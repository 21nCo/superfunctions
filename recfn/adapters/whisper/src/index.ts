import type { AsrAdapter, AsrOpts } from '@recfn/core';
import type { Segment } from '@recfn/core';
import type { WhisperRunner, WhisperRunnerConfig } from './runner.js';
import { createChildProcessRunner } from './runner.js';

export { parseWhisperJsonOutput, createChildProcessRunner } from './runner.js';
export type { WhisperRunner, WhisperRunnerConfig, WhisperOutput } from './runner.js';

export interface WhisperAdapterConfig {
  runner?: WhisperRunner;
  modelPath?: string;
  binaryPath?: string;
  threads?: number;
}

const SUPPORTED_LANGUAGES = [
  'en', 'zh', 'de', 'es', 'ru', 'ko', 'fr', 'ja', 'pt', 'tr',
  'pl', 'ca', 'nl', 'ar', 'sv', 'it', 'id', 'hi', 'fi', 'vi',
  'he', 'uk', 'el', 'ms', 'cs', 'ro', 'da', 'hu', 'ta', 'no',
  'th', 'ur', 'hr', 'bg', 'lt', 'la', 'mi', 'ml', 'cy', 'sk',
  'te', 'fa', 'lv', 'bn', 'sr', 'az', 'sl', 'kn', 'et', 'mk',
  'br', 'eu', 'is', 'hy', 'ne', 'mn', 'bs', 'kk', 'sq', 'sw',
  'gl', 'mr', 'pa', 'si', 'km', 'sn', 'yo', 'so', 'af', 'oc',
  'ka', 'be', 'tg', 'sd', 'gu', 'am', 'yi', 'lo', 'uz', 'fo',
  'ht', 'ps', 'tk', 'nn', 'mt', 'sa', 'lb', 'my', 'bo', 'tl',
  'mg', 'as', 'tt', 'haw', 'ln', 'ha', 'ba', 'jw', 'su',
];

function sortSegments(segments: Segment[]): Segment[] {
  return [...segments].sort((a, b) => {
    if (a.startTime !== b.startTime) return a.startTime - b.startTime;
    return a.speakerId.localeCompare(b.speakerId);
  });
}

export class WhisperAdapter implements AsrAdapter {
  readonly name = 'whisper';

  private readonly runner: WhisperRunner;
  private readonly modelPath?: string;
  private readonly binaryPath?: string;
  private readonly threads?: number;

  constructor(config?: WhisperAdapterConfig) {
    this.runner = config?.runner ?? createChildProcessRunner();
    this.modelPath = config?.modelPath;
    this.binaryPath = config?.binaryPath;
    this.threads = config?.threads;
  }

  async *transcribeStream(
    _audio: ReadableStream,
    _opts: AsrOpts,
  ): AsyncIterable<Segment> {
    throw new Error(
      'Whisper streaming transcription is not supported in CPU mode. Use batch transcription instead.',
    );
  }

  async transcribeBatch(
    audioRef: string,
    opts: AsrOpts,
  ): Promise<Segment[]> {
    const runnerConfig: WhisperRunnerConfig = {
      modelPath: this.modelPath,
      binaryPath: this.binaryPath,
      threads: this.threads,
      language: extractLanguageCode(opts.language),
      diarize: opts.speakerDiarization,
    };

    const output = await this.runner.run(audioRef, runnerConfig);
    return sortSegments(output.segments);
  }

  supportedLanguages(): string[] {
    return [...SUPPORTED_LANGUAGES];
  }
}

function extractLanguageCode(language: string): string {
  // Convert "en-US" → "en", "es-ES" → "es", etc.
  return language.split('-')[0].toLowerCase();
}

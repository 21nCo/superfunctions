import type { AsrAdapter, AsrOpts } from '@recfn/core';
import type { Segment } from '@recfn/core';
import {
  fetchArrayBufferOrThrow,
  fetchJsonOrThrow,
  normalizeSpeakerId,
  readAudioChunkStream,
  sortSegmentsDeterministically,
} from '@recfn/shared-cloud';

export interface DeepgramAdapterConfig {
  apiKey: string;
  fetch?: typeof globalThis.fetch;
}

interface DeepgramWord {
  word: string;
  start: number;
  end: number;
  confidence?: number;
  speaker?: number;
}

interface DeepgramChannel {
  alternatives?: Array<{
    words?: DeepgramWord[];
    transcript?: string;
  }>;
}

interface DeepgramResponse {
  results?: {
    channels?: DeepgramChannel[];
  };
}

function extractLanguageCode(language: string): string {
  return language.split('-')[0].toLowerCase();
}

function wordsToSegments(words: DeepgramWord[], opts: AsrOpts): Segment[] {
  if (words.length === 0) return [];

  const segments: Segment[] = [];
  let currentSpeaker = normalizeSpeakerId(
    opts.speakerDiarization && words[0]?.speaker != null ? words[0].speaker : undefined,
  );
  let currentStart = words[0]!.start * 1000;
  let currentEnd = words[0]!.end * 1000;
  let currentText = words[0]!.word;
  let totalConf = words[0]?.confidence ?? 0.9;
  let currentWordCount = 1;

  for (let i = 1; i < words.length; i++) {
    const w = words[i]!;
    const speaker = normalizeSpeakerId(
      opts.speakerDiarization && w.speaker != null ? w.speaker : undefined,
    );

    if (speaker === currentSpeaker && w.start - (currentEnd / 1000) < 0.5) {
      currentEnd = w.end * 1000;
      currentText += ' ' + w.word;
      totalConf += w.confidence ?? 0.9;
      currentWordCount += 1;
    } else {
      segments.push({
        speakerId: currentSpeaker,
        startTime: Math.round(currentStart),
        endTime: Math.round(currentEnd),
        text: currentText.trim(),
        confidence: totalConf / currentWordCount,
      });
      currentSpeaker = speaker;
      currentStart = w.start * 1000;
      currentEnd = w.end * 1000;
      currentText = w.word;
      totalConf = w.confidence ?? 0.9;
      currentWordCount = 1;
    }
  }

  segments.push({
    speakerId: currentSpeaker,
    startTime: Math.round(currentStart),
    endTime: Math.round(currentEnd),
    text: currentText.trim(),
    confidence: totalConf / currentWordCount,
  });

  return segments;
}

const SUPPORTED_LANGUAGES = [
  'en', 'es', 'fr', 'de', 'it', 'ja', 'ko', 'pt', 'ru', 'zh',
  'nl', 'pl', 'tr', 'ar', 'hi', 'id', 'th', 'vi', 'sv', 'da',
];

export class DeepgramAdapter implements AsrAdapter {
  readonly name = 'deepgram';

  private readonly apiKey: string;
  private readonly fetchFn: typeof globalThis.fetch;

  constructor(config: DeepgramAdapterConfig) {
    this.apiKey = config.apiKey;
    this.fetchFn = config.fetch ?? globalThis.fetch;
  }

  async *transcribeStream(
    audio: ReadableStream<Uint8Array>,
    opts: AsrOpts,
  ): AsyncIterable<Segment> {
    const chunks = await readAudioChunkStream(
      audio as ReadableStream<Uint8Array | import('@recfn/core').AudioChunk>,
    );
    if (chunks.length === 0) {
      return;
    }

    const firstTimestamp = chunks[0]!.timestamp;
	    for (const chunk of chunks) {
	      if (chunk.data.byteLength === 0) {
	        continue;
	      }
	      const audioBuffer = new Uint8Array(chunk.data).buffer;
	      const segments = await this.transcribeFromBuffer(
	        audioBuffer,
	        opts,
	      );
      const offsetMs = Math.max(0, chunk.timestamp - firstTimestamp);
      for (const segment of segments) {
        yield {
          ...segment,
          startTime: segment.startTime + offsetMs,
          endTime: segment.endTime + offsetMs,
        };
      }
    }
  }

  async transcribeBatch(audioRef: string, opts: AsrOpts): Promise<Segment[]> {
    const lang = extractLanguageCode(opts.language);
    const url = new URL('https://api.deepgram.com/v1/listen');
    url.searchParams.set('language', lang);
    url.searchParams.set('model', 'nova-2');
    if (opts.speakerDiarization) url.searchParams.set('diarize', 'true');

    const isUrl = audioRef.startsWith('http://') || audioRef.startsWith('https://');
    if (isUrl) {
      return this.transcribeFromUrl(audioRef, opts);
    }
    const buffer = await fetchArrayBufferOrThrow(
      this.fetchFn,
      audioRef,
      'Deepgram audio fetch error',
    );
    return this.transcribeFromBuffer(buffer, opts);
  }

  private async transcribeFromUrl(url: string, opts: AsrOpts): Promise<Segment[]> {
    const lang = extractLanguageCode(opts.language);
    const apiUrl = new URL('https://api.deepgram.com/v1/listen');
    apiUrl.searchParams.set('language', lang);
    apiUrl.searchParams.set('model', 'nova-2');
    if (opts.speakerDiarization) apiUrl.searchParams.set('diarize', 'true');

    const data = await fetchJsonOrThrow<DeepgramResponse>(
      this.fetchFn,
      apiUrl.toString(),
      {
      method: 'POST',
      headers: {
        Authorization: `Token ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ url }),
      },
      'Deepgram API error',
    );
    const words = data.results?.channels?.[0]?.alternatives?.[0]?.words ?? [];
    return sortSegmentsDeterministically(wordsToSegments(words, opts));
  }

  private async transcribeFromBuffer(buffer: ArrayBuffer, opts: AsrOpts): Promise<Segment[]> {
    const lang = extractLanguageCode(opts.language);
    const url = new URL('https://api.deepgram.com/v1/listen');
    url.searchParams.set('language', lang);
    url.searchParams.set('model', 'nova-2');
    if (opts.speakerDiarization) url.searchParams.set('diarize', 'true');

    const data = await fetchJsonOrThrow<DeepgramResponse>(
      this.fetchFn,
      url.toString(),
      {
      method: 'POST',
      headers: {
        Authorization: `Token ${this.apiKey}`,
        'Content-Type': 'audio/wav',
      },
      body: buffer,
      },
      'Deepgram API error',
    );
    const words = data.results?.channels?.[0]?.alternatives?.[0]?.words ?? [];
    return sortSegmentsDeterministically(wordsToSegments(words, opts));
  }

  supportedLanguages(): string[] {
    return [...SUPPORTED_LANGUAGES];
  }
}

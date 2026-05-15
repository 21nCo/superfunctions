import type { AsrAdapter, AsrOpts } from '@recfn/core';
import type { Segment } from '@recfn/core';
import {
  fetchArrayBufferOrThrow,
  fetchJsonOrThrow,
  normalizeSpeakerId,
  pollUntil,
  readAudioChunkStream,
  sortSegmentsDeterministically,
} from '@recfn/shared-cloud';

export interface GoogleSttAdapterConfig {
  apiKey: string;
  fetch?: typeof globalThis.fetch;
}

interface GoogleSttWord {
  startTime?: { seconds?: string; nanos?: number };
  endTime?: { seconds?: string; nanos?: number };
  word: string;
  speakerTag?: number;
}

interface GoogleSttAlternative {
  transcript?: string;
  words?: GoogleSttWord[];
}

interface GoogleSttResult {
  alternatives?: GoogleSttAlternative[];
}

interface GoogleSttResponse {
  results?: GoogleSttResult[];
}

function extractLanguageCode(language: string): string {
  const code = language.split('-')[0].toLowerCase();
  const map: Record<string, string> = {
    en: 'en-US',
    es: 'es-ES',
    fr: 'fr-FR',
    de: 'de-DE',
    it: 'it-IT',
    ja: 'ja-JP',
    ko: 'ko-KR',
    pt: 'pt-BR',
    ru: 'ru-RU',
    zh: 'zh-CN',
  };
  return map[code] ?? `${code}-${code.toUpperCase()}`;
}

function parseGoogleTime(t?: { seconds?: string; nanos?: number }): number {
  if (!t) return 0;
  const sec = parseInt(t.seconds ?? '0', 10);
  const nanos = t.nanos ?? 0;
  return sec * 1000 + Math.floor(nanos / 1_000_000);
}

function wordsToSegments(words: GoogleSttWord[], opts: AsrOpts): Segment[] {
  if (words.length === 0) return [];

  const segments: Segment[] = [];
  let currentSpeaker = normalizeSpeakerId(
    opts.speakerDiarization && words[0]?.speakerTag != null
      ? words[0].speakerTag
      : undefined,
  );
  let currentStart = parseGoogleTime(words[0]!.startTime);
  let currentEnd = parseGoogleTime(words[0]!.endTime);
  let currentText = words[0]!.word;

  for (let i = 1; i < words.length; i++) {
    const w = words[i]!;
    const speaker = normalizeSpeakerId(
      opts.speakerDiarization && w.speakerTag != null ? w.speakerTag : undefined,
    );

    if (speaker === currentSpeaker) {
      currentEnd = parseGoogleTime(w.endTime);
      currentText += ' ' + w.word;
    } else {
      segments.push({
        speakerId: currentSpeaker,
        startTime: currentStart,
        endTime: currentEnd,
        text: currentText.trim(),
        confidence: 0.9,
      });
      currentSpeaker = speaker;
      currentStart = parseGoogleTime(w.startTime);
      currentEnd = parseGoogleTime(w.endTime);
      currentText = w.word;
    }
  }

  segments.push({
    speakerId: currentSpeaker,
    startTime: currentStart,
    endTime: currentEnd,
    text: currentText.trim(),
    confidence: 0.9,
  });

  return segments;
}

const SUPPORTED_LANGUAGES = [
  'en', 'es', 'fr', 'de', 'it', 'ja', 'ko', 'pt', 'ru', 'zh',
  'nl', 'pl', 'tr', 'ar', 'hi', 'id', 'th', 'vi', 'sv', 'da',
];

export class GoogleSttAdapter implements AsrAdapter {
  readonly name = 'google-stt';

  private readonly apiKey: string;
  private readonly fetchFn: typeof globalThis.fetch;

  constructor(config: GoogleSttAdapterConfig) {
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
    const combinedSize = chunks.reduce((total, chunk) => total + chunk.data.byteLength, 0);
    const combined = new Uint8Array(combinedSize);
    let offset = 0;
    for (const chunk of chunks) {
      combined.set(chunk.data, offset);
      offset += chunk.data.byteLength;
    }
    const segments = await this.transcribeFromBuffer(combined.buffer, opts);
    for (const seg of segments) {
      yield seg;
    }
  }

  async transcribeBatch(audioRef: string, opts: AsrOpts): Promise<Segment[]> {
    if (audioRef.startsWith('gs://')) {
      return this.transcribeFromUri(audioRef, opts);
    }
    const buffer = await fetchArrayBufferOrThrow(
      this.fetchFn,
      audioRef,
      'Google STT audio fetch error',
    );
    return this.transcribeFromBuffer(buffer, opts);
  }

  private async transcribeFromUri(uri: string, opts: AsrOpts): Promise<Segment[]> {
    const lang = extractLanguageCode(opts.language);
    const url = `https://speech.googleapis.com/v1/speech:longrunningrecognize?key=${this.apiKey}`;

    const data = await fetchJsonOrThrow<{ name?: string }>(
      this.fetchFn,
      url,
      {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        config: {
          encoding: 'LINEAR16',
          sampleRateHertz: 16000,
          languageCode: lang,
          enableSpeakerDiarization: opts.speakerDiarization,
        },
        audio: { uri },
      }),
      },
      'Google STT API error',
    );
    if (!data.name) throw new Error('No operation name');

    const pollData = await pollUntil(
      () =>
        fetchJsonOrThrow<{ done?: boolean; response?: GoogleSttResponse }>(
          this.fetchFn,
          `https://speech.googleapis.com/v1/${data.name}?key=${this.apiKey}`,
          {},
          'Google STT poll error',
        ),
      {
        intervalMs: 1000,
        maxAttempts: 120,
        isDone: (result) => result.done === true,
        onExhausted: () => new Error('Google STT transcription timeout'),
      },
    );

    const words =
      pollData.response?.results?.flatMap(
        (result) => result.alternatives?.[0]?.words ?? [],
      ) ?? [];
    return sortSegmentsDeterministically(wordsToSegments(words, opts));
  }

  private async transcribeFromBuffer(buffer: ArrayBuffer, opts: AsrOpts): Promise<Segment[]> {
    const lang = extractLanguageCode(opts.language);
    const base64 = Buffer.from(buffer).toString('base64');

    const data = await fetchJsonOrThrow<GoogleSttResponse>(
      this.fetchFn,
      `https://speech.googleapis.com/v1/speech:recognize?key=${this.apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          config: {
            encoding: 'LINEAR16',
            sampleRateHertz: 16000,
            languageCode: lang,
            enableSpeakerDiarization: opts.speakerDiarization,
          },
          audio: { content: base64 },
        }),
      },
      'Google STT API error',
    );
    const words = data.results?.flatMap((r) => r.alternatives?.[0]?.words ?? []) ?? [];
    return sortSegmentsDeterministically(wordsToSegments(words, opts));
  }

  supportedLanguages(): string[] {
    return [...SUPPORTED_LANGUAGES];
  }
}

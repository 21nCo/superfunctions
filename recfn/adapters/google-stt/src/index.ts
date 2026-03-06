import type { AsrAdapter, AsrOpts } from 'recfn';
import type { Segment } from 'recfn';

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
  let currentSpeaker = opts.speakerDiarization && words[0]?.speakerTag != null
    ? `speaker_${words[0].speakerTag}`
    : 'speaker_0';
  let currentStart = parseGoogleTime(words[0]!.startTime);
  let currentEnd = parseGoogleTime(words[0]!.endTime);
  let currentText = words[0]!.word;

  for (let i = 1; i < words.length; i++) {
    const w = words[i]!;
    const speaker = opts.speakerDiarization && w.speakerTag != null
      ? `speaker_${w.speakerTag}`
      : 'speaker_0';

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

function sortSegments(segments: Segment[]): Segment[] {
  return [...segments].sort((a, b) => {
    if (a.startTime !== b.startTime) return a.startTime - b.startTime;
    return a.speakerId.localeCompare(b.speakerId);
  });
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
    const buffer = await this.streamToBuffer(audio);
    const segments = await this.transcribeFromBuffer(buffer, opts);
    for (const seg of segments) {
      yield seg;
    }
  }

  async transcribeBatch(audioRef: string, opts: AsrOpts): Promise<Segment[]> {
    if (audioRef.startsWith('gs://')) {
      return this.transcribeFromUri(audioRef, opts);
    }
    const buffer = await this.fetchFn(audioRef).then((r) => r.arrayBuffer());
    return this.transcribeFromBuffer(buffer, opts);
  }

  private async transcribeFromUri(uri: string, opts: AsrOpts): Promise<Segment[]> {
    const lang = extractLanguageCode(opts.language);
    const url = `https://speech.googleapis.com/v1/speech:longrunningrecognize?key=${this.apiKey}`;

    const res = await this.fetchFn(url, {
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
    });

    if (!res.ok) throw new Error(`Google STT API error: ${res.status} ${await res.text()}`);
    const data = (await res.json()) as { name?: string };
    if (!data.name) throw new Error('No operation name');

    for (let i = 0; i < 120; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      const pollRes = await this.fetchFn(
        `https://speech.googleapis.com/v1/${data.name}?key=${this.apiKey}`,
      );
      if (!pollRes.ok) throw new Error(`Google STT poll error: ${pollRes.status}`);
      const pollData = (await pollRes.json()) as { done?: boolean; response?: GoogleSttResponse };

      if (pollData.done && pollData.response) {
        const words = pollData.response.results?.flatMap(
          (r) => r.alternatives?.[0]?.words ?? [],
        ) ?? [];
        return sortSegments(wordsToSegments(words, opts));
      }
    }

    throw new Error('Google STT transcription timeout');
  }

  private async streamToBuffer(stream: ReadableStream<Uint8Array>): Promise<ArrayBuffer> {
    const chunks: Uint8Array[] = [];
    const reader = stream.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    const totalLen = chunks.reduce((s, c) => s + c.length, 0);
    const buffer = new Uint8Array(totalLen);
    let offset = 0;
    for (const c of chunks) {
      buffer.set(c, offset);
      offset += c.length;
    }
    return buffer.buffer;
  }

  private async transcribeFromBuffer(buffer: ArrayBuffer, opts: AsrOpts): Promise<Segment[]> {
    const lang = extractLanguageCode(opts.language);
    const base64 = Buffer.from(buffer).toString('base64');

    const res = await this.fetchFn(
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
    );

    if (!res.ok) throw new Error(`Google STT API error: ${res.status} ${await res.text()}`);
    const data = (await res.json()) as GoogleSttResponse;
    const words = data.results?.flatMap((r) => r.alternatives?.[0]?.words ?? []) ?? [];
    return sortSegments(wordsToSegments(words, opts));
  }

  supportedLanguages(): string[] {
    return [...SUPPORTED_LANGUAGES];
  }
}

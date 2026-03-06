import type { AsrAdapter, AsrOpts } from 'recfn';
import type { Segment } from 'recfn';

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
  let currentSpeaker = opts.speakerDiarization && words[0]?.speaker != null
    ? `speaker_${words[0].speaker}`
    : 'speaker_0';
  let currentStart = words[0]!.start * 1000;
  let currentEnd = words[0]!.end * 1000;
  let currentText = words[0]!.word;
  let totalConf = (words[0]?.confidence ?? 0.9);

  for (let i = 1; i < words.length; i++) {
    const w = words[i]!;
    const speaker = opts.speakerDiarization && w.speaker != null
      ? `speaker_${w.speaker}`
      : 'speaker_0';

    if (speaker === currentSpeaker && w.start - (currentEnd / 1000) < 0.5) {
      currentEnd = w.end * 1000;
      currentText += ' ' + w.word;
      totalConf += w.confidence ?? 0.9;
    } else {
      segments.push({
        speakerId: currentSpeaker,
        startTime: Math.round(currentStart),
        endTime: Math.round(currentEnd),
        text: currentText.trim(),
        confidence: totalConf / (i > 0 ? 1 : 1),
      });
      currentSpeaker = speaker;
      currentStart = w.start * 1000;
      currentEnd = w.end * 1000;
      currentText = w.word;
      totalConf = w.confidence ?? 0.9;
    }
  }

  segments.push({
    speakerId: currentSpeaker,
    startTime: Math.round(currentStart),
    endTime: Math.round(currentEnd),
    text: currentText.trim(),
    confidence: totalConf,
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
    const buffer = await this.streamToBuffer(audio);
    const segments = await this.transcribeFromBuffer(buffer, opts);
    for (const seg of segments) {
      yield seg;
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
    const buffer = await this.fetchFn(audioRef).then((r) => r.arrayBuffer());
    return this.transcribeFromBuffer(buffer, opts);
  }

  private async transcribeFromUrl(url: string, opts: AsrOpts): Promise<Segment[]> {
    const lang = extractLanguageCode(opts.language);
    const apiUrl = new URL('https://api.deepgram.com/v1/listen');
    apiUrl.searchParams.set('language', lang);
    apiUrl.searchParams.set('model', 'nova-2');
    if (opts.speakerDiarization) apiUrl.searchParams.set('diarize', 'true');

    const res = await this.fetchFn(apiUrl.toString(), {
      method: 'POST',
      headers: {
        Authorization: `Token ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ url }),
    });

    if (!res.ok) throw new Error(`Deepgram API error: ${res.status} ${await res.text()}`);
    const data = (await res.json()) as DeepgramResponse;
    const words = data.results?.channels?.[0]?.alternatives?.[0]?.words ?? [];
    return sortSegments(wordsToSegments(words, opts));
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
    const url = new URL('https://api.deepgram.com/v1/listen');
    url.searchParams.set('language', lang);
    url.searchParams.set('model', 'nova-2');
    if (opts.speakerDiarization) url.searchParams.set('diarize', 'true');

    const res = await this.fetchFn(url.toString(), {
      method: 'POST',
      headers: {
        Authorization: `Token ${this.apiKey}`,
        'Content-Type': 'audio/wav',
      },
      body: buffer,
    });

    if (!res.ok) throw new Error(`Deepgram API error: ${res.status} ${await res.text()}`);
    const data = (await res.json()) as DeepgramResponse;
    const words = data.results?.channels?.[0]?.alternatives?.[0]?.words ?? [];
    return sortSegments(wordsToSegments(words, opts));
  }

  supportedLanguages(): string[] {
    return [...SUPPORTED_LANGUAGES];
  }
}

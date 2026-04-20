import type { AsrAdapter, AsrOpts } from 'recfn';
import type { Segment } from 'recfn';
import {
  fetchArrayBufferOrThrow,
  fetchJsonOrThrow,
  normalizeSpeakerId,
  pollUntil,
  readAudioChunkStream,
  sortSegmentsDeterministically,
} from 'recfn-shared-cloud';

export interface AssemblyAIAdapterConfig {
  apiKey: string;
  fetch?: typeof globalThis.fetch;
}

interface AssemblyAIWord {
  text: string;
  start: number;
  end: number;
  confidence: number;
  speaker?: string;
}

interface AssemblyAIResponse {
  status: 'queued' | 'processing' | 'completed' | 'error';
  words?: AssemblyAIWord[];
  utterances?: Array<{
    speaker: string;
    text: string;
    start: number;
    end: number;
  }>;
}

function extractLanguageCode(language: string): string {
  return language.split('-')[0].toLowerCase();
}

function utterancesToSegments(
  utterances: Array<{ speaker: string; text: string; start: number; end: number }>,
): Segment[] {
  return utterances.map((u) => ({
    speakerId: normalizeSpeakerId(u.speaker),
    startTime: Math.round(u.start),
    endTime: Math.round(u.end),
    text: u.text.trim(),
    confidence: 0.9,
  }));
}

function wordsToSegments(words: AssemblyAIWord[], opts: AsrOpts): Segment[] {
  if (words.length === 0) return [];

  const segments: Segment[] = [];
  let currentSpeaker = normalizeSpeakerId(
    opts.speakerDiarization && words[0]?.speaker ? words[0].speaker : undefined,
  );
  let currentStart = words[0]!.start;
  let currentEnd = words[0]!.end;
  let currentText = words[0]!.text;

  for (let i = 1; i < words.length; i++) {
    const w = words[i]!;
    const speaker = normalizeSpeakerId(
      opts.speakerDiarization && w.speaker ? w.speaker : undefined,
    );

    if (speaker === currentSpeaker && w.start - currentEnd < 500) {
      currentEnd = w.end;
      currentText += ' ' + w.text;
    } else {
      segments.push({
        speakerId: currentSpeaker,
        startTime: Math.round(currentStart),
        endTime: Math.round(currentEnd),
        text: currentText.trim(),
        confidence: 0.9,
      });
      currentSpeaker = speaker;
      currentStart = w.start;
      currentEnd = w.end;
      currentText = w.text;
    }
  }

  segments.push({
    speakerId: currentSpeaker,
    startTime: Math.round(currentStart),
    endTime: Math.round(currentEnd),
    text: currentText.trim(),
    confidence: 0.9,
  });

  return segments;
}

const SUPPORTED_LANGUAGES = [
  'en', 'es', 'fr', 'de', 'it', 'ja', 'ko', 'pt', 'ru', 'zh',
  'nl', 'pl', 'tr', 'ar', 'hi', 'id', 'th', 'vi', 'sv', 'da',
];

export class AssemblyAIAdapter implements AsrAdapter {
  readonly name = 'assemblyai';

  private readonly apiKey: string;
  private readonly fetchFn: typeof globalThis.fetch;

  constructor(config: AssemblyAIAdapterConfig) {
    this.apiKey = config.apiKey;
    this.fetchFn = config.fetch ?? globalThis.fetch;
  }

  async *transcribeStream(
    audio: ReadableStream<Uint8Array>,
    opts: AsrOpts,
  ): AsyncIterable<Segment> {
    const chunks = await readAudioChunkStream(
      audio as ReadableStream<Uint8Array | import('recfn').AudioChunk>,
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
    const isUrl = audioRef.startsWith('http://') || audioRef.startsWith('https://');
    if (isUrl) {
      return this.transcribeFromUrl(audioRef, opts);
    }
    const uploadUrl = await this.uploadFile(audioRef);
    return this.transcribeFromUrl(uploadUrl, opts);
  }

  private async uploadFile(audioRef: string): Promise<string> {
    const buffer = await fetchArrayBufferOrThrow(
      this.fetchFn,
      audioRef,
      'Failed to fetch audio',
    );

    const data = await fetchJsonOrThrow<{ upload_url?: string }>(
      this.fetchFn,
      'https://api.assemblyai.com/v2/upload',
      {
      method: 'POST',
      headers: {
        Authorization: this.apiKey,
        'Content-Type': 'application/octet-stream',
      },
      body: buffer,
      },
      'AssemblyAI upload error',
    );
    if (!data.upload_url) throw new Error('No upload_url in response');
    return data.upload_url;
  }

  private async transcribeFromUrl(url: string, opts: AsrOpts): Promise<Segment[]> {
    const lang = extractLanguageCode(opts.language);

    const submitData = await fetchJsonOrThrow<{ id?: string }>(
      this.fetchFn,
      'https://api.assemblyai.com/v2/transcript',
      {
      method: 'POST',
      headers: {
        Authorization: this.apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        audio_url: url,
        language_code: lang,
        speaker_labels: opts.speakerDiarization,
      }),
      },
      'AssemblyAI submit error',
    );
    const transcriptId = submitData.id;
    if (!transcriptId) throw new Error('No transcript id');

    const data = await pollUntil(
      () =>
        fetchJsonOrThrow<AssemblyAIResponse>(
          this.fetchFn,
          `https://api.assemblyai.com/v2/transcript/${transcriptId}`,
          { headers: { Authorization: this.apiKey } },
          'AssemblyAI poll error',
        ),
      {
        intervalMs: 1000,
        maxAttempts: 60,
        isDone: (result) =>
          result.status === 'completed' || result.status === 'error',
        onExhausted: () => new Error('AssemblyAI transcription timeout'),
      },
    );

    if (data.status === 'error') {
      throw new Error('AssemblyAI transcription failed');
    }
    if (data.utterances?.length) {
      return sortSegmentsDeterministically(
        utterancesToSegments(data.utterances),
      );
    }
    return sortSegmentsDeterministically(wordsToSegments(data.words ?? [], opts));
  }

  private async transcribeFromBuffer(buffer: ArrayBuffer, opts: AsrOpts): Promise<Segment[]> {
    const uploadData = await fetchJsonOrThrow<{ upload_url?: string }>(
      this.fetchFn,
      'https://api.assemblyai.com/v2/upload',
      {
      method: 'POST',
      headers: {
        Authorization: this.apiKey,
        'Content-Type': 'application/octet-stream',
      },
      body: buffer,
      },
      'AssemblyAI upload error',
    );
    if (!uploadData.upload_url) throw new Error('No upload_url');
    return this.transcribeFromUrl(uploadData.upload_url, opts);
  }

  supportedLanguages(): string[] {
    return [...SUPPORTED_LANGUAGES];
  }
}

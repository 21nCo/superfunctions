import type { AsrAdapter, AsrOpts } from 'recfn';
import type { Segment } from 'recfn';

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
    speakerId: u.speaker.startsWith('A') || u.speaker.startsWith('B')
      ? `speaker_${u.speaker}`
      : u.speaker,
    startTime: Math.round(u.start),
    endTime: Math.round(u.end),
    text: u.text.trim(),
    confidence: 0.9,
  }));
}

function wordsToSegments(words: AssemblyAIWord[], opts: AsrOpts): Segment[] {
  if (words.length === 0) return [];

  const segments: Segment[] = [];
  let currentSpeaker = opts.speakerDiarization && words[0]?.speaker
    ? words[0].speaker
    : 'speaker_0';
  let currentStart = words[0]!.start;
  let currentEnd = words[0]!.end;
  let currentText = words[0]!.text;

  for (let i = 1; i < words.length; i++) {
    const w = words[i]!;
    const speaker = opts.speakerDiarization && w.speaker ? w.speaker : 'speaker_0';

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
    const buffer = await this.streamToBuffer(audio);
    const segments = await this.transcribeFromBuffer(buffer, opts);
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
    const res = await this.fetchFn(audioRef);
    if (!res.ok) throw new Error(`Failed to fetch audio: ${res.status}`);
    const buffer = await res.arrayBuffer();

    const uploadRes = await this.fetchFn('https://api.assemblyai.com/v2/upload', {
      method: 'POST',
      headers: {
        Authorization: this.apiKey,
        'Content-Type': 'application/octet-stream',
      },
      body: buffer,
    });

    if (!uploadRes.ok) throw new Error(`AssemblyAI upload error: ${uploadRes.status}`);
    const data = (await uploadRes.json()) as { upload_url?: string };
    if (!data.upload_url) throw new Error('No upload_url in response');
    return data.upload_url;
  }

  private async transcribeFromUrl(url: string, opts: AsrOpts): Promise<Segment[]> {
    const lang = extractLanguageCode(opts.language);

    const submitRes = await this.fetchFn('https://api.assemblyai.com/v2/transcript', {
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
    });

    if (!submitRes.ok) throw new Error(`AssemblyAI submit error: ${submitRes.status}`);
    const submitData = (await submitRes.json()) as { id?: string };
    const transcriptId = submitData.id;
    if (!transcriptId) throw new Error('No transcript id');

    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      const pollRes = await this.fetchFn(
        `https://api.assemblyai.com/v2/transcript/${transcriptId}`,
        { headers: { Authorization: this.apiKey } },
      );
      if (!pollRes.ok) throw new Error(`AssemblyAI poll error: ${pollRes.status}`);
      const data = (await pollRes.json()) as AssemblyAIResponse;

      if (data.status === 'completed') {
        if (data.utterances?.length) {
          return sortSegments(utterancesToSegments(data.utterances));
        }
        const words = data.words ?? [];
        return sortSegments(wordsToSegments(words, opts));
      }
      if (data.status === 'error') {
        throw new Error('AssemblyAI transcription failed');
      }
    }

    throw new Error('AssemblyAI transcription timeout');
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
    const uploadRes = await this.fetchFn('https://api.assemblyai.com/v2/upload', {
      method: 'POST',
      headers: {
        Authorization: this.apiKey,
        'Content-Type': 'application/octet-stream',
      },
      body: buffer,
    });

    if (!uploadRes.ok) throw new Error(`AssemblyAI upload error: ${uploadRes.status}`);
    const uploadData = (await uploadRes.json()) as { upload_url?: string };
    if (!uploadData.upload_url) throw new Error('No upload_url');
    return this.transcribeFromUrl(uploadData.upload_url, opts);
  }

  supportedLanguages(): string[] {
    return [...SUPPORTED_LANGUAGES];
  }
}

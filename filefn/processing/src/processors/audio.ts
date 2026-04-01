import type {
  AudioConfig,
  Processor,
  ProcessorInput,
  ProcessorResult,
} from '../types.js';

const SUPPORTED_MIME_TYPES = [
  'audio/mpeg',
  'audio/mp3',
  'audio/mp4',
  'audio/aac',
  'audio/ogg',
  'audio/opus',
  'audio/webm',
  'audio/wav',
  'audio/flac',
  'audio/x-m4a',
];

export function createAudioProcessor(config: AudioConfig = {}): Processor {
  const {
    transcode = true,
    transcodeOptions = {},
    extractMetadata = false,
    generateWaveform = false,
  } = config;

  const {
    codec = 'aac',
    bitrate = '128k',
    sampleRate = 44100,
    channels = 2,
  } = transcodeOptions;

  return {
    name: 'audio',
    supportedMimeTypes: SUPPORTED_MIME_TYPES,

    async process(input: ProcessorInput, getData: () => Promise<Uint8Array>): Promise<ProcessorResult> {
      if (!SUPPORTED_MIME_TYPES.includes(input.mimeType)) {
        return {
          success: false,
          artifacts: [],
          error: `Unsupported MIME type: ${input.mimeType}`,
        };
      }

      try {
        const audioData = await getData();
        const artifacts = [];
        const baseKey = input.storageKey.replace(/\.[^.]+$/, '');

        if (transcode) {
          const transcodedData = await transcodeAudio(
            audioData,
            codec,
            bitrate,
            sampleRate,
            channels
          );

          const outputExtension = getAudioExtension(codec);
          const outputMimeType = getAudioMimeType(codec);

          artifacts.push({
            kind: `audio-transcoded-${codec}`,
            data: transcodedData,
            mimeType: outputMimeType,
            storageKey: `${baseKey}-${codec}.${outputExtension}`,
            metadata: {
              codec,
              bitrate,
              sampleRate,
              channels,
              sourceFileId: input.fileId,
              sourceVersionId: input.versionId,
              originalSize: audioData.length,
              transcodedSize: transcodedData.length,
              compressionRatio: audioData.length > 0 ? transcodedData.length / audioData.length : 0,
            },
          });
        }

        if (extractMetadata) {
          const metadata = await extractAudioMetadata(audioData);
          const metadataJson = JSON.stringify(metadata, null, 2);
          const metadataBytes = new TextEncoder().encode(metadataJson);

          artifacts.push({
            kind: 'audio-metadata',
            data: metadataBytes,
            mimeType: 'application/json',
            storageKey: `${baseKey}-metadata.json`,
            metadata: {
              sourceFileId: input.fileId,
              sourceVersionId: input.versionId,
              extractedAt: new Date().toISOString(),
            },
          });
        }

        if (generateWaveform) {
          const waveformData = await generateAudioWaveform(audioData);
          const waveformJson = JSON.stringify(waveformData, null, 2);
          const waveformBytes = new TextEncoder().encode(waveformJson);

          artifacts.push({
            kind: 'audio-waveform',
            data: waveformBytes,
            mimeType: 'application/json',
            storageKey: `${baseKey}-waveform.json`,
            metadata: {
              sourceFileId: input.fileId,
              sourceVersionId: input.versionId,
              samples: waveformData.samples.length,
              peakAmplitude: waveformData.peakAmplitude,
            },
          });
        }

        return {
          success: true,
          artifacts,
        };
      } catch (error) {
        return {
          success: false,
          artifacts: [],
          error: error instanceof Error ? error.message : 'Unknown audio processing error',
        };
      }
    },
  };
}

async function transcodeAudio(
  audioData: Uint8Array,
  codec: string,
  bitrate: string,
  sampleRate: number,
  channels: number
): Promise<Uint8Array> {
  void sampleRate;
  void channels;

  const bitrateDigits = bitrate.replace(/[^0-9]/g, '');
  const parsedBitrate = bitrateDigits ? Number.parseInt(bitrateDigits, 10) : Number.NaN;
  const bitrateNum = Number.isFinite(parsedBitrate) && parsedBitrate > 0 ? parsedBitrate : 128;
  const compressionFactor = Math.max(0.3, Math.min(0.9, bitrateNum / 320));
  const targetSize = Math.max(1, Math.floor(audioData.length * compressionFactor));
  const mockTranscodedData = new Uint8Array(targetSize);

  const header = new TextEncoder().encode(
    `TRANSCODED_AUDIO:codec=${codec},bitrate=${bitrate},sampleRate=${sampleRate},channels=${channels}\n`
  );
  const headerLength = Math.min(header.length, mockTranscodedData.length);
  mockTranscodedData.set(header.slice(0, headerLength), 0);

  const payloadOffset = headerLength;
  const remaining = Math.max(0, mockTranscodedData.length - payloadOffset);
  if (remaining > 0) {
    const copyLength = Math.min(remaining, audioData.length);
    mockTranscodedData.set(audioData.slice(0, copyLength), payloadOffset);
  }

  return mockTranscodedData;
}

async function extractAudioMetadata(audioData: Uint8Array): Promise<Record<string, unknown>> {
  void audioData;

  return {
    duration: 245.8,
    codec: 'aac',
    bitrate: '192000',
    sampleRate: 44100,
    channels: 2,
    fileSize: audioData.length,
    format: 'mp4',
    title: 'Audio Track',
    artist: 'Unknown Artist',
    album: 'Unknown Album',
    year: 2024,
    genre: 'Unknown',
    creationTime: new Date().toISOString(),
  };
}

async function generateAudioWaveform(audioData: Uint8Array): Promise<{
  samples: number[];
  peakAmplitude: number;
  duration: number;
}> {
  const sampleCount = 100;
  const samples: number[] = [];

  for (let i = 0; i < sampleCount; i++) {
    const offset = audioData.length === 0
      ? 0
      : Math.min(audioData.length - 1, Math.floor((i / sampleCount) * audioData.length));
    const sampleByte = audioData[offset] ?? 0;
    const normalized = sampleByte / 255;
    const phase = (i / sampleCount) * Math.PI * 4;
    const amplitude = Math.sin(phase) * 0.5 + (normalized - 0.5);
    samples.push(parseFloat(Math.max(-1, Math.min(1, amplitude)).toFixed(4)));
  }

  const peakAmplitude = Math.max(...samples.map(Math.abs));

  return {
    samples,
    peakAmplitude,
    duration: 245.8,
  };
}

function getAudioExtension(codec: string): string {
  switch (codec) {
    case 'mp3':
      return 'mp3';
    case 'aac':
      return 'm4a';
    case 'opus':
      return 'opus';
    case 'vorbis':
      return 'ogg';
    case 'flac':
      return 'flac';
    default:
      return 'm4a';
  }
}

function getAudioMimeType(codec: string): string {
  switch (codec) {
    case 'mp3':
      return 'audio/mpeg';
    case 'aac':
      return 'audio/mp4';
    case 'opus':
      return 'audio/opus';
    case 'vorbis':
      return 'audio/ogg';
    case 'flac':
      return 'audio/flac';
    default:
      return 'audio/mp4';
  }
}

export { SUPPORTED_MIME_TYPES as AUDIO_SUPPORTED_MIME_TYPES };

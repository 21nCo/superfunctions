import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
  VideoMetadataRequest,
  VideoPosterRequest,
  VideoProcessorProvider,
  VideoTranscodeRequest,
  VideoTranscodeResult,
} from '../types.js';

const RESOLUTION_HEIGHTS: Record<string, number> = {
  '1080p': 1080,
  '720p': 720,
  '480p': 480,
  '360p': 360,
};

const VIDEO_CODEC_ARGS: Record<string, string[]> = {
  h264: ['-c:v', 'libx264'],
  h265: ['-c:v', 'libx265'],
  vp9: ['-c:v', 'libvpx-vp9'],
  av1: ['-c:v', 'libaom-av1'],
};

const VIDEO_OUTPUTS: Record<string, { extension: string; mimeType: string }> = {
  h264: { extension: 'mp4', mimeType: 'video/mp4' },
  h265: { extension: 'mp4', mimeType: 'video/mp4' },
  vp9: { extension: 'webm', mimeType: 'video/webm' },
  av1: { extension: 'webm', mimeType: 'video/webm' },
};

export interface CommandVideoProviderConfig {
  ffmpegPath?: string;
  ffprobePath?: string;
}

function resolveBinaryPath(configured: string | undefined, envKeys: string[], label: string): string {
  const fromEnv = envKeys.map((key) => process.env[key]).find(Boolean);
  const binaryPath = configured ?? fromEnv;
  if (!binaryPath) {
    throw new Error(
      `${label} path is required. Provide it via createCommandVideoProvider(...) or ${envKeys.join(' / ')}.`,
    );
  }
  return binaryPath;
}

function outputExtensionForInput(mimeType: string): string {
  switch (mimeType) {
    case 'video/webm':
      return 'webm';
    case 'video/ogg':
      return 'ogv';
    case 'video/quicktime':
      return 'mov';
    case 'video/x-msvideo':
      return 'avi';
    case 'video/x-matroska':
      return 'mkv';
    default:
      return 'mp4';
  }
}

function validateBitrate(bitrate: string): string {
  const normalized = bitrate.trim();
  if (!/^\d+(?:\.\d+)?(?:[kKmM])?$/.test(normalized)) {
    throw new Error(`Invalid bitrate: ${bitrate}`);
  }
  return normalized;
}

async function runBinary(binary: string, args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(binary, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(stderr.trim() || `${binary} exited with code ${code ?? 'unknown'}`));
    });
  });
}

async function runBinaryCapture(binary: string, args: string[]): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const child = spawn(binary, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve(stdout);
        return;
      }
      reject(new Error(stderr.trim() || `${binary} exited with code ${code ?? 'unknown'}`));
    });
  });
}

async function withTempDir<T>(runner: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'filefn-processing-video-'));
  try {
    return await runner(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function coerceDuration(metadata: Record<string, unknown>): number {
  const duration = metadata.duration;
  return typeof duration === 'number' && Number.isFinite(duration) ? duration : 0;
}

export function createCommandVideoProvider(config: CommandVideoProviderConfig = {}): VideoProcessorProvider {
  const ffmpegPath = resolveBinaryPath(config.ffmpegPath, ['FILEFN_FFMPEG_PATH', 'FFMPEG_PATH'], 'ffmpeg');
  const ffprobePath = resolveBinaryPath(config.ffprobePath, ['FILEFN_FFPROBE_PATH', 'FFPROBE_PATH'], 'ffprobe');

  async function extractMetadata(request: VideoMetadataRequest): Promise<Record<string, unknown>> {
    return await withTempDir(async (dir) => {
      const inputPath = join(dir, `input.${outputExtensionForInput(request.input.mimeType)}`);
      await writeFile(inputPath, Buffer.from(request.videoData));

      const stdout = await runBinaryCapture(ffprobePath, [
        '-v',
        'error',
        '-print_format',
        'json',
        '-show_streams',
        '-show_format',
        inputPath,
      ]);

      const parsed = JSON.parse(stdout) as {
        streams?: Array<Record<string, unknown>>;
        format?: Record<string, unknown>;
      };

      const videoStream = parsed.streams?.find((stream) => stream.codec_type === 'video') ?? {};
      const audioStream = parsed.streams?.find((stream) => stream.codec_type === 'audio') ?? {};
      const format = parsed.format ?? {};

      return {
        duration: Number(format.duration ?? videoStream.duration ?? 0),
        width: Number(videoStream.width ?? 0),
        height: Number(videoStream.height ?? 0),
        codec: videoStream.codec_name ?? null,
        fps: videoStream.avg_frame_rate ?? videoStream.r_frame_rate ?? null,
        bitrate: format.bit_rate ?? videoStream.bit_rate ?? null,
        audioCodec: audioStream.codec_name ?? null,
        audioSampleRate: audioStream.sample_rate ? Number(audioStream.sample_rate) : null,
        audioChannels: audioStream.channels ? Number(audioStream.channels) : null,
        fileSize: request.videoData.length,
        container: format.format_name ?? null,
        creationTime:
          format.tags && typeof format.tags === 'object'
            ? (format.tags as Record<string, unknown>).creation_time ?? null
            : null,
      };
    });
  }

  async function generatePoster(request: VideoPosterRequest): Promise<Uint8Array> {
    return await withTempDir(async (dir) => {
      const inputPath = join(dir, `input.${outputExtensionForInput(request.input.mimeType)}`);
      const outputPath = join(dir, `poster.${request.format === 'jpeg' ? 'jpg' : request.format}`);

      await writeFile(inputPath, Buffer.from(request.videoData));

      const metadata = await extractMetadata({
        input: request.input,
        videoData: request.videoData,
      });
      const duration = coerceDuration(metadata);
      const safeTimestamp = duration > 0
        ? Math.min(Math.max(request.timestamp, 0), Math.max(duration - 0.05, 0))
        : Math.max(request.timestamp, 0);

      const filter = [
        'thumbnail=30',
        `scale=${request.width}:${request.height}:force_original_aspect_ratio=decrease`,
        `pad=${request.width}:${request.height}:(ow-iw)/2:(oh-ih)/2:black`,
      ].join(',');

      const args = [
        '-y',
        '-ss',
        String(safeTimestamp),
        '-i',
        inputPath,
        '-frames:v',
        '1',
        '-vf',
        filter,
      ];

      if (request.format === 'jpeg') {
        args.push('-q:v', String(Math.max(2, Math.round((100 - request.quality) / 4) || 2)));
      } else if (request.format === 'webp') {
        args.push('-quality', String(request.quality));
      }

      args.push(outputPath);

      await runBinary(ffmpegPath, args);
      return new Uint8Array(await readFile(outputPath));
    });
  }

  async function transcode(request: VideoTranscodeRequest): Promise<VideoTranscodeResult> {
    return await withTempDir(async (dir) => {
      const inputPath = join(dir, `input.${outputExtensionForInput(request.input.mimeType)}`);
      const outputInfo = VIDEO_OUTPUTS[request.codec] ?? VIDEO_OUTPUTS.h264;
      const outputPath = join(dir, `output.${outputInfo.extension}`);
      const targetHeight = RESOLUTION_HEIGHTS[request.resolution] ?? RESOLUTION_HEIGHTS['720p'];

      await writeFile(inputPath, Buffer.from(request.videoData));

      const args = [
        '-y',
        '-i',
        inputPath,
        '-vf',
        `scale=-2:${targetHeight}`,
        '-r',
        String(request.fps),
        ...(VIDEO_CODEC_ARGS[request.codec] ?? VIDEO_CODEC_ARGS.h264),
        '-b:v',
        validateBitrate(request.bitrate),
      ];

      if (outputInfo.extension === 'webm') {
        args.push('-an');
      } else {
        args.push('-movflags', '+faststart');
      }

      args.push(outputPath);

      await runBinary(ffmpegPath, args);

      return {
        data: new Uint8Array(await readFile(outputPath)),
        mimeType: outputInfo.mimeType,
        extension: outputInfo.extension,
      };
    });
  }

  return {
    generatePoster,
    transcode,
    extractMetadata,
  };
}

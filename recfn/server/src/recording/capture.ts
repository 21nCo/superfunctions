import type { AudioChunk, VideoChunk, RecordingFormat } from '@recfn/core';
import { ErrorCode, createError } from '@recfn/core';
import { mkdtemp, open, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

export interface CaptureResult {
  data: Uint8Array;
  format: RecordingFormat;
  /** Encoded media duration in milliseconds. */
  duration: number;
  size: number;
}
export interface CaptureOptions {
  recordingFormat: 'mp4' | 'audio_only';
  videoStream?: ReadableStream<VideoChunk>;
  /** Combined input spool and final output limits; bounded even for infinite streams. */
  maxInputBytes?: number;
  maxOutputBytes?: number;
  /** Maximum capture lifetime, including a stalled producer. Default four hours. */
  maxCaptureMs?: number;
  temporaryDirectory?: string;
  ffmpegPath?: string;
  ffprobePath?: string;
}
const failure = (message: string) => createError(ErrorCode.RECORDING_FINALIZATION_FAILED, message);

async function run(binary: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'ignore'] });
    let output = '';
    let exceeded = false;
    const timeout = setTimeout(() => { exceeded = true; child.kill('SIGKILL'); }, 60_000);
    child.stdout.on('data', (data: Buffer) => {
      output += data.toString();
      if (output.length > 64 * 1024) { exceeded = true; child.kill('SIGKILL'); }
    });
    child.once('error', () => { clearTimeout(timeout); reject(failure('Media encoder/decoder executable is unavailable.')); });
    child.once('close', (code) => {
      clearTimeout(timeout);
      if (code !== 0 || exceeded) reject(failure('Media encoding or validation failed.'));
      else resolve(output);
    });
  });
}

async function encode(binary: string, args: string[], output: string, limit: number): Promise<void> {
  const file = await open(output, 'wx', 0o600);
  const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'ignore'] });
  const exited = new Promise<number | null>((resolve, reject) => {
    child.once('error', () => reject(failure('Media encoder executable is unavailable.')));
    child.once('close', resolve);
  });
  void exited.catch(() => {});
  const timeout = setTimeout(() => child.kill('SIGKILL'), 60_000);
  let size = 0;
  try {
    for await (const chunk of child.stdout) {
      size += chunk.length;
      if (size > limit) throw failure('Capture output byte limit exceeded.');
      await file.writeFile(chunk);
    }
    if (await exited !== 0) throw failure('Media encoding failed.');
  } finally {
    clearTimeout(timeout);
    if (child.exitCode === null) child.kill('SIGKILL');
    await exited.catch(() => {});
    await file.close();
  }
}

export async function captureFromStream(stream: ReadableStream<AudioChunk>, options: CaptureOptions): Promise<CaptureResult> {
  const audio = stream.getReader();
  let video: ReadableStreamDefaultReader<VideoChunk> | undefined;
  const maxInput = options.maxInputBytes ?? 256 * 1024 * 1024;
  const maxOutput = options.maxOutputBytes ?? 64 * 1024 * 1024;
  const captureMs = options.maxCaptureMs ?? 4 * 60 * 60 * 1000;
  let directory: string | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let rejectStopped!: (error: unknown) => void;
  const stopped = new Promise<never>((_, reject) => { rejectStopped = reject; });
  // Both readers race this promise, so a failed branch also stops a stalled sibling.
  void stopped.catch(() => {});
  let total = 0;
  let firstAudio: AudioChunk | undefined;
  let firstVideo: VideoChunk | undefined;
  let frames = 0;
  const cancel = () => {
    void audio.cancel().catch(() => {});
    if (video) void video.cancel().catch(() => {});
  };
  try {
    video = options.videoStream?.getReader();
    if (![maxInput, maxOutput, captureMs].every(n => Number.isSafeInteger(n) && n > 0) || maxOutput > 256 * 1024 * 1024 || captureMs > 2 ** 31 - 1) throw failure('Invalid capture limits.');
    if (options.recordingFormat !== 'audio_only' && options.recordingFormat !== 'mp4') throw failure('Unsupported recording format.');
    if (options.recordingFormat === 'mp4' && !video) throw failure('MP4 recording requires an explicit video stream.');
    if (options.recordingFormat === 'audio_only' && video) throw failure('Audio-only capture cannot discard a supplied video stream.');
    directory = await mkdtemp(join(options.temporaryDirectory ?? tmpdir(), 'recfn-media-'));
    timer = setTimeout(() => { rejectStopped(failure('Capture duration limit exceeded.')); cancel(); }, captureMs);
    const audioPath = join(directory, 'audio');
    const videoPath = join(directory, 'video');
    async function spool<T extends AudioChunk | VideoChunk>(reader: ReadableStreamDefaultReader<T>, path: string, validate: (value: T) => void) {
      const file = await open(path, 'wx', 0o600).catch(error => { rejectStopped(error); cancel(); throw error; });
      try {
        while (true) {
          const { value, done } = await Promise.race([reader.read(), stopped]);
          if (done) break;
          validate(value);
          total += value.data.byteLength;
          if (total > maxInput) throw failure('Capture input byte limit exceeded.');
          // Copy before awaiting: producers may recycle the original frame buffer.
          await file.writeFile(Buffer.from(value.data));
        }
      } catch (error) { rejectStopped(error); cancel(); throw error; }
      finally { await file.close(); }
    }
    const tasks = [
      spool(audio, audioPath, value => {
        if (!(value.data instanceof Uint8Array) || !value.data.length || !Number.isFinite(value.timestamp)) throw failure('Invalid audio frame.');
        if (!['pcm_s16le', 'webm', 'ogg'].includes(value.encoding ?? '')) throw failure('Audio encoding must be explicitly declared.');
        if (!Number.isInteger(value.sampleRate) || value.sampleRate < 8000 || value.sampleRate > 192000 || !Number.isInteger(value.channels) || value.channels < 1 || value.channels > 8) throw failure('Invalid audio sample format.');
        if (firstAudio && (value.encoding !== firstAudio.encoding || value.sampleRate !== firstAudio.sampleRate || value.channels !== firstAudio.channels)) throw failure('Audio format changed during capture.');
        if (value.encoding === 'pcm_s16le' && value.data.length % (2 * value.channels)) throw failure('Incomplete PCM sample frame.');
        firstAudio ??= { ...value, data: new Uint8Array() };
      }),
      ...(video ? [spool(video, videoPath, value => {
        if (value.encoding !== 'rgb24' || !Number.isInteger(value.width) || !Number.isInteger(value.height) || value.width < 2 || value.height < 2 || value.width > 4096 || value.height > 4096 || value.width % 2 || value.height % 2 || !Number.isFinite(value.frameRate) || value.frameRate! < 1 || value.frameRate! > 120 || !Number.isFinite(value.timestamp)) throw failure('Unsupported video frame format.');
        if (!(value.data instanceof Uint8Array) || value.data.length !== value.width * value.height * 3) throw failure('Incomplete RGB frame.');
        if (firstVideo && (value.width !== firstVideo.width || value.height !== firstVideo.height || value.frameRate !== firstVideo.frameRate || Math.abs(value.timestamp - firstVideo.timestamp - frames * 1000 / value.frameRate!) > 1)) throw failure('Video format or frame cadence changed.');
        firstVideo ??= { ...value, data: new Uint8Array() };
        frames++;
      })] : []),
    ];
    const results = await Promise.allSettled(tasks);
    const rejected = results.find(result => result.status === 'rejected');
    if (rejected?.status === 'rejected') throw rejected.reason;
    clearTimeout(timer);
    if (!firstAudio || (video && !firstVideo)) throw failure('Captured recording stream was empty.');
    const output = join(directory, options.recordingFormat === 'mp4' ? 'recording.mp4' : 'recording.wav');
    const a = firstAudio;
    const args = ['-nostdin', '-v', 'error', '-xerror', '-y', '-protocol_whitelist', 'file,pipe', '-f', a.encoding === 'pcm_s16le' ? 's16le' : a.encoding === 'webm' ? 'matroska' : 'ogg'];
    if (a.encoding === 'pcm_s16le') args.push('-ar', String(a.sampleRate), '-ac', String(a.channels));
    const offset = firstVideo ? firstVideo.timestamp - a.timestamp : 0;
    if (Math.abs(offset) > 60_000) throw failure('Audio/video start timestamps differ by more than one minute.');
    if (offset < 0) args.push('-itsoffset', String(-offset / 1000));
    args.push('-i', audioPath);
    if (firstVideo) {
      // Stream clocks share millisecond origin; offsets preserve initial A/V alignment.
      args.push('-itsoffset', String(Math.max(0, offset) / 1000), '-f', 'rawvideo', '-pixel_format', 'rgb24', '-video_size', `${firstVideo.width}x${firstVideo.height}`, '-framerate', String(firstVideo.frameRate), '-i', videoPath, '-map', '0:a:0', '-map', '1:v:0', '-c:a', 'aac', '-c:v', 'libx264', '-threads', '2', '-bf', '0', '-pix_fmt', 'yuv420p', '-movflags', 'frag_keyframe+empty_moov');
    } else args.push('-map', '0:a:0', '-c:a', 'pcm_s16le');
    args.push('-f', firstVideo ? 'mp4' : 'wav', 'pipe:1');
    await encode(options.ffmpegPath ?? 'ffmpeg', args, output, maxOutput);
    if (!firstVideo) {
      // Pipe WAV has unknown RIFF/data sizes. Finalize those fields after bounded encoding.
      const wav = await readFile(output);
      wav.writeUInt32LE(wav.length - 8, 4);
      let offset = 12;
      while (offset + 8 <= wav.length) {
        const length = wav.readUInt32LE(offset + 4);
        if (wav.toString('ascii', offset, offset + 4) === 'data') { wav.writeUInt32LE(wav.length - offset - 8, offset + 4); break; }
        offset += 8 + length + (length % 2);
      }
      const file = await open(output, 'r+');
      try { await file.writeFile(wav); } finally { await file.close(); }
    }
    const info = await stat(output);
    if (!info.size || info.size > maxOutput) throw failure('Capture output byte limit exceeded.');
    const probe = JSON.parse(await run(options.ffprobePath ?? 'ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', output]));
    const duration = Number(probe.format?.duration) * 1000;
    const audioTrack = probe.streams?.find((s: { codec_type: string }) => s.codec_type === 'audio');
    const videoTrack = probe.streams?.find((s: { codec_type: string }) => s.codec_type === 'video');
    if (!Number.isFinite(duration) || duration <= 0 || !audioTrack || (firstVideo && !videoTrack)) throw failure('Encoded recording failed media validation.');
    // Decode all packets, not just the container header, before accepting a recording.
    await run(options.ffmpegPath ?? 'ffmpeg', ['-nostdin', '-v', 'error', '-xerror', '-i', output, '-f', 'null', '-']);
    const data = await readFile(output);
    return { data, format: firstVideo ? 'mp4' : 'wav', duration, size: data.byteLength };
  } finally {
    if (timer) clearTimeout(timer);
    cancel();
    audio.releaseLock();
    video?.releaseLock();
    if (directory) await rm(directory, { recursive: true, force: true });
  }
}
export function assertCaptureHasData(capture: CaptureResult): void {
  if (capture.size <= 0) throw failure('Captured recording stream was empty.');
}

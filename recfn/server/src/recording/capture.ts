import type { AudioChunk, VideoChunk, RecordingFormat } from '@recfn/core';
import { ErrorCode, createError } from '@recfn/core';
import { mkdtemp, open, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { Readable, type Writable } from 'node:stream';

export interface CaptureResult {
  data: Uint8Array;
  format: RecordingFormat;
  /** Encoded media duration in milliseconds. */
  duration: number;
  size: number;
}
export interface CaptureArtifact {
  format: RecordingFormat;
  duration: number;
  size: number;
  openStream(): ReadableStream<Uint8Array>;
  dispose(): Promise<void>;
}
export interface CaptureOptions {
  recordingFormat: 'mp4' | 'audio_only';
  videoStream?: ReadableStream<VideoChunk>;
  /** Optional total ingress quota; raw media is never spooled. */
  maxInputBytes?: number;
  /** Encoded-file disk quota (default 1 GiB for file capture). */
  maxOutputBytes?: number;
  maxChunkBytes?: number;
  signal?: AbortSignal;
  /** Maximum capture lifetime, including a stalled producer. Default four hours. */
  maxCaptureMs?: number;
  temporaryDirectory?: string;
  ffmpegPath?: string;
  ffprobePath?: string;
}
const failure = (message: string) => createError(ErrorCode.RECORDING_FINALIZATION_FAILED, message);

async function run(binary: string, args: string[], signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'ignore'] });
    let output = '';
    let exceeded = false;
    const abort = () => { exceeded = true; child.kill('SIGKILL'); };
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    const timeout = setTimeout(abort, 60_000);
    child.stdout.on('data', (data: Buffer) => {
      output += data.toString();
      if (output.length > 64 * 1024) { exceeded = true; child.kill('SIGKILL'); }
    });
    child.once('error', () => { signal?.removeEventListener('abort', abort); clearTimeout(timeout); reject(failure('Media encoder/decoder executable is unavailable.')); });
    child.once('close', (code) => {
      signal?.removeEventListener('abort', abort);
      clearTimeout(timeout);
      if (code !== 0 || exceeded) reject(failure('Media encoding or validation failed.'));
      else resolve(output);
    });
  });
}

export async function captureToFile(stream: ReadableStream<AudioChunk>, options: CaptureOptions): Promise<CaptureArtifact> {
  const audio = stream.getReader();
  let video: ReadableStreamDefaultReader<VideoChunk> | undefined;
  const maxInput = options.maxInputBytes ?? Number.MAX_SAFE_INTEGER;
  const maxOutput = options.maxOutputBytes ?? 1024 * 1024 * 1024;
  const maxChunk = options.maxChunkBytes ?? 64 * 1024 * 1024;
  const captureMs = options.maxCaptureMs ?? 4 * 60 * 60 * 1000;
  let directory: string | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let total = 0;
  let keepArtifact = false;
  let killEncoder = () => {};
  let stopReason: unknown;
  let firstAudio: AudioChunk | undefined;
  let firstVideo: VideoChunk | undefined;
  let frames = 0;
  const cancel = () => {
    void audio.cancel().catch(() => {});
    if (video) void video.cancel().catch(() => {});
  };
  const stop = (error: unknown) => {
    stopReason ??= error;
    cancel(); killEncoder();
  };
  const onAbort = () => stop(failure('Capture was canceled.'));
  options.signal?.addEventListener('abort', onAbort, { once: true });
  try {
    if (options.signal?.aborted) throw failure('Capture was canceled.');
    video = options.videoStream?.getReader();
    if (![maxInput, maxOutput, captureMs, maxChunk].every(n => Number.isSafeInteger(n) && n > 0) || maxOutput > 4 * 1024 * 1024 * 1024 - 1 || captureMs > 2 ** 31 - 1) throw failure('Invalid capture limits.');
    if (options.recordingFormat !== 'audio_only' && options.recordingFormat !== 'mp4') throw failure('Unsupported recording format.');
    if (options.recordingFormat === 'mp4' && !video) throw failure('MP4 recording requires an explicit video stream.');
    if (options.recordingFormat === 'audio_only' && video) throw failure('Audio-only capture cannot discard a supplied video stream.');
    directory = await mkdtemp(join(options.temporaryDirectory ?? tmpdir(), 'recfn-media-'));
    timer = setTimeout(() => stop(failure('Capture duration limit exceeded.')), captureMs);
    const validateAudio = (value: AudioChunk) => {
        if (!(value.data instanceof Uint8Array) || !value.data.length || !Number.isFinite(value.timestamp)) throw failure('Invalid audio frame.');
        if (!['pcm_s16le', 'webm', 'ogg'].includes(value.encoding ?? '')) throw failure('Audio encoding must be explicitly declared.');
        if (!Number.isInteger(value.sampleRate) || value.sampleRate < 8000 || value.sampleRate > 192000 || !Number.isInteger(value.channels) || value.channels < 1 || value.channels > 8) throw failure('Invalid audio sample format.');
        if (firstAudio && (value.encoding !== firstAudio.encoding || value.sampleRate !== firstAudio.sampleRate || value.channels !== firstAudio.channels)) throw failure('Audio format changed during capture.');
        if (value.encoding === 'pcm_s16le' && value.data.length % (2 * value.channels)) throw failure('Incomplete PCM sample frame.');
        firstAudio ??= { ...value, data: new Uint8Array() };
    };
    const validateVideo = (value: VideoChunk) => {
        if (value.encoding !== 'rgb24' || !Number.isInteger(value.width) || !Number.isInteger(value.height) || value.width < 2 || value.height < 2 || value.width > 4096 || value.height > 4096 || value.width % 2 || value.height % 2 || !Number.isFinite(value.frameRate) || value.frameRate! < 1 || value.frameRate! > 120 || !Number.isFinite(value.timestamp)) throw failure('Unsupported video frame format.');
        if (!(value.data instanceof Uint8Array) || value.data.length !== value.width * value.height * 3) throw failure('Incomplete RGB frame.');
        if (firstVideo && (value.width !== firstVideo.width || value.height !== firstVideo.height || value.frameRate !== firstVideo.frameRate || Math.abs(value.timestamp - firstVideo.timestamp - frames * 1000 / value.frameRate!) > 1)) throw failure('Video format or frame cadence changed.');
        firstVideo ??= { ...value, data: new Uint8Array() };
        frames++;
    };
    const next = async <T>(reader: ReadableStreamDefaultReader<T>) => {
      const result = await reader.read();
      if (stopReason) throw stopReason;
      return result;
    };
    const guard = <T>(promise: Promise<T>) => promise.catch(error => { stop(error); throw error; });
    const first = await Promise.all([guard(next(audio).then(result => { if (result.done) throw failure('Captured recording stream was empty.'); validateAudio(result.value); return result; })), ...(video ? [guard(next(video).then(result => { if (result.done) throw failure('Captured recording stream was empty.'); validateVideo(result.value); return result; }))] : [])]);
    if (first.some(frame => frame.done)) throw failure('Captured recording stream was empty.');
    const audioFrame = first[0].value as AudioChunk;
    const videoFrame = first[1]?.value as VideoChunk | undefined;
    const output = join(directory, options.recordingFormat === 'mp4' ? 'recording.mp4' : 'recording.wav');
    const a = firstAudio!;
    const args = ['-nostdin', '-v', 'error', '-xerror', '-y', '-protocol_whitelist', 'file,pipe', '-thread_queue_size', '4', '-analyzeduration', '1', '-probesize', '32', '-f', a.encoding === 'pcm_s16le' ? 's16le' : a.encoding === 'webm' ? 'matroska' : 'ogg'];
    if (a.encoding === 'pcm_s16le') args.push('-ar', String(a.sampleRate), '-ac', String(a.channels));
    const offset = firstVideo ? firstVideo.timestamp - a.timestamp : 0;
    if (Math.abs(offset) > 60_000) throw failure('Audio/video start timestamps differ by more than one minute.');
    if (offset < 0) args.push('-itsoffset', String(-offset / 1000));
    args.push('-i', 'pipe:3');
    if (firstVideo) {
      // Stream clocks share millisecond origin; offsets preserve initial A/V alignment.
      args.push('-itsoffset', String(Math.max(0, offset) / 1000), '-thread_queue_size', '4', '-analyzeduration', '1', '-probesize', '32', '-f', 'rawvideo', '-pixel_format', 'rgb24', '-video_size', `${firstVideo.width}x${firstVideo.height}`, '-framerate', String(firstVideo.frameRate), '-i', 'pipe:4', '-map', '0:a:0', '-map', '1:v:0', '-c:a', 'aac', '-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency', '-threads', '2', '-bf', '0', '-g', '60', '-pix_fmt', 'yuv420p', '-movflags', 'frag_keyframe+empty_moov', '-frag_duration', '1000000', '-max_interleave_delta', '1000000');
    } else args.push('-map', '0:a:0', '-c:a', 'pcm_s16le');
    args.push('-f', firstVideo ? 'mp4' : 'wav', 'pipe:1');
    const file = await open(output, 'wx', 0o600);
    const child = spawn(options.ffmpegPath ?? 'ffmpeg', args, { stdio: ['ignore', 'pipe', 'ignore', 'pipe', ...(video ? ['pipe' as const] : [])] });
    killEncoder = () => { child.kill('SIGKILL'); };
    let completedPumps = 0;
    const expectedPumps = video ? 2 : 1;
    const exited = new Promise<number | null>((resolve, reject) => {
      child.once('error', () => { const error = failure('Media encoder executable is unavailable.'); stop(error); reject(error); });
      child.once('close', code => {
        if (code !== 0) stop(failure('Media encoding failed.'));
        else if (completedPumps !== expectedPumps) stop(failure('Media encoder exited before input EOF.'));
        resolve(code);
      });
    });
    void exited.catch(() => {});
    let outputSize = 0;
    async function feed<T extends AudioChunk | VideoChunk>(reader: ReadableStreamDefaultReader<T>, pipe: Writable, initial: T, validate: (value: T) => void) {
      pipe.on('error', stop);
      let value: T = initial;
      while (true) {
        total += value.data.byteLength;
        if (total > maxInput) throw failure('Capture input byte limit exceeded.');
        if (value.data.byteLength > maxChunk) throw failure('Capture chunk byte limit exceeded.');
        const bytes = Buffer.from(value.data);
        await new Promise<void>((resolve, reject) => pipe.write(bytes, error => error ? reject(error) : resolve()));
        if (stopReason) throw stopReason;
        const result = await next(reader);
        if (result.done) break;
        value = result.value;
        validate(value);
      }
      pipe.end();
      completedPumps++;
    }
    const pumps = [guard(feed(audio, child.stdio[3] as Writable, audioFrame, validateAudio)),
      ...(video && videoFrame ? [guard(feed(video, child.stdio[4] as Writable, videoFrame, validateVideo))] : [])];
    const outputTask = guard((async () => {
      for await (const chunk of child.stdout!) {
        outputSize += chunk.length;
        if (outputSize > maxOutput) throw failure('Capture output byte limit exceeded.');
        await file.writeFile(chunk);
      }
    })());
    try {
      await Promise.all(pumps);
      // Capture may run for hours; after ingress EOF only finalization may take 60s.
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => stop(failure('Media finalization deadline exceeded.')), 60_000);
      await outputTask;
      if (await exited !== 0 || stopReason) throw stopReason ?? failure('Media encoding failed.');
    } finally {
      killEncoder();
      await Promise.allSettled([...pumps, outputTask, exited]);
      await file.close();
      killEncoder = () => {};
    }
    if (timer) clearTimeout(timer);
    if (!firstVideo) {
      // Patch unknown pipe RIFF/data sizes with bounded header reads, not readFile.
      const wav = await open(output, 'r+');
      try {
        const header = Buffer.alloc(8);
        header.writeUInt32LE(outputSize - 8, 0);
        await wav.write(header.subarray(0, 4), 0, 4, 4);
        let offset = 12;
        let patched = false;
        while (offset + 8 <= Math.min(outputSize, 64 * 1024)) {
          await wav.read(header, 0, 8, offset);
          const size = header.readUInt32LE(4);
          if (header.toString('ascii', 0, 4) === 'data') {
            header.writeUInt32LE(outputSize - offset - 8, 4);
            await wav.write(header.subarray(4), 0, 4, offset + 4); patched = true; break;
          }
          offset += 8 + size + size % 2;
        }
        if (!patched) throw failure('Invalid WAV encoder header.');
      } finally { await wav.close(); }
    }
    const info = await stat(output);
    if (!info.size || info.size > maxOutput) throw failure('Capture output byte limit exceeded.');
    const probe = JSON.parse(await run(options.ffprobePath ?? 'ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', output], options.signal));
    const duration = Number(probe.format?.duration) * 1000;
    const audioTrack = probe.streams?.find((s: { codec_type: string }) => s.codec_type === 'audio');
    const videoTrack = probe.streams?.find((s: { codec_type: string }) => s.codec_type === 'video');
    if (!Number.isFinite(duration) || duration <= 0 || !audioTrack || (firstVideo && !videoTrack)) throw failure('Encoded recording failed media validation.');
    // Decode all packets, not just the container header, before accepting a recording.
    await run(options.ffmpegPath ?? 'ffmpeg', ['-nostdin', '-v', 'error', '-xerror', '-i', output, '-f', 'null', '-'], options.signal);
    if (options.signal?.aborted) throw failure('Capture was canceled.');
    keepArtifact = true;
    const ownedDirectory = directory;
    let disposed = false;
    const readers = new Set<ReturnType<typeof createReadStream>>();
    let disposing: Promise<void> | undefined;
    return {
      format: firstVideo ? 'mp4' : 'wav', duration, size: info.size,
      openStream() {
        if (disposed) throw failure('Capture artifact has been disposed.');
        const file = createReadStream(output, { highWaterMark: 64 * 1024 });
        readers.add(file); file.once('close', () => readers.delete(file));
        return Readable.toWeb(file) as ReadableStream<Uint8Array>;
      },
      dispose() {
        if (!disposing) {
          disposed = true;
          disposing = (async () => {
            await Promise.all([...readers].map(file => new Promise<void>(resolve => { file.once('close', resolve); file.destroy(); })));
            await rm(ownedDirectory!, { recursive: true, force: true });
          })();
        }
        return disposing;
      },
    };
  } finally {
    options.signal?.removeEventListener('abort', onAbort);
    if (timer) clearTimeout(timer);
    cancel();
    audio.releaseLock();
    video?.releaseLock();
    if (directory && !keepArtifact) await rm(directory, { recursive: true, force: true });
  }
}
/** Compatibility API: explicit bounded final buffer; workers use captureToFile. */
export async function captureFromStream(stream: ReadableStream<AudioChunk>, options: CaptureOptions): Promise<CaptureResult> {
  const limit = options.maxOutputBytes ?? 64 * 1024 * 1024;
  if (limit > 256 * 1024 * 1024) throw failure('Buffer capture output limit exceeds 256 MiB.');
  const artifact = await captureToFile(stream, { ...options, maxOutputBytes: limit });
  try {
    const reader = artifact.openStream().getReader();
    const data = new Uint8Array(artifact.size);
    let offset = 0;
    try { while (true) { const chunk = await reader.read(); if (chunk.done) break; data.set(chunk.value, offset); offset += chunk.value.length; } }
    finally { await reader.cancel(); reader.releaseLock(); }
    return { data, format: artifact.format, duration: artifact.duration, size: data.length };
  } finally { await artifact.dispose(); }
}
export function assertCaptureHasData(capture: Pick<CaptureResult, 'size'>): void {
  if (capture.size <= 0) throw failure('Captured recording stream was empty.');
}

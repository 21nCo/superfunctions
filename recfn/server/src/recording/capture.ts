import type { AudioChunk, VideoChunk, RecordingFormat } from '@recfn/core';
import { ErrorCode, createError } from '@recfn/core';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import type { Writable } from 'node:stream';
import type { RecordingScratch } from './scratch.js';
import { EncryptedMediaFile } from './encrypted-media-file.js';

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
  /** Encoded plaintext byte limit (default 1 GiB); encrypted scratch adds 28 bytes per 64 KiB chunk. */
  maxOutputBytes?: number;
  maxChunkBytes?: number;
  signal?: AbortSignal;
  /** Maximum capture lifetime, including a stalled producer. Default four hours. */
  maxCaptureMs?: number;
  /** Managed dedicated scratch with bounded dead-owner cleanup. */
  scratch?: RecordingScratch;
  /** Unmanaged development compatibility path; unsuitable for production workers. */
  temporaryDirectory?: string;
  ffmpegPath?: string;
  ffprobePath?: string;
}
const failure = (message: string) => createError(ErrorCode.RECORDING_FINALIZATION_FAILED, message);

async function run(binary: string, args: string[], input: () => ReadableStream<Uint8Array>, signal?: AbortSignal, onLine?: (line: string) => void): Promise<string> {
  const reader = input().getReader();
  const child = (() => {
    try { return spawn(binary, args, { stdio: ['pipe', 'pipe', 'ignore'] }); }
    catch (error) { void reader.cancel().then(() => reader.releaseLock(), () => reader.releaseLock()); throw error; }
  })();
  let output = '';
  let reason: unknown;
  let inputDone = false;
  const stop = (error: unknown) => { reason ??= error; child.kill('SIGKILL'); void reader.cancel().catch(() => {}); };
  const abort = () => stop(failure('Media validation was canceled or exceeded its deadline.'));
  child.stdin.on('error', error => stop(error));
  const exited = new Promise<void>((resolve, reject) => {
    child.once('error', () => { const error = failure('Media encoder/decoder executable is unavailable.'); stop(error); reject(error); });
    child.once('close', code => {
      if (code !== 0 || !inputDone || reason) reject(reason ?? failure('Media encoding or validation failed.'));
      else resolve();
      void reader.cancel().catch(() => {});
    });
  });
  void exited.catch(() => {});
  child.stdout.on('data', (data: Buffer) => {
    try {
      output += data.toString();
      if (onLine) {
        let newline: number;
        while ((newline = output.indexOf('\n')) >= 0) { if (newline > 64 * 1024) throw failure('Media validation line limit exceeded.'); onLine(output.slice(0, newline)); output = output.slice(newline + 1); }
      }
      if (output.length > 64 * 1024) throw failure('Media validation output limit exceeded.');
    } catch (error) { stop(error); }
  });
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  const timeout = setTimeout(abort, 60_000);
  const pumping = (async () => {
    try {
      for (;;) {
        const result = await reader.read();
        if (reason) throw reason;
        if (result.done) { inputDone = true; child.stdin.end(); break; }
        await new Promise<void>((resolve, reject) => child.stdin.write(result.value, error => error ? reject(error) : resolve()));
      }
    } catch (error) { stop(error); throw error; }
  })();
  try {
    await Promise.all([exited, pumping]);
    if (onLine && output) onLine(output);
    return output;
  } finally {
    child.kill('SIGKILL');
    await reader.cancel().catch(() => {});
    await Promise.allSettled([exited, pumping]);
    reader.releaseLock();
    signal?.removeEventListener('abort', abort); clearTimeout(timeout);
  }
}

async function inspectMedia(file: EncryptedMediaFile, options: CaptureOptions) {
  let duration = 0;
  const tracks: Array<Record<string, string>> = [];
  await run(options.ffprobePath ?? 'ffprobe', ['-v', 'error', '-show_packets', '-show_streams', '-show_entries', 'packet=pts_time,duration_time:stream=codec_type,codec_name,sample_rate,channels,width,height', '-of', 'compact=p=1:nk=0', 'pipe:0'], () => file.openStream(), options.signal, line => {
    const [kind, ...fields] = line.split('|');
    const values = Object.fromEntries(fields.map(field => { const index = field.indexOf('='); return [field.slice(0, index), field.slice(index + 1)]; }));
    if (kind === 'packet') {
      const timestamp = Number(values.pts_time), span = Number(values.duration_time);
      if (!Number.isFinite(timestamp) || !Number.isFinite(span) || span < 0) throw failure('Encoded packet has no valid presentation duration.');
      duration = Math.max(duration, (timestamp + span) * 1000);
    } else if (kind === 'stream') {
      if (tracks.length >= 16) throw failure('Encoded recording has too many tracks.');
      tracks.push(values);
    }
  });
  return { duration, tracks };
}

export async function captureToFile(stream: ReadableStream<AudioChunk>, options: CaptureOptions): Promise<CaptureArtifact> {
  const audio = stream.getReader();
  let video: ReadableStreamDefaultReader<VideoChunk> | undefined;
  const maxInput = options.maxInputBytes ?? Number.MAX_SAFE_INTEGER;
  const maxOutput = options.maxOutputBytes ?? 1024 * 1024 * 1024;
  const maxChunk = options.maxChunkBytes ?? 64 * 1024 * 1024;
  const captureMs = options.maxCaptureMs ?? 4 * 60 * 60 * 1000;
  let directory: string | undefined;
  let encrypted: EncryptedMediaFile | undefined;
  let disposeDirectory: (() => Promise<void>) | undefined;
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
    if (options.scratch && options.temporaryDirectory) throw failure('Managed scratch and temporaryDirectory cannot both be configured.');
    if (options.scratch) {
      const allocated = await options.scratch.allocate();
      directory = allocated.directory; disposeDirectory = allocated.dispose;
    } else {
      directory = await mkdtemp(join(options.temporaryDirectory ?? tmpdir(), 'recfn-media-'));
      const owned = directory; disposeDirectory = () => rm(owned, { recursive: true, force: true });
    }
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
    const output = join(directory, 'recording.enc');
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
    const file = await EncryptedMediaFile.create(output);
    encrypted = file;
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
        await file.append(chunk);
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
      killEncoder = () => {};
    }
    if (timer) clearTimeout(timer);
    await file.finish();
    if (!firstVideo) {
      // Patch unknown pipe RIFF/data sizes using authenticated bounded reads in memory.
      const header = Buffer.alloc(4);
      header.writeUInt32LE(outputSize - 8);
      await file.patch(4, header);
      let offset = 12;
      let patched = false;
      while (offset + 8 <= Math.min(outputSize, 64 * 1024)) {
        const chunk = await file.read(offset, 8);
        const size = chunk.readUInt32LE(4);
        if (chunk.toString('ascii', 0, 4) === 'data') {
          header.writeUInt32LE(outputSize - offset - 8);
          await file.patch(offset + 4, header); patched = true; break;
        }
        offset += 8 + size + size % 2;
      }
      if (!patched) throw failure('Invalid WAV encoder header.');
    }
    if (!file.size || file.size > maxOutput) throw failure('Capture output byte limit exceeded.');
    const { duration, tracks } = await inspectMedia(file, options);
    if (!Number.isFinite(duration) || duration <= 0 || !tracks.some(track => track.codec_type === 'audio') || (firstVideo && !tracks.some(track => track.codec_type === 'video'))) throw failure('Encoded recording failed media validation.');
    // Full decode receives authenticated plaintext over a pipe, never a plaintext file.
    await run(options.ffmpegPath ?? 'ffmpeg', ['-nostdin', '-v', 'error', '-xerror', '-i', 'pipe:0', '-f', 'null', '-'], () => file.openStream(), options.signal);
    if (options.signal?.aborted) throw failure('Capture was canceled.');
    keepArtifact = true;
    const removeDirectory = disposeDirectory;
    let disposed = false;
    let disposing: Promise<void> | undefined;
    return {
      format: firstVideo ? 'mp4' : 'wav', duration, size: file.size,
      openStream() {
        if (disposed) throw failure('Capture artifact has been disposed.');
        return file.openStream();
      },
      dispose() {
        if (!disposing) {
          disposed = true;
          disposing = (async () => {
            await file.dispose();
            await removeDirectory!();
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
    if (!keepArtifact) {
      try { await encrypted?.dispose(); } finally { await disposeDirectory?.(); }
    }
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

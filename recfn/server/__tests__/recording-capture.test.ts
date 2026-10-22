import { describe, it, expect } from 'vitest';
import { captureFromStream } from '../src/recording/capture.js';
import type { AudioChunk, VideoChunk } from '@recfn/core';
import { mkdtemp, writeFile, readFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
function stream<T>(values: T[]) { return new ReadableStream<T>({ start(c) { values.forEach(v => c.enqueue(v)); c.close(); } }); }
function audio(channels = 1): AudioChunk {
  const data = new Uint8Array(16000 * channels * 2);
  const view = new DataView(data.buffer);
  for (let i = 0; i < 16000; i++) for (let c = 0; c < channels; c++) view.setInt16((i * channels + c) * 2, Math.round(10000 * Math.sin(2 * Math.PI * (440 + c * 220) * i / 16000)), true);
  return { data, encoding: 'pcm_s16le', timestamp: 1000, sampleRate: 16000, channels };
}
function video(): VideoChunk[] { return Array.from({ length: 10 }, (_, i) => ({ data: new Uint8Array(16 * 16 * 3).fill(i * 20), encoding: 'rgb24', frameRate: 10, timestamp: 1000 + i * 100, width: 16, height: 16 })); }
async function decode(data: Uint8Array, extension: string) {
  const dir = await mkdtemp(join(tmpdir(), 'recfn-validation-'));
  try {
    const path = join(dir, `media.${extension}`); await writeFile(path, data);
    const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', path], { encoding: 'utf8' }));
    execFileSync('ffmpeg', ['-v', 'error', '-xerror', '-i', path, '-f', 'null', '-']);
    const pcm = execFileSync('ffmpeg', ['-v', 'error', '-i', path, '-map', '0:a:0', '-f', 's16le', '-']);
    return { probe, pcm };
  } finally { await rm(dir, { recursive: true, force: true }); }
}
describe('bounded real media finalization', () => {
  it('encodes stereo PCM into independently decoded WAV with exact samples', async () => {
    const input = audio(2); const result = await captureFromStream(stream([input]), { recordingFormat: 'audio_only' });
    expect(result.duration).toBe(1000); expect(result.size).toBe(result.data.length);
    const { probe, pcm } = await decode(result.data, 'wav');
    expect(probe.streams[0]).toMatchObject({ codec_name: 'pcm_s16le', channels: 2, sample_rate: '16000' });
    expect(pcm).toEqual(Buffer.from(input.data));
  });
  it('muxes actual video and audio into a decodable MP4 without dropping either track', async () => {
    const result = await captureFromStream(stream([audio()]), { recordingFormat: 'mp4', videoStream: stream(video()) });
    const { probe } = await decode(result.data, 'mp4');
    expect(probe.streams.map((s: any) => s.codec_type).sort()).toEqual(['audio', 'video']);
    expect(probe.streams.find((s: any) => s.codec_type === 'video')).toMatchObject({ width: 16, height: 16, codec_name: 'h264' });
    expect(result.duration).toBeGreaterThanOrEqual(1000); expect(result.duration).toBeLessThan(1200);
  });
  it('decodes chunked WebM from a MediaRecorder-compatible input', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'recfn-input-'));
    try {
      const path = join(dir, 'audio.webm');
      execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=1', '-c:a', 'libopus', path]);
      const bytes = await readFile(path);
      const chunks = Array.from({length: Math.ceil(bytes.length / 997)}, (_, i) => ({ ...audio(), encoding: 'webm' as const, data: bytes.subarray(i * 997, (i + 1) * 997), sampleRate: 48000 }));
      const result = await captureFromStream(stream(chunks), { recordingFormat: 'audio_only' });
      expect(result.duration).toBeCloseTo(1000, 0); await decode(result.data, 'wav');
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it('rejects audio masquerading as MP4 and unspecified codecs', async () => {
    await expect(captureFromStream(stream([audio()]), { recordingFormat: 'mp4' })).rejects.toThrow('video stream');
    await expect(captureFromStream(stream([{ ...audio(), encoding: undefined }]), { recordingFormat: 'audio_only' })).rejects.toThrow('explicitly declared');
  });
  it('rejects format changes, partial samples, empty streams and invalid cadence', async () => {
    for (const frames of [[{ ...audio(), encoding: 'webm' as const, data: new Uint8Array([1, 2, 3, 4]) }], [], [{ ...audio(), data: new Uint8Array([1]) }], [audio(), audio(2)]]) await expect(captureFromStream(stream(frames), { recordingFormat: 'audio_only' })).rejects.toThrow();
    const frames = video(); frames[1].timestamp += 10;
    await expect(captureFromStream(stream([audio()]), { recordingFormat: 'mp4', videoStream: stream(frames) })).rejects.toThrow('cadence');
  });
  it('releases audio on locked-video acquisition failure and cancels stalled siblings', async () => {
    const a = stream([audio()]); const v = stream(video()); const lock = v.getReader();
    await expect(captureFromStream(a, { recordingFormat: 'mp4', videoStream: v })).rejects.toThrow();
    expect(a.locked).toBe(false); lock.releaseLock();
    let canceled = false;
    const stalled = new ReadableStream<VideoChunk>({ cancel() { canceled = true; } });
    await expect(captureFromStream(stream([{ ...audio(), encoding: undefined }]), { recordingFormat: 'mp4', videoStream: stalled })).rejects.toThrow('explicitly declared');
    expect(canceled).toBe(true); expect(stalled.locked).toBe(false);
  });
  it('enforces input/output and stalled capture limits, canceling producers and removing spools', async () => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), 'recfn-cleanup-test-'));
    try {
    await expect(captureFromStream(stream([audio()]), { recordingFormat: 'audio_only', temporaryDirectory, maxInputBytes: 10 })).rejects.toThrow('input byte');
    await expect(captureFromStream(stream([audio()]), { recordingFormat: 'audio_only', temporaryDirectory, maxOutputBytes: 100 })).rejects.toThrow('output byte');
    let canceled = false;
    await expect(captureFromStream(new ReadableStream({ cancel() { canceled = true; } }), { recordingFormat: 'audio_only', temporaryDirectory, maxCaptureMs: 20 })).rejects.toThrow('duration limit');
    expect(canceled).toBe(true);
    await expect(captureFromStream(stream([audio()]), { recordingFormat: 'audio_only', temporaryDirectory, ffmpegPath: '/nonexistent-recfn-encoder' })).rejects.toThrow();
    expect(await readdir(temporaryDirectory)).toEqual([]);
    } finally { await rm(temporaryDirectory, { recursive: true, force: true }); }
  });
});

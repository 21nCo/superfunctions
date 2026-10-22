// Run from repo root: node --max-old-space-size=128 recfn/.conduct/media-streaming-acceptance.mjs
import { captureToFile } from '../server/dist/recording/capture.js';
import { uploadObject } from '../server/dist/integrations/storage.js';
import { createLocalStorageAdapter } from '../../packages/storage-local/dist/index.js';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { getHeapStatistics } from 'node:v8';
const root = await mkdtemp(join(tmpdir(), 'recfn-hour-'));
const seconds = Number(process.env.RECFN_MEDIA_SECONDS ?? 3600), rate = 30, width = Number(process.env.RECFN_MEDIA_WIDTH ?? 64), height = Number(process.env.RECFN_MEDIA_HEIGHT ?? 64);
if (![seconds, width, height].every(n => Number.isSafeInteger(n) && n > 0)) throw new Error('Invalid fixture dimensions/duration');
let v = 0, a = 0, peakRss = 0, peakChildRss = 0, audioEof = 0, videoEof = 0;
const started = performance.now();
const sample = setInterval(() => {
  peakRss = Math.max(peakRss, process.memoryUsage().rss);
  try {
    const rows = execFileSync('ps', ['-axo', 'ppid,rss,comm'], { encoding: 'utf8' }).split('\n');
    const children = rows.map(r => r.trim().split(/\s+/)).filter(r => Number(r[0]) === process.pid && /ffmpeg|ffprobe/.test(r[2] ?? ''));
    peakChildRss = Math.max(peakChildRss, children.reduce((n, r) => n + Number(r[1]) * 1024, 0));
  } catch {}
}, 250);
const audio = new ReadableStream({ pull(c) {
  if (a === seconds * 10) { audioEof = performance.now(); return c.close(); }
  const data = new Uint8Array(3200); const view = new DataView(data.buffer);
  for (let i = 0; i < 1600; i++) view.setInt16(i * 2, Math.round(8000 * Math.sin(2 * Math.PI * 440 * i / 16000)), true);
  c.enqueue({ data, encoding: 'pcm_s16le', sampleRate: 16000, channels: 1, timestamp: a++ * 100 });
} }, { highWaterMark: 1 });
const video = new ReadableStream({ pull(c) {
  if (v === seconds * rate) { videoEof = performance.now(); return c.close(); }
  c.enqueue({ data: new Uint8Array(width * height * 3).fill(v % 255), encoding: 'rgb24', width, height, frameRate: rate, timestamp: v++ * 1000 / rate });
} }, { highWaterMark: 1 });
async function digest(stream) {
  const hash = createHash('sha256'); const reader = stream.getReader();
  try { while (true) { const r = await reader.read(); if (r.done) break; hash.update(r.value); } }
  finally { reader.releaseLock(); }
  return hash.digest('hex');
}
let artifact;
try {
  artifact = await captureToFile(audio, { recordingFormat: 'mp4', videoStream: video, temporaryDirectory: root, maxOutputBytes: 64 * 1024 * 1024 });
  const capturedAt = performance.now();
  const captureElapsedSeconds = (capturedAt - started) / 1000;
  const afterBothProducerEofSeconds = (capturedAt - Math.max(audioEof, videoEof)) / 1000;
  const before = await digest(artifact.openStream());
  const storage = createLocalStorageAdapter({ rootDir: join(root, 'storage') });
  await uploadObject(storage, 'recording.mp4', artifact, { contentType: 'video/mp4' });
  const after = await digest(await storage.openDownloadStream({ key: 'recording.mp4' }));
  if (before !== after) throw new Error('Storage hash mismatch');
  const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-count_frames', '-show_streams', '-show_format', '-of', 'json', join(root, 'storage', 'recording.mp4')], { encoding: 'utf8' }));
  const track = probe.streams.find(s => s.codec_type === 'video');
  if (Number(track.nb_read_frames) !== seconds * rate || Math.abs(artifact.duration / 1000 - seconds) > 0.2) throw new Error('Media duration/frame count mismatch');
  await artifact.dispose(); artifact = undefined;
  console.log(JSON.stringify({ generatedSeconds: seconds, generatedVideoFrames: v, width, height, fps: rate, rawIngressBytes: seconds * rate * width * height * 3 + seconds * 16000 * 2, captureElapsedSeconds, afterBothProducerEofSeconds, v8HeapLimitBytes: getHeapStatistics().heap_size_limit, totalElapsedSeconds: (performance.now() - started) / 1000, observedPeakNodeRssBytes: peakRss, observedPeakChildRssBytes: peakChildRss, outputBytes: Number(probe.format.size), encodedDurationSeconds: Number(probe.format.duration), decodedVideoFrames: Number(track.nb_read_frames), storageSha256: after, residualEntriesBeforeStorageCleanup: await readdir(root) }, null, 2));
} finally {
  clearInterval(sample); await artifact?.dispose(); await rm(root, { recursive: true, force: true });
}

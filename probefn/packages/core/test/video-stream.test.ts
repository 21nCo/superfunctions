import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import { ArtifactStore } from '@probefn/storage';
import { createCheckpoint, type CheckpointCaptureSource } from '../src/checkpoints.js';
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function setup(runCap: number, source: Pick<CheckpointCaptureSource, 'videoCaptureStream'>, checkpointCap?: number) {
  const root = await mkdtemp(path.join(tmpdir(), 'probe-video-stream-')); roots.push(root);
  const store = new ArtifactStore({ repoRoot: root, caps: { maxArtifactBytes: runCap } });
  const paths = store.getCheckpointPaths('run', 'video');
  const capture = () => createCheckpoint({ repoRoot: root, artifactStore: store, sessionId: 'session', runId: 'run', browser: 'chromium', name: 'video', includeVideo: true,
    ...(checkpointCap === undefined ? {} : { artifactCapBytes: checkpointCap }),
    delta: { newConsoleErrors: 0, newPageErrors: 0, newNetworkFailures: 0 },
    source: { url: () => 'about:blank', viewportSize: () => ({ width: 1, height: 1 }), screenshot: async () => Uint8Array.of(1), domSnapshot: async () => ({}), accessibilitySnapshot: async () => ({}), layoutSnapshot: async () => ({}), ...source },
  });
  return { root, store, paths, capture };
}
it.each(['run', 'checkpoint'])('rejects declared video size before reading the first chunk for %s caps', async kind => {
  const read = vi.fn();
  const fixture = await setup(kind === 'run' ? 4096 : 1024 * 1024, {
    videoCaptureStream: consume => consume({ byteLength: 8192, chunks: (async function* () { read(); yield Buffer.alloc(8192); })() }),
  }, kind === 'checkpoint' ? 4096 : undefined);
  await expect(fixture.capture()).rejects.toMatchObject({ code: 'E_STORAGE_CAP_EXCEEDED' });
  expect(read).not.toHaveBeenCalled();
  for (const target of [fixture.paths.videoPath, fixture.paths.manifestPath, fixture.paths.screenshotPath]) await expect(stat(path.join(fixture.root, target))).rejects.toMatchObject({ code: 'ENOENT' });
});
it.each(['short', 'growing', 'producer failure'])('rejects %s video streams without a partial artifact/manifest', async mode => {
  const fixture = await setup(1024 * 1024, { videoCaptureStream: async consume => {
    await consume({ byteLength: 4, chunks: (async function* () { yield Buffer.from(mode === 'short' ? 'ab' : mode === 'growing' ? 'abcde' : 'abcd'); })() });
    if (mode === 'producer failure') throw new Error('finalization failed after consuming');
  } });
  await expect(fixture.capture()).rejects.toMatchObject({ code: 'E_CHECKPOINT_CAPTURE_FAILED' });
  for (const target of [fixture.paths.videoPath, fixture.paths.manifestPath]) await expect(stat(path.join(fixture.root, target))).rejects.toMatchObject({ code: 'ENOENT' });
});
it('streams many chunks and hashes the admitted file without changing capture compatibility', async () => {
  const fixture = await setup(1024 * 1024, { videoCaptureStream: consume => consume({ byteLength: 100 * 1024, chunks: (async function* () { for (let i = 0; i < 100; i++) yield Buffer.alloc(1024, i); })() }) });
  await fixture.capture();
  const bytes = await readFile(path.join(fixture.root, fixture.paths.videoPath));
  expect(bytes.length).toBe(100 * 1024);
  const manifest = JSON.parse(await readFile(path.join(fixture.root, fixture.paths.manifestPath), 'utf8'));
  expect(manifest.artifacts.find((item: { kind: string }) => item.kind === 'video').sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
});

it.each([false, true])('joins an unawaited consumer before producer completion or error (throws=%s)', async throws => {
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const reading = new Promise<void>(resolve => { entered = resolve; });
  const fixture = await setup(1024 * 1024, { videoCaptureStream: async consume => {
    void consume({ byteLength: 4, chunks: (async function* () { entered(); await gate; yield Buffer.from('abcd'); })() });
    if (throws) throw new Error('Producer failed while consumer is writing');
  } });
  let finished = false;
  const result = fixture.capture().then(value => { finished = true; return { value }; }, error => { finished = true; return { error }; });
  await reading;
  await new Promise(resolve => setImmediate(resolve));
  expect(finished).toBe(false);
  await expect(stat(path.join(fixture.root, fixture.paths.manifestPath))).rejects.toMatchObject({ code: 'ENOENT' });
  release();
  const outcome = await result;
  if (throws) {
    expect(outcome).toMatchObject({ error: { code: 'E_CHECKPOINT_CAPTURE_FAILED' } });
    for (const target of [fixture.paths.videoPath, fixture.paths.manifestPath]) await expect(stat(path.join(fixture.root, target))).rejects.toMatchObject({ code: 'ENOENT' });
  } else {
    expect(outcome).toHaveProperty('value');
    expect(await readFile(path.join(fixture.root, fixture.paths.videoPath), 'utf8')).toBe('abcd');
  }
});

it('rejects ignored duplicate and retained late consumers before reading their streams', async () => {
  let retained!: Parameters<NonNullable<CheckpointCaptureSource['videoCaptureStream']>>[0];
  const read = vi.fn();
  const later = { byteLength: 4, chunks: (async function* () { read(); yield Buffer.from('late'); })() };
  const fixture = await setup(1024 * 1024, { videoCaptureStream: async consume => {
    retained = consume;
    await consume({ byteLength: 4, chunks: (async function* () { yield Buffer.from('good'); })() });
    void consume(later);
  } });
  await expect(fixture.capture()).rejects.toMatchObject({ code: 'E_CHECKPOINT_CAPTURE_FAILED' });
  await expect(retained(later)).rejects.toThrow('late');
  expect(read).not.toHaveBeenCalled();
  for (const target of [fixture.paths.videoPath, fixture.paths.manifestPath]) await expect(stat(path.join(fixture.root, target))).rejects.toMatchObject({ code: 'ENOENT' });
});

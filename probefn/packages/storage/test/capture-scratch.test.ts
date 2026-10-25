import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, stat, writeFile, rename, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it, vi } from 'vitest';
import { CaptureScratchRegistry } from '../src/capture-scratch.js';
import { ArtifactStore } from '../src/artifact-store.js';
const roots: string[] = [], children: ChildProcess[] = [];
const target = '.artifacts/runs/run/trace.zip';
async function root() { const value = await mkdtemp(path.join(tmpdir(), 'probe-scratch-registry-')); roots.push(value); return value; }
async function interrupted(directory: string, mode: string) {
  const child = spawn(process.execPath, [fileURLToPath(new URL('./fixtures/scratch-crash-child.mjs', import.meta.url)), directory, mode], { stdio: ['ignore', 'pipe', 'pipe'] }); children.push(child);
  let stderr = '', stdout = ''; child.stderr!.on('data', bytes => { stderr += String(bytes); });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Child deadline: ${stderr}`)), 10000);
    child.stdout!.on('data', bytes => { stdout += String(bytes); if (stdout.includes('READY')) { clearTimeout(timer); resolve(); } });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`Child exit ${code}: ${stderr}`)); });
  });
  const receipt: { id: string; filename: string } = JSON.parse(stdout.split('\n')[0]!);
  return { child, receipt };
}
async function kill(child: ChildProcess) { const done = once(child, 'exit'); child.kill('SIGKILL'); await done; children.splice(children.indexOf(child), 1); }
afterEach(async () => {
  vi.restoreAllMocks();
  for (const child of children.splice(0)) if (child.exitCode === null && child.signalCode === null) { const done = once(child, 'exit'); child.kill('SIGKILL'); await done; }
  for (const directory of roots.splice(0)) await rm(directory, { recursive: true, force: true });
});
for (const mode of ['reserved', 'created', 'prepared', 'producing', 'sealed', 'imported', 'admitted', 'removing', 'removed', 'cleaned']) it(`recovers independent process death at trace ${mode} boundary`, async () => {
  const directory = await root(); const { child, receipt } = await interrupted(directory, mode);
  const store = new ArtifactStore({ repoRoot: directory });
  await expect(store.recoverTraceScratch('run')).rejects.toMatchObject({ code: 'E_SESSION_ALREADY_RUNNING' });
  await kill(child);
  const result = await store.recoverTraceScratch('run');
  expect(result.records).toHaveLength(1);
  if (mode === 'created') {
    expect(result.records[0]).toMatchObject({ state: 'prepared', removed: false, error: 'cleanup_failed' });
    expect((await stat(path.dirname(receipt.filename))).isDirectory()).toBe(true);
  } else if (mode === 'producing' || mode === 'sealed') {
    expect(result.records[0]).toMatchObject({ state: mode === 'producing' ? 'quarantined' : 'sealed', removed: false });
    expect(await readFile(receipt.filename, 'utf8')).toBe('PK synthetic durable trace');
  } else {
    expect(result.records[0]!.removed).toBe(true);
    await expect(stat(path.dirname(receipt.filename))).rejects.toMatchObject({ code: 'ENOENT' });
    if (!['prepared', 'reserved'].includes(mode)) {
      expect((await new ArtifactStore({ repoRoot: directory }).recoverTraceScratch('run')).records[0]).toMatchObject({ state: 'cleaned', destination: target, removed: true });
      await store.acknowledgeTraceScratch('run', target);
      await store.acknowledgeTraceScratch('run', target);
    }
    expect((await store.recoverTraceScratch('run')).records).toEqual([]);
    if (!['prepared', 'reserved'].includes(mode)) expect(await readFile(path.join(directory, target), 'utf8')).toBe('PK synthetic durable trace');
  }
  expect((await stat(path.join(directory, '.artifacts/.quota.sqlite'))).mode & 0o777).toBe(0o600);
}, 20000);

it('never deletes changed destinations or scratch from a replaced generation', async () => {
  const directory = await root(); const { child, receipt } = await interrupted(directory, 'admitted'); await kill(child);
  await writeFile(path.join(directory, target), 'unrelated user bytes');
  const store = new ArtifactStore({ repoRoot: directory });
  expect((await store.recoverTraceScratch('run')).records[0]).toMatchObject({ removed: false, error: 'cleanup_failed' });
  expect(await readFile(path.join(directory, target), 'utf8')).toBe('unrelated user bytes');
  await rename(path.dirname(receipt.filename), path.dirname(receipt.filename) + '-original');
  expect((await store.recoverTraceScratch('run')).records[0]!.removed).toBe(false);
  expect(await readFile(path.dirname(receipt.filename) + '-original/trace.zip', 'utf8')).toBe('PK synthetic durable trace');
});

it('charges bounded registry admission before creating scratch and rejects future schema', async () => {
  const directory = await root(); const store = new ArtifactStore({ repoRoot: directory, caps: { maxArtifactBytes: 4095 } });
  let called = false;
  await expect(store.withTraceScratch('run', target, async () => { called = true; })).rejects.toMatchObject({ code: 'E_STORAGE_CAP_EXCEEDED' });
  expect(called).toBe(false);
  const db = new DatabaseSync(path.join(directory, '.artifacts/.quota.sqlite'));
  try { expect(db.prepare('SELECT count(*) AS n FROM capture_scratch').get()!.n).toBe(0); db.exec('UPDATE capture_scratch_schema SET version=999'); } finally { db.close(); }
  await expect(new ArtifactStore({ repoRoot: directory }).recoverTraceScratch('run')).rejects.toMatchObject({ code: 'E_STORAGE_WRITE_FAILED' });
});

it('bounds pages and denies cross-run generation cleanup and reserved writes', async () => {
  const directory = await root(); const store = new ArtifactStore({ repoRoot: directory }); let id = '';
  for (let n = 0; n < 3; n++) await store.withTraceScratch('run', target, async scratch => { id = scratch.id; await scratch.producing(); });
  await expect(store.cleanupTraceScratch('other', id)).rejects.toMatchObject({ code: 'E_STORAGE_WRITE_FAILED' });
  const first = await store.recoverTraceScratch('run', '', 2); expect(first.records).toHaveLength(2); expect(first.nextCursor).toBeTruthy();
  const second = await store.recoverTraceScratch('run', first.nextCursor!, 2); expect(second.records).toHaveLength(1); expect(second.nextCursor).toBeNull();
  await expect(store.writeArtifact(`.artifacts/runs/run/.probefn-scratch/probefn-trace-${id}/trace.zip`, 'bad')).rejects.toMatchObject({ code: 'E_STORAGE_WRITE_FAILED' });
});

for (const mode of ['reconcile-partial', 'reconcile-after']) it(`resumes exact durable admission after ${mode} process death`, async () => {
  const directory = await root(); const store = new ArtifactStore({ repoRoot: directory });
  let id = '';
  const content = 'PK ' + 'trace bytes '.repeat(10000);
  await store.withTraceScratch('run', target, async scratch => {
    id = scratch.id; await scratch.producing(); await writeFile(scratch.filename, content); await scratch.seal();
  });
  const { child } = await interrupted(directory, mode);
  await expect(store.reconcileTraceScratch('run', id)).rejects.toMatchObject({ code: 'E_SESSION_ALREADY_RUNNING' });
  await kill(child);
  expect(await new ArtifactStore({ repoRoot: directory }).reconcileTraceScratch('run', id)).toBe(target);
  expect(await readFile(path.join(directory, target), 'utf8')).toBe(content);
  expect(await store.reconcileTraceScratch('run', id)).toBe(target);
  expect((await store.recoverTraceScratch('run')).records[0]!.removed).toBe(true);
}, 20000);

it('refuses changed admission prefixes without overwriting bytes', async () => {
  const directory = await root(); const store = new ArtifactStore({ repoRoot: directory });
  let id = '';
  await store.withTraceScratch('run', target, async scratch => { id = scratch.id; await scratch.producing(); await writeFile(scratch.filename, 'PK durable source'); await scratch.seal(); });
  const { child } = await interrupted(directory, 'reconcile-partial'); await kill(child);
  await writeFile(path.join(directory, target), 'OTHER');
  await expect(store.reconcileTraceScratch('run', id)).rejects.toMatchObject({ code: 'E_STORAGE_WRITE_FAILED' });
  expect(await readFile(path.join(directory, target), 'utf8')).toBe('OTHER');
});

it('admits a sealed trace explicitly but never replaces an unrelated existing destination', async () => {
  const directory = await root(); const store = new ArtifactStore({ repoRoot: directory }); let id = '';
  await store.withTraceScratch('run', target, async scratch => { id = scratch.id; await scratch.producing(); await writeFile(scratch.filename, 'PK complete'); await scratch.seal(); });
  await writeFile(path.join(directory, target), 'user destination');
  await expect(store.reconcileTraceScratch('run', id)).rejects.toMatchObject({ code: 'E_STORAGE_WRITE_FAILED' });
  expect(await readFile(path.join(directory, target), 'utf8')).toBe('user destination');
  await rm(path.join(directory, target));
  expect(await store.reconcileTraceScratch('run', id)).toBe(target);
  expect(await readFile(path.join(directory, target), 'utf8')).toBe('PK complete');
});

it.each([false, true])('joins unawaited registry operations before returning or throwing (throw=%s)', async throwAfterStart => {
  const directory = await root(); const store = new ArtifactStore({ repoRoot: directory });
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  const original = CaptureScratchRegistry.prototype.producing;
  vi.spyOn(CaptureScratchRegistry.prototype, 'producing').mockImplementation(async function (this: CaptureScratchRegistry, ...args) { entered(); await gate; return original.apply(this, args); });
  let late: (() => Promise<void>) | undefined, settled = false;
  const operation = store.withTraceScratch('run', target, async scratch => {
    late = scratch.producing; void scratch.producing();
    if (throwAfterStart) throw new Error('Producer callback failed');
    return 'completed';
  }).then(value => ({ value }), error => ({ error })).finally(() => { settled = true; });
  await started;
  await new Promise(resolve => setTimeout(resolve, 10)); expect(settled).toBe(false);
  release(); const outcome = await operation;
  if (throwAfterStart) expect(outcome).toMatchObject({ error: { message: 'Producer callback failed' } });
  else expect(outcome).toEqual({ value: 'completed' });
  await expect(late!()).rejects.toMatchObject({ code: 'E_STORAGE_WRITE_FAILED' });
  expect((await store.recoverTraceScratch('run')).records[0]!.state).toBe('quarantined');
});

it('retains a replacement scratch directory even if its marker was copied', async () => {
  const directory = await root(); const store = new ArtifactStore({ repoRoot: directory });
  let scratchDirectory = '';
  await store.withTraceScratch('run', target, async scratch => {
    scratchDirectory = path.dirname(scratch.filename); await scratch.producing();
    await writeFile(scratch.filename, 'PK original'); await scratch.seal();
    await store.importArtifactFile(target, scratch.filename); await scratch.admitted();
  });
  const marker = await readFile(path.join(scratchDirectory, 'owner.json'));
  await rename(scratchDirectory, scratchDirectory + '-original'); await mkdir(scratchDirectory);
  await writeFile(path.join(scratchDirectory, 'owner.json'), marker);
  await writeFile(path.join(scratchDirectory, 'user.txt'), 'do not remove');
  expect((await store.recoverTraceScratch('run')).records[0]).toMatchObject({ removed: false, error: 'cleanup_failed' });
  expect(await readFile(path.join(scratchDirectory, 'user.txt'), 'utf8')).toBe('do not remove');
  expect(await readFile(path.join(scratchDirectory + '-original', 'trace.zip'), 'utf8')).toBe('PK original');
});

it('retains an unacknowledged receipt when its published destination changes', async () => {
  const directory = await root(); const { child } = await interrupted(directory, 'cleaned'); await kill(child);
  const store = new ArtifactStore({ repoRoot: directory });
  await writeFile(path.join(directory, target), 'changed destination');
  await expect(store.acknowledgeTraceScratch('run', target)).rejects.toMatchObject({ code: 'E_STORAGE_WRITE_FAILED' });
  expect((await store.recoverTraceScratch('run')).records[0]).toMatchObject({ state: 'cleaned', error: 'cleanup_failed' });
  expect(await readFile(path.join(directory, target), 'utf8')).toBe('changed destination');
});

it('upgrades the prior coordinator schema without resetting existing run caps or bytes', async () => {
  const directory = await root();
  const original = new ArtifactStore({ repoRoot: directory, caps: { maxArtifactBytes: 5000 } });
  await original.writeArtifact('.artifacts/runs/run/existing.bin', Buffer.alloc(1000, 7));
  // The previous coordinator schema is identical except for these two additive tables.
  const db = new DatabaseSync(path.join(directory, '.artifacts/.quota.sqlite'));
  try { db.exec('DROP TABLE capture_scratch; DROP TABLE capture_scratch_schema'); } finally { db.close(); }
  const reopened = new ArtifactStore({ repoRoot: directory, caps: { maxArtifactBytes: 100000 } });
  expect((await reopened.recoverTraceScratch('run')).records).toEqual([]);
  let entered = false;
  await expect(reopened.withTraceScratch('run', target, async () => { entered = true; })).rejects.toMatchObject({ code: 'E_STORAGE_CAP_EXCEEDED' });
  expect(entered).toBe(false);
  expect(await readFile(path.join(directory, '.artifacts/runs/run/existing.bin'))).toEqual(Buffer.alloc(1000, 7));
});

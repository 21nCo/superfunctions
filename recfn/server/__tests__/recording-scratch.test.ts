import { afterEach, expect, it } from 'vitest';
import { mkdtemp, rm, readdir, writeFile, readFile, chmod, symlink, realpath, link, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { createRecordingScratch, type RecordingScratch } from '../src/recording/scratch.js';
import { captureToFile } from '../src/recording/capture.js';
import { createBotWorker, createMemoryStore, MemoryQueueAdapter, MemoryLogger } from '../src/index.js';

const roots: string[] = [];
const managers: RecordingScratch[] = [];
const children: Array<{ process: ChildProcessWithoutNullStreams; exited: Promise<unknown> }> = [];
afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.process.exitCode === null && child.process.signalCode === null) child.process.kill('SIGKILL');
    await child.exited;
  }
  for (const manager of managers.splice(0)) await manager.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const parent = await realpath(await mkdtemp(join(tmpdir(), 'recfn-scratch-test-'))); roots.push(parent);
  const directory = join(parent, 'owned');
  const scratch = await createRecordingScratch({ directory }); managers.push(scratch);
  return { parent, directory, scratch };
}
async function child(source: string) {
  const process = spawn(globalThis.process.execPath, ['--input-type=module', '-e', source], { stdio: 'pipe' });
  const exited = once(process, 'exit'); children.push({ process, exited });
  let stdout = '', stderr = '';
  process.stdout.on('data', data => { stdout += String(data); }); process.stderr.on('data', data => { stderr += String(data); });
  await expect.poll(() => { if (process.exitCode !== null && !stdout) throw new Error(stderr); return stdout.includes('\n'); }, { timeout: 5000 }).toBe(true);
  return { process, exited, value: JSON.parse(stdout.trim()) as Record<string, any> };
}
const modulePath = JSON.stringify(resolve('dist/recording/scratch.js'));
async function owner(directory: string, bytes = 32) {
  return child(`import {createRecordingScratch} from ${modulePath};import{writeFile}from'node:fs/promises';import{join}from'node:path';const s=await createRecordingScratch({directory:${JSON.stringify(directory)}});const a=await s.allocate();await writeFile(join(a.directory,'recording.enc'),Buffer.alloc(${bytes},42),{mode:0o600});console.log(JSON.stringify({directory:a.directory,pid:process.pid}));setInterval(()=>{},1000);`);
}

it('retains a real live process, then reclaims its ciphertext after actual SIGKILL', async () => {
  const { directory, scratch } = await fixture(); expect(scratch.supportsCleanup).toBe(true);
  const active = await owner(directory);
  const live = await scratch.cleanup(); expect(live.removed).toBe(0); expect(live.skipped[0].reason).toBe('owner-live-or-pid-reused');
  active.process.kill('SIGKILL'); await active.exited;
  const dead = await scratch.cleanup(); expect(dead.removed).toBe(1); expect(dead.incomplete).toBe(false);
  expect(await readdir(directory)).toEqual(['.recfn-scratch.json']);
});

it('permits two independent cleaners without deleting a new UUID owner', async () => {
  const { directory, scratch } = await fixture();
  const dead = await owner(directory); dead.process.kill('SIGKILL'); await dead.exited;
  const source = `import{createRecordingScratch}from ${modulePath};const s=await createRecordingScratch({directory:${JSON.stringify(directory)}});console.log(JSON.stringify(s.lastCleanup));`;
  const fresh = await scratch.allocate();
  const [a, b] = await Promise.all([child(source), child(source)]); await Promise.all([a.exited, b.exited]);
  expect(a.value.removed + b.value.removed).toBe(1);
  expect(await readFile(join(fresh.directory, 'owner.json'), 'utf8')).toContain(String(process.pid));
  await fresh.dispose(); expect(await readdir(directory)).toEqual(['.recfn-scratch.json']);
});

it('refuses unknown files, symlinks, incomplete manifests, and changed root permissions', async () => {
  const { parent, directory, scratch } = await fixture();
  const dead = await owner(directory); dead.process.kill('SIGKILL'); await dead.exited;
  await writeFile(join(dead.value.directory, 'unexpected.txt'), 'retain me', { mode: 0o600 });
  const target = join(parent, 'outside'); await writeFile(target, 'outside bytes');
  await symlink(target, join(directory, `capture-${randomUUID()}`));
  const report = await scratch.cleanup(); expect(report.removed).toBe(0); expect(report.skipped).toHaveLength(2);
  expect(await readFile(target, 'utf8')).toBe('outside bytes');
  expect(await readFile(join(dead.value.directory, 'unexpected.txt'), 'utf8')).toBe('retain me');
  await chmod(directory, 0o755); await expect(scratch.cleanup()).rejects.toThrow('private'); await chmod(directory, 0o700);
  const alias = join(parent, 'alias'); await symlink(directory, alias);
  await expect(createRecordingScratch({ directory: alias })).rejects.toThrow();
});

it('bounds scan entries and reclaimed bytes, reporting leftovers rather than deleting them', async () => {
  const { directory, scratch } = await fixture();
  const dead = await owner(directory, 4096); dead.process.kill('SIGKILL'); await dead.exited;
  const bytes = await scratch.cleanup({ maxBytes: 1 }); expect(bytes.removed).toBe(0); expect(bytes.incomplete).toBe(true); expect(bytes.skipped[0].reason).toBe('byte-budget');
  await writeFile(join(directory, 'unknown'), 'retained');
  const count = await scratch.cleanup({ maxEntries: 1 }); expect(count.examined).toBe(1); expect(count.incomplete).toBe(true);
  const final = await scratch.cleanup(); expect([...count.skipped, ...final.skipped].some(entry => entry.entry === 'unknown')).toBe(true);
});

it('preserves unsupported/foreign identities and incomplete metadata conservatively', async () => {
  const { directory, scratch } = await fixture();
  const dead = await owner(directory); dead.process.kill('SIGKILL'); await dead.exited;
  const filename = join(dead.value.directory, 'owner.json');
  const manifest = JSON.parse(await readFile(filename, 'utf8'));
  for (const identity of [null, { ...manifest.identity, host: '0'.repeat(64) }]) {
    await chmod(filename, 0o600); await writeFile(filename, JSON.stringify({ ...manifest, identity })); await chmod(filename, 0o400);
    const report = await scratch.cleanup(); expect(report.removed).toBe(0); expect(report.skipped[0].reason).toMatch(/unsupported|foreign/);
  }
  await chmod(filename, 0o600); await writeFile(filename, '{}'); await chmod(filename, 0o400);
  const invalid = await scratch.cleanup(); expect(invalid.removed).toBe(0); expect(invalid.incomplete).toBe(true);
});

it('uses managed scratch for actual capture, disposes it, and enforces the production worker boundary', async () => {
  const { directory, scratch } = await fixture();
  const deps = { store: createMemoryStore(), queue: new MemoryQueueAdapter(), logger: new MemoryLogger(), environment: 'production' as const };
  expect(() => createBotWorker(deps)).toThrow('managed');
  expect(() => createBotWorker({ ...deps, captureOptions: { temporaryDirectory: directory } })).toThrow('managed');
  const worker = createBotWorker({ ...deps, captureOptions: { scratch } }); await worker.cancelCaptures();
  const artifact = await captureToFile(new ReadableStream({ start(c) { c.enqueue({ data: new Uint8Array(3200), timestamp: 0, encoding: 'pcm_s16le', sampleRate: 16000, channels: 1 }); c.close(); } }), { recordingFormat: 'audio_only', scratch });
  expect((await readdir(directory)).filter(name => name.startsWith('capture-'))).toHaveLength(1);
  expect((await scratch.cleanup()).removed).toBe(0);
  expect(artifact.duration).toBe(100); await artifact.dispose();
  expect(await readdir(directory)).toEqual(['.recfn-scratch.json']);
  await scratch.close();
  expect(() => createBotWorker({ ...deps, captureOptions: { scratch } })).toThrow('managed');
});

it('continues bounded scans past retained entries and explicitly closes its scan handle', async () => {
  const { directory, scratch } = await fixture();
  await Promise.all(Array.from({ length: 130 }, (_, i) => writeFile(join(directory, `unknown-${i}`), 'retained')));
  const dead = await owner(directory); dead.process.kill('SIGKILL'); await dead.exited;
  const seen = new Set<string>(); let removed = 0; let completed = false;
  for (let i = 0; i < 50; i++) {
    const report = await scratch.cleanup({ maxEntries: 3 }); expect(report.examined).toBeLessThanOrEqual(3);
    for (const entry of report.skipped) seen.add(entry.entry);
    removed += report.removed;
    if (!report.incomplete) { completed = true; break; }
  }
  expect(completed).toBe(true); expect(removed).toBe(1); expect(seen.size).toBe(130);
  const running = scratch.cleanup({ maxEntries: 1 });
  await expect(scratch.cleanup()).rejects.toThrow('already running'); await running;
  await scratch.close(); await expect(scratch.allocate()).rejects.toThrow('closed');
});

it('refuses writable or hard-linked owner metadata before reclaiming files', async () => {
  const { parent, directory, scratch } = await fixture();
  const dead = await owner(directory); dead.process.kill('SIGKILL'); await dead.exited;
  const filename = join(dead.value.directory, 'owner.json'); const alias = join(parent, 'owner-alias');
  await link(filename, alias);
  expect((await scratch.cleanup()).removed).toBe(0); expect(await readFile(alias, 'utf8')).toContain('root');
  await unlink(alias); await chmod(filename, 0o600);
  const writable = await scratch.cleanup(); expect(writable.removed).toBe(0); expect(writable.skipped[0].reason).toContain('read-only');
  await chmod(filename, 0o400); expect((await scratch.cleanup()).removed).toBe(1);
});

it('distinguishes same-boot foreign namespaces from simulated prior-boot owners', async () => {
  const { directory, scratch } = await fixture();
  const dead = await owner(directory); dead.process.kill('SIGKILL'); await dead.exited;
  const filename = join(dead.value.directory, 'owner.json'); const manifest = JSON.parse(await readFile(filename, 'utf8'));
  await chmod(filename, 0o600);
  await writeFile(filename, JSON.stringify({ ...manifest, identity: { ...manifest.identity, namespace: '0'.repeat(64) } })); await chmod(filename, 0o400);
  const foreign = await scratch.cleanup(); expect(foreign.removed).toBe(0); expect(foreign.skipped[0].reason).toBe('foreign-pid-namespace');
  await chmod(filename, 0o600);
  await writeFile(filename, JSON.stringify({ ...manifest, identity: { ...manifest.identity, boot: '0'.repeat(64) } })); await chmod(filename, 0o400);
  expect((await scratch.cleanup()).removed).toBe(1);
});

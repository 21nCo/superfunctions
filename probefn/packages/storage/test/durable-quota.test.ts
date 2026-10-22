import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir, symlink, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import { ArtifactStore } from '../src/artifact-store.js';
import { stopTracing } from '../../browser-runner/src/trace.js';
const roots: string[] = [];
const target = (name: string, run = 'run') => `.artifacts/runs/${run}/${name}`;
async function root() { const directory = await mkdtemp(path.join(tmpdir(), 'probe-durable-quota-')); roots.push(directory); return directory; }
const store = (repoRoot: string, maxArtifactBytes = 10) => new ArtifactStore({ repoRoot, caps: { maxArtifactBytes } });
afterEach(async () => { await Promise.all(roots.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });

it('shares a persisted run budget across instances and reopen, independently per run', async () => {
  const directory = await root();
  const results = await Promise.allSettled([store(directory).writeArtifact(target('one'), '123456'), store(directory).writeArtifact(target('two'), '123456')]);
  expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
  await expect(store(directory, 1000).writeArtifact(target('three'), '12345')).rejects.toMatchObject({ code: 'E_STORAGE_CAP_EXCEEDED' });
  await store(directory).writeArtifact(target('one', 'other'), '1234567890');
});

it('enforces run and session-state accounting when the artifact root is the repository root', async () => {
  const directory = await root();
  const direct = new ArtifactStore({ repoRoot: directory, artifactRoot: '.', caps: { maxArtifactBytes: 2 } });
  await direct.writeArtifact('runs/run/one', '12');
  await expect(direct.writeArtifact('runs/run/two', '3')).rejects.toMatchObject({ code: 'E_STORAGE_CAP_EXCEEDED' });
  await expect(direct.writeArtifact('session-state/session.json', 'x')).rejects.toMatchObject({ code: 'E_STORAGE_WRITE_FAILED' });
  await expect(direct.writeArtifact('.quota.sqlite', 'x')).rejects.toMatchObject({ code: 'E_STORAGE_WRITE_FAILED' });
});

it('counts existing bytes and atomic replacement peak, and reclaims actual deletion', async () => {
  const directory = await root();
  await store(directory).writeArtifact(target('one'), '123456');
  await expect(store(directory).writeArtifact(target('one'), '12345')).rejects.toMatchObject({ code: 'E_STORAGE_CAP_EXCEEDED' });
  expect(await readFile(path.join(directory, target('one')), 'utf8')).toBe('123456');
  await store(directory).writeArtifact(target('one'), '12'); // Existing6 + staged2 fits.
  await store(directory).writeArtifact(target('two'), '12345678');
  await store(directory).deleteArtifact(target('one'));
  await store(directory).writeArtifact(target('three'), 'xx');
});

it('persists lowered caps without deleting artifacts and permits explicit deletion recovery', async () => {
  const directory = await root(); await store(directory).writeArtifact(target('one'), '123456');
  await expect(store(directory, 4).writeArtifact(target('two'), '')).rejects.toMatchObject({ code: 'E_STORAGE_CAP_EXCEEDED' });
  expect(await readFile(path.join(directory, target('one')), 'utf8')).toBe('123456');
  await store(directory).deleteArtifact(target('one'));
  await expect(store(directory).writeArtifact(target('two'), '12345')).rejects.toMatchObject({ code: 'E_STORAGE_CAP_EXCEEDED' });
  await store(directory).writeArtifact(target('two'), '1234');
});

it('cleans failed streams without consuming nonexistent bytes or losing previous content', async () => {
  const directory = await root(); await store(directory).writeArtifact(target('one'), '12');
  await expect(store(directory).writeArtifactStream(target('one'), async write => { await write('345'); throw new Error('producer failed'); })).rejects.toMatchObject({ code: 'E_STORAGE_WRITE_FAILED' });
  expect(await readFile(path.join(directory, target('one')), 'utf8')).toBe('12');
  expect(await readdir(path.join(directory, target('.probefn-staging')))).toEqual([]);
  await store(directory).writeArtifact(target('two'), '12345678');
});

it('serializes non-awaited producer writes and accounts raw binary byte lengths', async () => {
  const directory = await root();
  await store(directory).writeArtifactStream(target('one'), async write => { void write(new Uint8Array([0, 255])); void write('😀'); });
  expect((await readFile(path.join(directory, target('one')))).length).toBe(6);
  await expect(store(directory).writeArtifact(target('two'), '12345')).rejects.toMatchObject({ code: 'E_STORAGE_CAP_EXCEEDED' });
});

it('reconciles preexisting artifacts, rejects links and prevents accounting path escapes', async () => {
  const directory = await root(); await mkdir(path.join(directory, target('')), { recursive: true });
  await writeFile(path.join(directory, target('external')), '12345678');
  await expect(store(directory).writeArtifact(target('one'), 'abc')).rejects.toMatchObject({ code: 'E_STORAGE_CAP_EXCEEDED' });
  await symlink(path.join(directory, target('external')), path.join(directory, target('link')));
  await expect(store(directory).writeArtifact(target('one'), 'a')).rejects.toMatchObject({ code: 'E_STORAGE_WRITE_FAILED' });
  expect(() => store(directory).createEventSink('run', 'events', 'checkpoints/../../escape')).toThrow();
  await expect(store(directory).writeArtifact('.artifacts/.quota.sqlite', 'bad')).rejects.toMatchObject({ code: 'E_STORAGE_WRITE_FAILED' });
});

it('includes externally located session state in its run volume', async () => {
  const directory = await root();
  await store(directory).writeArtifact('.artifacts/session-state/session.json', '123456', { runId: 'run' });
  await expect(store(directory).writeArtifact(target('one'), '12345')).rejects.toMatchObject({ code: 'E_STORAGE_CAP_EXCEEDED' });
  await expect(store(directory).writeArtifact('.artifacts/session-state/session.json', 'x')).rejects.toMatchObject({ code: 'E_STORAGE_WRITE_FAILED' });
  await expect(store(directory).writeArtifactStream('.artifacts/session-state/session.json', write => write('x'))).rejects.toMatchObject({ code: 'E_STORAGE_WRITE_FAILED' });
  await expect(store(directory).writeArtifactStream('.artifacts/session-state/session.json', write => write('12345'), { runId: 'run' })).rejects.toMatchObject({ code: 'E_STORAGE_CAP_EXCEEDED' });
  await expect(store(directory).writeArtifact('.artifacts/session-state/session.json', 'x', { runId: 'other' })).rejects.toMatchObject({ code: 'E_STORAGE_WRITE_FAILED' });
  await expect(store(directory).writeArtifact(target('one'), 'x', { runId: 'other' })).rejects.toMatchObject({ code: 'E_STORAGE_WRITE_FAILED' });
});

it('preserves per-file event counts across instances, concurrent append and reopen', async () => {
  const directory = await root();
  const append = () => store(directory, 1000).createEventSink('run', 'console', 'events', { policy: { maxEventsPerSink: 2 } }).append({});
  const results = await Promise.all(Array.from({ length: 5 }, append));
  expect(results.map(result => result.sinkIndex)).toEqual([1, 1, 2, 2, 3]);
  expect((await append()).eventCount).toBe(2);
  const errorSink = store(directory, 1000).createEventSink('run', 'console', 'events', { policy: { maxEventsPerSink: 2, strategy: 'error' } });
  await expect(errorSink.append({})).rejects.toMatchObject({ code: 'E_STORAGE_CAP_EXCEEDED' });
  await writeFile(path.join(directory, target('events/console-0003.ndjson')), '{');
  await expect(append()).rejects.toMatchObject({ code: 'E_STORAGE_WRITE_FAILED' });
});

it('admits external trace output through capped import and cleans its scratch on rejection', async () => {
  const directory = await root(); let scratch = '';
  const context = { tracing: { stop: async ({ path: filename }: {path: string}) => { scratch = filename; await writeFile(filename, '12345678901'); } } };
  await expect(stopTracing(context as never, { repoRoot: directory, runId: 'run', enabled: true, artifactStore: store(directory) })).rejects.toMatchObject({ code: 'E_STORAGE_CAP_EXCEEDED' });
  await expect(stat(scratch)).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(stat(path.join(directory, target('browser.trace.zip')))).rejects.toMatchObject({ code: 'ENOENT' });
  context.tracing.stop = async ({ path: filename }) => { scratch = filename; await writeFile(filename, '123456'); };
  expect(await stopTracing(context as never, { repoRoot: directory, runId: 'run', enabled: true, artifactStore: store(directory) })).toBe(target('browser.trace.zip'));
  await expect(store(directory).writeArtifact(target('screenshot.png'), Buffer.alloc(5))).rejects.toMatchObject({ code: 'E_STORAGE_CAP_EXCEEDED' });
});

const childFixture = fileURLToPath(new URL('./fixtures/quota-child.ts', import.meta.url));
const jiti = fileURLToPath(new URL('../../../../node_modules/jiti/lib/jiti-cli.mjs', import.meta.url));
function child(directory: string, mode: string, name = '') {
  const processHandle = spawn(process.execPath, [jiti, childFixture, directory, mode, name], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  processHandle.stdout.on('data', chunk => { stdout += chunk; }); processHandle.stderr.on('data', chunk => { stderr += chunk; });
  const exited = once(processHandle, 'exit');
  return { processHandle, exited, output: () => ({ stdout, stderr }) };
}
it('serializes independent native processes against one durable cap', async () => {
  for (let round = 0; round < 5; round++) {
    const directory = await root(); const processes = Array.from({ length: 4 }, (_, index) => child(directory, 'write', `file-${index}`));
    await Promise.all(processes.map(item => item.exited));
    const results = processes.map(item => JSON.parse(item.output().stdout.trim()));
    expect(results.filter(result => result.ok)).toHaveLength(1);
    expect(results.filter(result => !result.ok).map(result => result.code), JSON.stringify(results)).toEqual(Array(3).fill('E_STORAGE_CAP_EXCEEDED'));
  }
}, 30_000);

it('releases an OS lock after SIGKILL and reconciles abandoned staged bytes without resetting cap', async () => {
  const directory = await root(); const processHandle = child(directory, 'crash');
  try {
    const deadline = Date.now() + 15_000;
    while (!processHandle.output().stdout.includes('READY')) {
      if (processHandle.processHandle.exitCode !== null || Date.now() > deadline) throw new Error(JSON.stringify(processHandle.output()));
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    processHandle.processHandle.kill('SIGKILL'); await processHandle.exited;
    await store(directory, 1000).writeArtifact(target('after'), '12345678');
    expect(await readdir(path.join(directory, target('.probefn-staging')))).toEqual([]);
    expect(await readFile(path.join(directory, target('existing')), 'utf8')).toBe('xx');
    await expect(store(directory, 1000).writeArtifact(target('overflow'), 'x')).rejects.toMatchObject({ code: 'E_STORAGE_CAP_EXCEEDED' });
  } finally { if (processHandle.processHandle.exitCode === null && processHandle.processHandle.signalCode === null) { processHandle.processHandle.kill('SIGKILL'); await processHandle.exited; } }
}, 30_000);

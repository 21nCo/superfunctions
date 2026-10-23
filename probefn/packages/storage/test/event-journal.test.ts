import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { appendFile, mkdtemp, readFile, rm, stat, writeFile, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it } from 'vitest';
import { ArtifactStore } from '../src/artifact-store.js';
const roots: string[] = [];
const children: ChildProcess[] = [];
const filename = '.artifacts/runs/run/events/console.ndjson';
async function root() { const value = await mkdtemp(path.join(tmpdir(), 'probe-event-journal-')); roots.push(value); return value; }
async function interrupted(directory: string, mode: string) {
  const child = spawn(process.execPath, [fileURLToPath(new URL('./fixtures/event-crash-child.mjs', import.meta.url)), directory, mode], { stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  let stderr = '';
  child.stderr!.on('data', bytes => { stderr += String(bytes); });
  await new Promise<void>((resolve, reject) => {
    let stdout = '';
    const timer = setTimeout(() => reject(new Error(`child deadline: ${stderr}`)), 10000);
    child.stdout!.on('data', bytes => { stdout += String(bytes); if (stdout.includes('READY')) { clearTimeout(timer); resolve(); } });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`child exit ${code}: ${stderr}`)); });
  });
  return child;
}
async function kill(child: ChildProcess) { const ended = once(child, 'exit'); child.kill('SIGKILL'); await ended; children.splice(children.indexOf(child), 1); }
afterEach(async () => {
  for (const child of children.splice(0)) { if (child.exitCode === null && child.signalCode === null) { const ended = once(child, 'exit'); child.kill('SIGKILL'); await ended; } }
  await Promise.all(roots.splice(0).map(value => rm(value, { recursive: true, force: true })));
});
for (const mode of ['before', 'partial', 'after']) it(`recovers independent process death ${mode} the append without duplicates`, async () => {
  const directory = await root();
  const store = new ArtifactStore({ repoRoot: directory });
  await store.createEventSink('run', 'console', 'events').append({ message: 'prior' });
  const prior = await readFile(path.join(directory, filename), 'utf8');
  const child = await interrupted(directory, mode);
  await expect(new ArtifactStore({ repoRoot: directory }).recoverEventWrites('run')).rejects.toMatchObject({ code: 'E_SESSION_ALREADY_RUNNING' });
  await kill(child);
  expect((await stat(path.join(directory, '.artifacts/.quota.sqlite'))).mode & 0o777).toBe(0o600);
  const dbBytes = await readFile(path.join(directory, '.artifacts/.quota.sqlite'));
  expect(dbBytes.includes(Buffer.from('PRIVATE_SECRET_MUST_NOT_PERSIST'))).toBe(false);
  const reopened = new ArtifactStore({ repoRoot: directory });
  expect(await reopened.recoverEventWrites('run')).toEqual({ failed: false });
  const recovered = await readFile(path.join(directory, filename), 'utf8');
  expect(recovered.startsWith(prior)).toBe(true);
  expect(recovered.trim().split('\n')).toHaveLength(2);
  expect(recovered).toContain('😀 durable');
  expect(recovered).not.toContain('PRIVATE_SECRET_MUST_NOT_PERSIST');
  expect(await reopened.recoverEventWrites('run')).toEqual({ failed: false });
  expect(await readFile(path.join(directory, filename), 'utf8')).toBe(recovered);
  expect((await reopened.createEventSink('run', 'console', 'events').append({ message: 'next' })).eventCount).toBe(3);
}, 20000);

it('refuses unrelated appended bytes and retains the pending intent without truncation', async () => {
  const directory = await root(); const child = await interrupted(directory, 'partial'); await kill(child);
  await appendFile(path.join(directory, filename), 'EXTERNAL');
  const before = await readFile(path.join(directory, filename));
  await expect(new ArtifactStore({ repoRoot: directory }).recoverEventWrites('run')).rejects.toMatchObject({ code: 'E_STORAGE_WRITE_FAILED' });
  expect(await readFile(path.join(directory, filename))).toEqual(before);
  const db = new DatabaseSync(path.join(directory, '.artifacts/.quota.sqlite'));
  try { expect(db.prepare('SELECT count(*) AS n FROM event_append_intents').get()!.n).toBe(1); } finally { db.close(); }
});

it('retains rejected event failure across restart and successful later writes', async () => {
  const directory = await root(); const store = new ArtifactStore({ repoRoot: directory, caps: { maxArtifactBytes: 1000 } });
  await expect(store.createEventSink('run', 'console', 'events').append({ message: 'x'.repeat(1000) })).rejects.toMatchObject({ code: 'E_STORAGE_CAP_EXCEEDED' });
  const reopened = new ArtifactStore({ repoRoot: directory });
  expect(await reopened.recoverEventWrites('run')).toEqual({ failed: true });
  await reopened.createEventSink('run', 'console', 'events').append({ message: 'later' });
  expect(await reopened.recoverEventWrites('run')).toEqual({ failed: true });
});

it('rejects a changed existing prefix even if the intended suffix is intact', async () => {
  const directory = await root(); await new ArtifactStore({ repoRoot: directory }).createEventSink('run', 'console', 'events').append({ message: 'prior' });
  const child = await interrupted(directory, 'after'); await kill(child);
  const bytes = await readFile(path.join(directory, filename)); bytes[2] = 88;
  await writeFile(path.join(directory, filename), bytes);
  await expect(new ArtifactStore({ repoRoot: directory }).recoverEventWrites('run')).rejects.toMatchObject({ code: 'E_STORAGE_WRITE_FAILED' });
  expect(await readFile(path.join(directory, filename))).toEqual(bytes);
});

it('keeps a failure latch when killed before the intent commit and never invents the lost event', async () => {
  const directory = await root(); const child = await interrupted(directory, 'uncommitted'); await kill(child);
  const reopened = new ArtifactStore({ repoRoot: directory });
  expect(await reopened.recoverEventWrites('run')).toEqual({ failed: true });
  expect(await readFile(path.join(directory, filename), 'utf8')).toBe('');
});

it('recovers rollover counts and retains earlier failure provenance', async () => {
  const directory = await root(); const store = new ArtifactStore({ repoRoot: directory, caps: { maxEventsPerSink: 1 } });
  await store.createEventSink('run', 'console', 'events').append({ message: 'first' });
  await expect(store.createEventSink('run', 'console', 'events', { policy: { strategy: 'error' } }).append({ message: 'rejected' })).rejects.toMatchObject({ code: 'E_STORAGE_CAP_EXCEEDED' });
  const child = await interrupted(directory, 'after'); await kill(child);
  const reopened = new ArtifactStore({ repoRoot: directory });
  expect(await reopened.recoverEventWrites('run')).toEqual({ failed: true });
  expect((await readFile(path.join(directory, filename), 'utf8')).trim().split('\n')).toHaveLength(1);
  expect((await readFile(path.join(directory, filename.replace('.ndjson', '-0002.ndjson')), 'utf8')).trim().split('\n')).toHaveLength(1);
  expect((await reopened.createEventSink('run', 'console', 'events').append({ message: 'third' })).sinkIndex).toBe(3);
});

it('bounds temporary serialized journal bytes before writing the event', async () => {
  const directory = await root();
  const store = new ArtifactStore({ repoRoot: directory, caps: { maxArtifactBytes: 100 } });
  await expect(store.createEventSink('run', 'console', 'events').append({ message: 'small' })).rejects.toMatchObject({ code: 'E_STORAGE_CAP_EXCEEDED' });
  expect(await readFile(path.join(directory, filename), 'utf8')).toBe('');
  expect(await store.recoverEventWrites('run')).toEqual({ failed: true });
});

it('upgrades the stopped-writer legacy schema idempotently and refuses unknown versions', async () => {
  const directory = await root();
  const store = new ArtifactStore({ repoRoot: directory });
  await store.writeArtifact('.artifacts/runs/run/existing', 'old');
  const dbPath = path.join(directory, '.artifacts/.quota.sqlite');
  let db = new DatabaseSync(dbPath);
  db.exec('DROP TABLE event_append_intents; DROP TABLE event_journal_schema; ALTER TABLE run_caps DROP COLUMN event_failed; ALTER TABLE sink_counts DROP COLUMN chain_digest'); db.close();
  await store.createEventSink('run', 'console', 'events').append({ legacy: true });
  expect(await new ArtifactStore({ repoRoot: directory }).recoverEventWrites('run')).toEqual({ failed: false });
  expect(await readFile(path.join(directory, '.artifacts/runs/run/existing'), 'utf8')).toBe('old');
  db = new DatabaseSync(dbPath); db.exec('UPDATE event_journal_schema SET version=99'); db.close();
  await expect(store.recoverEventWrites('run')).rejects.toMatchObject({ code: 'E_STORAGE_WRITE_FAILED' });
});

it('rejects external changes between prefix inspection and journal admission', async () => {
  const directory = await root(); const store = new ArtifactStore({ repoRoot: directory });
  await store.createEventSink('run', 'console', 'events').append({ message: 'prior' });
  const child = spawn(process.execPath, [fileURLToPath(new URL('./fixtures/event-crash-child.mjs', import.meta.url)), directory, 'race'], { stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child); let stdout = '', stderr = '';
  child.stdout!.on('data', bytes => { stdout += String(bytes); }); child.stderr!.on('data', bytes => { stderr += String(bytes); });
  const [code] = await once(child, 'exit'); children.splice(children.indexOf(child), 1);
  expect(code, stderr).toBe(0); expect(JSON.parse(stdout)).toEqual({ code: 'E_STORAGE_WRITE_FAILED' });
  const records = (await readFile(path.join(directory, filename), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  expect(records).toEqual([{ message: 'prior' }, { external: true }]);
  expect(await store.recoverEventWrites('run')).toEqual({ failed: true });
});


it('refuses a replacement file with identical bytes and leaves both files untouched', async () => {
  const directory = await root(); const child = await interrupted(directory, 'after'); await kill(child);
  const absolute = path.join(directory, filename), saved = absolute + '.saved';
  const bytes = await readFile(absolute); await rename(absolute, saved); await writeFile(absolute, bytes);
  await expect(new ArtifactStore({ repoRoot: directory }).recoverEventWrites('run')).rejects.toMatchObject({ code: 'E_STORAGE_WRITE_FAILED' });
  expect(await readFile(absolute)).toEqual(bytes); expect(await readFile(saved)).toEqual(bytes);
});

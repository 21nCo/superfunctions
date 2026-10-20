import { afterEach, describe, expect, it, vi } from 'vitest';
import SQLite from 'better-sqlite3';
import { Kysely, SqliteDialect } from 'kysely';
import { kyselyAdapter, memoryAdapter } from '@superfunctions/db/adapters';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseStore } from './database-store.js';
import { CIFN_STATE_TABLE, CIFN_SQLITE_SCHEMA } from './database-schema.js';
import { createRuntimeStore } from './runtime-store.js';
import { createApp } from '../api/routes.js';
import { createControlPlaneServer } from '../http-server.js';
import { MemorySecFnClient } from '../secrets/secfn-client.js';
import type { CreateRunInput } from './memory-store.js';

const key = Buffer.alloc(32, 71);
const secret = 'secret-that-must-survive-redaction-without-plaintext-storage';
const input: CreateRunInput = {
  trigger: { type: 'workflow_dispatch' }, pipelineRef: { repo: 'repo', ref: 'main' },
  pipelineSpec: { name: 'durable', on: { workflow_dispatch: {} }, env: { TOKEN: '${{ secrets.TOKEN }}' }, jobs: {
    build: { 'runs-on': 'default', steps: [{ run: 'echo build' }, { run: 'echo finish' }] },
    test: { 'runs-on': 'default', needs: ['build'], steps: [{ run: 'echo test' }] },
  } },
};
const directories: string[] = [];
const connections: Kysely<any>[] = [];
const servers: ReturnType<typeof createControlPlaneServer>[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); })));
  await Promise.all(connections.splice(0).map(sql => sql.destroy()));
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});
async function location() {
  const directory = await mkdtemp(join(tmpdir(), 'cifn-durable-')); directories.push(directory);
  return { directory, path: join(directory, 'state.sqlite') };
}
async function open(path: string, namespace = 'first', encryptionKey = key) {
  const native = new SQLite(path);
  native.pragma('journal_mode = WAL'); native.pragma('synchronous = FULL');
  native.exec(CIFN_SQLITE_SCHEMA);
  const sql = new Kysely({ dialect: new SqliteDialect({ database: native }) }); connections.push(sql);
  const database = kyselyAdapter({ db: sql, dialect: 'sqlite', schema: { [CIFN_STATE_TABLE]: CIFN_STATE_TABLE } });
  const store = await DatabaseStore.open({ database, encryptionKey, namespace });
  return { store, sql, native, database };
}
async function close(sql: Kysely<any>) {
  await sql.destroy(); connections.splice(connections.indexOf(sql), 1);
}
async function serve(app: ReturnType<typeof createApp>['app']) {
  const server = createControlPlaneServer(app); servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw Error('No listener');
  return `http://127.0.0.1:${address.port}`;
}

describe('real SQLite durable control-plane state', () => {
  it('preserves queued/running jobs, steps, runners, artifacts and encrypted redaction values across close/reopen', async () => {
    const { path, directory } = await location();
    let opened = await open(path);
    const queued = await opened.store.createRun(input);
    const running = await opened.store.createRun(input);
    const terminal = await opened.store.createRun(input);
    await opened.store.updateRunStatus(running.id, 'running');
    await opened.store.updateJobStatus(running.id, 'build', 'running', '2030-01-01T00:00:00.000Z');
    await opened.store.updateStepStatus(running.id, 'build', 'step-0', 'success', '2030-01-01T00:00:00.000Z', '2030-01-01T00:01:00.000Z');
    await opened.store.updateStepStatus(running.id, 'build', 'step-1', 'running');
    await opened.store.updateRunStatus(terminal.id, 'success');
    await opened.store.addArtifact(running.id, { name: 'result', fileId: 'file-1' });
    await opened.store.registerJobSecretValues(running.id, 'build', [secret, secret]);
    const runner = await opened.store.createRunner(['default', 'linux'], 'already-hashed-secret');
    const expected = await opened.store.getRun(running.id);
    await close(opened.sql);
    for (const file of await readdir(directory)) {
      const bytes = await readFile(join(directory, file));
      expect(bytes.includes(Buffer.from(secret))).toBe(false);
      expect(bytes.includes(Buffer.from('already-hashed-secret'))).toBe(false);
      expect(bytes.includes(Buffer.from(key.toString('base64')))).toBe(false);
    }
    opened = await open(path);
    expect(await opened.store.getRun(running.id)).toEqual(expected);
    expect((await opened.store.getRun(queued.id))?.jobs.every(job => job.status === 'pending')).toBe(true);
    expect(await opened.store.getArtifacts(running.id)).toEqual([{ name: 'result', fileId: 'file-1' }]);
    expect(await opened.store.getSecretValues(running.id)).toEqual([secret]);
    expect(await opened.store.getRunner(runner.id)).toEqual(runner);
    const recovery = await opened.store.listRecoveryCandidates();
    expect(recovery.candidates.map(value => value.run.id).sort()).toEqual([queued.id, running.id].sort());
    expect(recovery.candidates.every(value => JSON.stringify(value.definition) === JSON.stringify(input))).toBe(true);
    expect(JSON.stringify(recovery)).not.toContain(secret);
    expect((await opened.store.getRun(terminal.id))?.status).toBe('success');
    expect(await opened.store.updateRunStatus(terminal.id, 'running')).toBeUndefined();
    expect(await opened.store.cancelRun(terminal.id)).toEqual({ error: 'ALREADY_FINISHED' });
    expect(await opened.store.cancelRun(queued.id)).toMatchObject({ run: { status: 'cancelled' } });
    expect((await opened.store.listRecoveryCandidates()).candidates.map(value => value.run.id)).toEqual([running.id]);
  });

  it('keeps namespace boundaries and bounded pagination stable across reopen and timestamp ties', async () => {
    const { path } = await location();
    let first = await open(path, 'tenant-a');
    const second = await open(path, 'tenant-b');
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2030-01-01T00:00:00Z'));
    const ids: string[] = [];
    for (let i = 0; i < 7; i++) ids.push((await first.store.createRun(input)).id);
    const foreign = await second.store.createRun(input);
    expect(await first.store.getRun(foreign.id)).toBeUndefined();
    expect(await first.store.cancelRun(foreign.id)).toEqual({ error: 'NOT_FOUND' });
    const page = await first.store.listRuns({ limit: 2 });
    await close(first.sql); first = await open(path, 'tenant-a');
    const actual = page.runs.map(run => run.id);
    let cursor = page.nextCursor;
    while (cursor) {
      const next = await first.store.listRuns({ limit: 2, cursor });
      actual.push(...next.runs.map(run => run.id)); cursor = next.nextCursor;
    }
    expect(actual).toEqual([...ids].sort().reverse());
    expect(await first.store.listRuns({ cursor: foreign.id })).toEqual({ runs: [], nextCursor: undefined });
    expect((await second.store.listRuns()).runs.map(run => run.id)).toEqual([foreign.id]);
  });

  it('uses optimistic revisions across independent connections without losing artifacts, secrets or step updates', async () => {
    const { path } = await location();
    const [first, second] = await Promise.all([open(path), open(path)]);
    const run = await first.store.createRun(input);
    await Promise.all([
      first.store.addArtifact(run.id, { name: 'first', fileId: 'one' }),
      second.store.addArtifact(run.id, { name: 'second', fileId: 'two' }),
      first.store.registerJobSecretValues(run.id, 'build', ['one-secret']),
      second.store.registerJobSecretValues(run.id, 'test', ['two-secret']),
      first.store.updateStepStatus(run.id, 'build', 'step-0', 'success'),
      second.store.updateStepStatus(run.id, 'build', 'step-1', 'running'),
    ]);
    expect((await first.store.getArtifacts(run.id)).map(value => value.name).sort()).toEqual(['first', 'second']);
    expect((await first.store.getSecretValues(run.id)).sort()).toEqual(['one-secret', 'two-secret']);
    expect((await first.store.getRun(run.id))?.jobs[0].steps.map(step => step.status)).toEqual(['success', 'running']);
    const callbacks: string[] = [];
    first.store.setRunStatusChangeCallback(value => callbacks.push(value.status));
    second.store.setRunStatusChangeCallback(value => callbacks.push(value.status));
    const results = await Promise.all([first.store.updateRunStatus(run.id, 'success'), second.store.updateRunStatus(run.id, 'failure')]);
    expect(results.filter(Boolean)).toHaveLength(1); expect(callbacks).toHaveLength(1);
  });

  it('fails closed for a wrong key or corrupted ciphertext and does not expose secret material', async () => {
    const { path } = await location();
    const first = await open(path);
    const run = await first.store.createRun(input);
    await first.store.registerJobSecretValues(run.id, 'build', [secret]);
    await expect(open(path, 'first', Buffer.alloc(32, 72))).rejects.toThrow('could not be authenticated');
    first.native.prepare("UPDATE cifn_state SET status = 'failure' WHERE kind = 'run'").run();
    await expect(first.store.getRun(run.id)).rejects.toThrow('could not be authenticated');
    try { await first.store.getSecretValues(run.id); } catch (cause) { expect(String(cause)).not.toContain(secret); }
  });

  it('refuses to replace missing metadata around existing encrypted records', async () => {
    const { path } = await location();
    const first = await open(path);
    await first.store.createRun(input);
    first.native.prepare("DELETE FROM cifn_state WHERE kind = 'meta'").run();
    await expect(open(path)).rejects.toThrow('metadata is missing');
    await expect(open(path, 'first', Buffer.alloc(32, 72))).rejects.toThrow('metadata is missing');
  });

  it('does not acknowledge failed persistence or dispatch a run after a native database failure', async () => {
    const { path } = await location(); const { store, native } = await open(path);
    native.exec("CREATE TRIGGER fail_run BEFORE INSERT ON cifn_state WHEN NEW.kind = 'run' BEGIN SELECT RAISE(ABORT, 'write rejected'); END");
    const secrets = new MemorySecFnClient(); await secrets.setSecret('CIFN_API_KEYS', 'key');
    const { app, queue } = createApp({ store, secFn: secrets });
    const response = await app.request('http://localhost/api/v1/runs', { method: 'POST', headers: { Authorization: 'Bearer key' }, body: JSON.stringify(input) });
    expect(response.status).toBe(500);
    expect((await store.listRuns()).runs).toEqual([]);
    expect(queue.size('cifn:jobs')).toBe(0);
  });

  it('restores runner authentication and log redaction through HTTP after reopening SQLite', async () => {
    const { path } = await location(); let opened = await open(path);
    const secrets = new MemorySecFnClient();
    await secrets.setSecret('CIFN_API_KEYS', 'api-key');
    await secrets.setSecret('CIFN_RUNNER_REGISTRATION_TOKEN', 'registration-token');
    const run = await opened.store.createRun(input);
    await opened.store.registerJobSecretValues(run.id, 'build', [secret]);
    let app = createApp({ store: opened.store, secFn: secrets }).app;
    const registrationResponse = await app.request('http://localhost/api/v1/runners/register', { method: 'POST', body: JSON.stringify({ token: 'registration-token' }) });
    const registration = await registrationResponse.json() as { data: { runnerId: string; runnerSecret: string } };
    await close(opened.sql); opened = await open(path);
    app = createApp({ store: opened.store, secFn: secrets, logClient: { getLines: () => [{ line: `token=${secret}`, timestamp: 'now', stepKey: 'step-0' }] } }).app;
    const url = await serve(app);
    const heartbeat = await fetch(url + '/api/v1/runners/heartbeat', { method: 'POST', headers: { Authorization: `Bearer ${registration.data.runnerSecret}` }, body: JSON.stringify({ runnerId: registration.data.runnerId }) });
    expect(heartbeat.status).toBe(200);
    const logs = await fetch(url + `/api/v1/runs/${run.id}/jobs/build/logs`, { headers: { Authorization: 'Bearer api-key' } });
    expect(await logs.json()).toMatchObject({ ok: true, data: { lines: [{ line: 'token=***' }] } });
    const detail = await fetch(url + `/api/v1/runs/${run.id}`, { headers: { Authorization: 'Bearer api-key' } });
    expect(await detail.text()).not.toContain(secret);
  });
});

it('requires explicit key/storage configuration and never silently falls back to memory', async () => {
  await expect(DatabaseStore.open({ database: memoryAdapter(), encryptionKey: key })).rejects.toThrow('persistent database');
  const { path } = await location();
  await expect(createRuntimeStore({ CIFN_STORE_ADAPTER: 'sqlite', CIFN_SQLITE_PATH: path })).rejects.toThrow('deployment key');
  await expect(createRuntimeStore({ CIFN_STORE_ADAPTER: 'typo' })).rejects.toThrow('must be memory or sqlite');
  await expect(createRuntimeStore({ CIFN_STORE_ADAPTER: 'sqlite', CIFN_SQLITE_PATH: ':memory:', CIFN_STORE_ENCRYPTION_KEY: key.toString('base64') })).rejects.toThrow('persistent filesystem');
  const first = await createRuntimeStore({ CIFN_STORE_ADAPTER: 'sqlite', CIFN_SQLITE_PATH: path, CIFN_STORE_ENCRYPTION_KEY: key.toString('base64') });
  const run = await first.store.createRun(input); await first.close();
  const second = await createRuntimeStore({ CIFN_STORE_ADAPTER: 'sqlite', CIFN_SQLITE_PATH: path, CIFN_STORE_ENCRYPTION_KEY: key.toString('base64') });
  try { expect(await second.store.getRun(run.id)).toEqual(run); } finally { await second.close(); }
});

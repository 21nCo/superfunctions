import { handleWebhook } from '../triggers/webhook.js';
import { signWebhookPayload } from '@superfunctions/webhooks';
import { prepareRun, acceptRun } from '../dispatch/prepare.js';
import { publishRun } from '../dispatch/publisher.js';
import { MemoryQueueClient, DEFAULT_QUEUE_NAME } from '../queue/flowfn-client.js';
import { CronScheduler } from '../triggers/cron.js';
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

  it('continues filtered and recovery pages when the boundary run changes status', async () => {
    const { path } = await location(); const { store } = await open(path);
    for (let i = 0; i < 3; i++) await store.createRun(input);
    const recovery = await store.listRecoveryCandidates({ limit: 1 });
    const filtered = await store.listRuns({ limit: 1, status: 'queued' });
    expect(recovery.nextCursor).toBe(filtered.nextCursor);
    await store.updateRunStatus(recovery.candidates[0].run.id, 'success');
    expect((await store.listRecoveryCandidates({ cursor: recovery.nextCursor })).candidates).toHaveLength(2);
    expect((await store.listRuns({ cursor: filtered.nextCursor, status: 'queued' })).runs).toHaveLength(2);
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

  it('commits prepared intent atomically, retries failed delivery after reopen, and claims duplicate messages once', async () => {
    const { path } = await location(); let opened = await open(path);
    const secrets = new MemorySecFnClient();
    await secrets.setSecret('TOKEN', secret);
    await secrets.setSecret('CIFN_RUNNER_REGISTRATION_TOKEN', 'register');
    const queue = new MemoryQueueClient();
    const failing = vi.spyOn(queue, 'enqueue').mockRejectedValueOnce(new Error('transport down'));
    const run = await acceptRun(opened.store, queue, await prepareRun(input, secrets));
    expect(await opened.store.getSecretValues(run.id)).toEqual([secret]);
    expect(queue.size(DEFAULT_QUEUE_NAME)).toBe(0);
    failing.mockRestore();
    await close(opened.sql); opened = await open(path);
    await publishRun(opened.store, queue, run.id, Date.now() + 6_000);
    const message = queue.peek(DEFAULT_QUEUE_NAME)[0];
    expect(message.dispatchId).toBe(JSON.stringify([run.id, 'build', 1]));
    expect(message.env?.TOKEN).toBe(secret);
    await queue.enqueue(DEFAULT_QUEUE_NAME, message);
    await queue.enqueue(DEFAULT_QUEUE_NAME, message);
    const { app } = createApp({ store: opened.store, queue, secFn: secrets });
    const register = async () => {
      const response = await app.request('http://localhost/api/v1/runners/register', { method: 'POST', body: JSON.stringify({ token: 'register' }) });
      return (await response.json() as { data: { runnerId: string; runnerSecret: string } }).data;
    };
    const runners = await Promise.all([register(), register()]);
    const assignments = await Promise.all(runners.map(async runner => {
      const response = await app.request('http://localhost/api/v1/runners/heartbeat', { method: 'POST', headers: { Authorization: `Bearer ${runner.runnerSecret}` }, body: JSON.stringify({ runnerId: runner.runnerId }) });
      expect(response.status).toBe(200);
      return (await response.json() as { data: { job: { claimToken: string } | null } }).data.job;
    }));
    expect(assignments.filter(Boolean)).toHaveLength(1);
    expect(assignments.find(Boolean)?.claimToken).toBeTypeOf('string');
    expect((await opened.store.getRun(run.id))?.status).toBe('running');
    await close(opened.sql); opened = await open(path);
    expect((await opened.store.getDispatchStates(run.id)).filter(value => value.jobKey === 'build')).toMatchObject([{ state: 'claimed', claim: { token: assignments.find(Boolean)?.claimToken } }]);
    expect(await opened.store.leaseDispatches(run.id, Date.now() + 60_000, 5_000)).toEqual([]);
    expect(await opened.store.claimDispatch(run.id, message.dispatchId!, runners[0].runnerId, ['default'])).toBeUndefined();
  });

  it('retries an expired publication lease, rejects stale acknowledgements and never publishes cancelled work', async () => {
    const { path } = await location(); const [first, second] = await Promise.all([open(path), open(path)]);
    const secrets = new MemorySecFnClient(); await secrets.setSecret('TOKEN', secret);
    const run = await first.store.createPreparedRun(await prepareRun(input, secrets));
    const now = Date.now();
    const publications = await Promise.all([first.store.leaseDispatches(run.id, now, 5_000), second.store.leaseDispatches(run.id, now, 5_000)]);
    expect(publications.flat()).toHaveLength(1);
    const original = publications.flat()[0];
    expect(await second.store.leaseDispatches(run.id, now + 4_999, 5_000)).toEqual([]);
    const retried = (await second.store.leaseDispatches(run.id, now + 5_000, 5_000))[0];
    expect(retried.dispatchId).toBe(original.dispatchId);
    expect(retried.publicationToken).not.toBe(original.publicationToken);
    await first.store.finishPublication(run.id, original.dispatchId, original.publicationToken, now + 999_999);
    await second.store.finishPublication(run.id, retried.dispatchId, retried.publicationToken, now + 10_000);
    expect(await first.store.leaseDispatches(run.id, now + 10_000, 5_000)).toHaveLength(1);
    await first.store.cancelRun(run.id);
    expect(await second.store.claimDispatch(run.id, original.dispatchId, 'runner', ['default'])).toBeUndefined();
    expect(await second.store.leaseDispatches(run.id, now + 60_000, 5_000)).toEqual([]);
  });

  it('recovers destructive dequeue when native claim persistence fails before assignment', async () => {
    const { path } = await location(); const { store, native } = await open(path);
    const secrets = new MemorySecFnClient(); await secrets.setSecret('TOKEN', secret); await secrets.setSecret('CIFN_RUNNER_REGISTRATION_TOKEN', 'register');
    const queue = new MemoryQueueClient();
    const run = await acceptRun(store, queue, await prepareRun(input, secrets));
    const { app } = createApp({ store, queue, secFn: secrets });
    const registration = await app.request('http://localhost/api/v1/runners/register', { method: 'POST', body: JSON.stringify({ token: 'register' }) });
    const runner = (await registration.json() as { data: { runnerId: string; runnerSecret: string } }).data;
    const heartbeat = () => app.request('http://localhost/api/v1/runners/heartbeat', { method: 'POST', headers: { Authorization: `Bearer ${runner.runnerSecret}` }, body: JSON.stringify({ runnerId: runner.runnerId }) });
    native.exec("CREATE TRIGGER fail_claim BEFORE UPDATE ON cifn_state WHEN NEW.status = 'running' BEGIN SELECT RAISE(ABORT, 'claim rejected'); END");
    expect((await heartbeat()).status).toBe(500);
    expect(queue.size(DEFAULT_QUEUE_NAME)).toBe(0);
    expect((await store.getDispatchStates(run.id)).filter(value => value.jobKey === 'build')).toMatchObject([{ state: 'ready' }]);
    native.exec('DROP TRIGGER fail_claim');
    await publishRun(store, queue, run.id, Date.now() + 31_000);
    const accepted = await heartbeat(); expect(accepted.status).toBe(200);
    expect(await accepted.json()).toMatchObject({ data: { job: { runId: run.id } } });
    expect((await store.getDispatchStates(run.id)).filter(value => value.jobKey === 'build')).toMatchObject([{ state: 'claimed' }]);
  });

  it('shares encrypted prepared dispatch creation across webhook and cron triggers', async () => {
    const { path } = await location(); const { store } = await open(path);
    const secrets = new MemorySecFnClient(); await secrets.setSecret('TOKEN', secret);
    const queue = new MemoryQueueClient();
    const scheduler = new CronScheduler({ store, queue, secrets });
    const cronId = await scheduler.triggerPipeline({ id: 'cron', spec: input.pipelineSpec, pipelineRef: input.pipelineRef!, cronExpression: '* * * * *' });
    const body = JSON.stringify({ repository: { full_name: 'owner/repo' }, ref: 'refs/heads/main' });
    const signature = signWebhookPayload(body, 'signing', { algorithm: 'sha256', encoding: 'hex', prefix: 'sha256=' });
    const result = await handleWebhook(body, signature, 'push', { store, queue, secFn: secrets, webhookSecret: 'signing',
      pipelineResolver: async () => ({ doc: JSON.stringify(input.pipelineSpec), resolvedConfigPath: 'ci.json' }) });
    expect(result.status).toBe(201);
    expect(queue.peek(DEFAULT_QUEUE_NAME)).toHaveLength(2);
    for (const message of queue.peek(DEFAULT_QUEUE_NAME)) {
      expect(message.env?.TOKEN).toBe(secret);
      expect((await store.getDispatchStates(message.runId)).filter(value => value.jobKey === 'build')).toMatchObject([{ dispatchId: message.dispatchId, state: 'ready' }]);
      expect(await store.getSecretValues(message.runId)).toEqual([secret]);
    }
    expect((await store.getRun(cronId))?.trigger.type).toBe('schedule');
  });

  it('does not store an orphan run when API, webhook or cron preparation fails', async () => {
    const { path } = await location(); const { store } = await open(path);
    const secrets = new MemorySecFnClient(); await secrets.setSecret('CIFN_API_KEYS', 'key');
    const get = secrets.getSecret.bind(secrets);
    vi.spyOn(secrets, 'getSecret').mockImplementation(name => name === 'TOKEN' ? Promise.reject(new Error('provider unavailable')) : get(name));
    const { app, queue } = createApp({ store, secFn: secrets });
    const response = await app.request('http://localhost/api/v1/runs', { method: 'POST', headers: { Authorization: 'Bearer key' }, body: JSON.stringify(input) });
    expect(response.status).toBe(500);
    const scheduler = new CronScheduler({ store, queue, secrets });
    await expect(scheduler.triggerPipeline({ id: 'cron', spec: input.pipelineSpec, pipelineRef: input.pipelineRef!, cronExpression: '* * * * *' })).rejects.toThrow('provider unavailable');
    const body = JSON.stringify({ repository: { full_name: 'owner/repo' }, ref: 'refs/heads/main' });
    const signature = signWebhookPayload(body, 'signing', { algorithm: 'sha256', encoding: 'hex', prefix: 'sha256=' });
    await expect(handleWebhook(body, signature, 'push', { store, queue, secFn: secrets, webhookSecret: 'signing',
      pipelineResolver: async () => ({ doc: JSON.stringify(input.pipelineSpec), resolvedConfigPath: 'ci.json' }) })).rejects.toThrow('provider unavailable');
    expect((await store.listRuns()).runs).toEqual([]);
    expect(queue.size(DEFAULT_QUEUE_NAME)).toBe(0);
  });

  it('binds claim acknowledgement and idempotent completion, atomically releases prepared dependencies and survives reopen', async () => {
    const { path } = await location(); let opened = await open(path);
    const secrets = new MemorySecFnClient(); await secrets.setSecret('TOKEN', secret); await secrets.setSecret('CIFN_RUNNER_REGISTRATION_TOKEN', 'register');
    const queue = new MemoryQueueClient(); const { app } = createApp({ store: opened.store, queue, secFn: secrets });
    const register = async () => (await (await app.request('http://localhost/api/v1/runners/register', { method: 'POST', body: JSON.stringify({ token: 'register' }) })).json() as { data: { runnerId: string; runnerSecret: string } }).data;
    const owner = await register(); const stranger = await register();
    const run = await opened.store.createPreparedRun(await prepareRun(input, secrets));
    const id = JSON.stringify([run.id, 'build', 1]);
    const payload = await opened.store.claimDispatch(run.id, id, owner.runnerId, ['default']);
    const identity = { runId: run.id, dispatchId: id, runnerId: owner.runnerId, claimToken: payload!.claimToken!, executionId: 'execution-one' };
    const call = (action: string, body: unknown, token = owner.runnerSecret) => app.request(`http://localhost/api/v1/runners/claims/${action}`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
    const result = { status: 'success' as const, steps: [{ stepKey: 'step-0', status: 'success' as const }, { stepKey: 'step-1', status: 'success' as const }] };
    expect((await call('complete', { ...identity, result })).status).toBe(409);
    expect((await call('ack', identity, 'wrong-secret')).status).toBe(401);
    expect((await call('ack', { ...identity, runnerId: stranger.runnerId }, stranger.runnerSecret)).status).toBe(409);
    const resume = await call('resume', { runnerId: owner.runnerId });
    expect(await resume.json()).toMatchObject({ data: { claims: [{ dispatchId: id, payload: { env: { TOKEN: secret } } }] } });
    expect(await (await call('resume', { runnerId: stranger.runnerId }, stranger.runnerSecret)).json()).toMatchObject({ data: { claims: [] } });
    expect((await call('ack', identity)).status).toBe(200);
    expect((await call('ack', identity)).status).toBe(200);
    expect((await call('ack', { ...identity, executionId: 'competing-owner' })).status).toBe(409);
    expect((await call('complete', { ...identity, claimToken: 'wrong', result })).status).toBe(409);
    expect((await call('complete', { ...identity, result: { status: 'success', steps: [] } })).status).toBe(409);
    opened.native.exec("CREATE TRIGGER fail_completion BEFORE UPDATE ON cifn_state WHEN NEW.kind = 'run' BEGIN SELECT RAISE(ABORT, 'completion rejected'); END");
    expect((await call('complete', { ...identity, result })).status).toBe(503);
    expect((await opened.store.getDispatchStates(run.id)).map(value => value.state)).toEqual(['claimed', 'blocked']);
    expect((await opened.store.getRun(run.id))?.jobs[0].status).toBe('running');
    opened.native.exec('DROP TRIGGER fail_completion');
    const completions = await Promise.all([call('complete', { ...identity, result }), call('complete', { ...identity, result })]);
    expect(completions.map(value => value.status)).toEqual([200, 200]);
    expect(await completions[0].json()).toEqual(await completions[1].json());
    expect((await call('complete', { ...identity, result: { status: 'failure', steps: [{ stepKey: 'step-0', status: 'failure' }, { stepKey: 'step-1', status: 'skipped' }] } })).status).toBe(409);
    expect((await opened.store.getDispatchStates(run.id)).map(value => value.state)).toEqual(['completed', 'ready']);
    await secrets.setSecret('TOKEN', 'rotated-value');
    await close(opened.sql); opened = await open(path);
    const downstream = (await opened.store.leaseDispatches(run.id, Date.now(), 5_000))[0];
    expect(downstream.payload.jobKey).toBe('test'); expect(downstream.payload.env?.TOKEN).toBe(secret);
    const claim = await opened.store.claimDispatch(run.id, downstream.dispatchId, owner.runnerId, ['default']);
    const nextIdentity = { ...identity, dispatchId: downstream.dispatchId, claimToken: claim!.claimToken!, executionId: 'execution-two' };
    await opened.store.acknowledgeDispatch(nextIdentity);
    await opened.store.completeDispatch(nextIdentity, { status: 'success', steps: [{ stepKey: 'step-0', status: 'success' }] });
    expect((await opened.store.getRun(run.id))?.status).toBe('success');
    expect(await opened.store.completeDispatch(identity, result)).toEqual({ accepted: true });
  });

  it('promotes a join once when independent root completions race', async () => {
    const { path } = await location(); const [first, second] = await Promise.all([open(path), open(path)]);
    const spec = { on: { workflow_dispatch: {} }, jobs: {
      a: { 'runs-on': 'default', steps: [{ run: 'true' }] }, b: { 'runs-on': 'default', steps: [{ run: 'true' }] },
      join: { 'runs-on': 'default', needs: ['a', 'b'], steps: [{ run: 'true' }] },
    } };
    const run = await first.store.createPreparedRun(await prepareRun({ trigger: { type: 'workflow_dispatch' }, pipelineSpec: spec }));
    const identities = [];
    for (const jobKey of ['a', 'b']) {
      const dispatchId = JSON.stringify([run.id, jobKey, 1]);
      const claim = await first.store.claimDispatch(run.id, dispatchId, 'runner', ['default']);
      const identity = { runId: run.id, dispatchId, runnerId: 'runner', claimToken: claim!.claimToken!, executionId: jobKey };
      await first.store.acknowledgeDispatch(identity); identities.push(identity);
    }
    const result = { status: 'success' as const, steps: [{ stepKey: 'step-0', status: 'success' as const }] };
    await Promise.all([first.store.completeDispatch(identities[0], result), second.store.completeDispatch(identities[1], result)]);
    expect((await first.store.getDispatchStates(run.id)).map(value => value.state)).toEqual(['completed', 'completed', 'ready']);
    const deliveries = await first.store.leaseDispatches(run.id, Date.now(), 5_000);
    expect(deliveries).toHaveLength(1); expect(deliveries[0].payload.jobKey).toBe('join');
  });

  it('does not run downstream jobs after failed dependencies or accept completion after cancellation', async () => {
    const { path } = await location(); const { store } = await open(path);
    const secrets = new MemorySecFnClient(); await secrets.setSecret('TOKEN', secret);
    const run = await store.createPreparedRun(await prepareRun(input, secrets));
    const id = JSON.stringify([run.id, 'build', 1]);
    const claim = await store.claimDispatch(run.id, id, 'runner', ['default']);
    const identity = { runId: run.id, dispatchId: id, runnerId: 'runner', claimToken: claim!.claimToken!, executionId: 'execution' };
    await store.acknowledgeDispatch(identity);
    await store.completeDispatch(identity, { status: 'failure', steps: [{ stepKey: 'step-0', status: 'failure' }, { stepKey: 'step-1', status: 'skipped' }] });
    expect((await store.getRun(run.id))?.jobs.map(value => value.status)).toEqual(['failure', 'skipped']);
    expect((await store.getRun(run.id))?.status).toBe('failure');
    expect(await store.leaseDispatches(run.id, Date.now() + 60_000, 5_000)).toEqual([]);
    const cancelled = await store.createPreparedRun(await prepareRun(input, secrets));
    const cancelledId = JSON.stringify([cancelled.id, 'build', 1]);
    const cancelledClaim = await store.claimDispatch(cancelled.id, cancelledId, 'runner', ['default']);
    const cancelledIdentity = { ...identity, runId: cancelled.id, dispatchId: cancelledId, claimToken: cancelledClaim!.claimToken! };
    await store.acknowledgeDispatch(cancelledIdentity); await store.cancelRun(cancelled.id);
    await expect(store.completeDispatch(cancelledIdentity, { status: 'success', steps: [{ stepKey: 'step-0', status: 'success' }, { stepKey: 'step-1', status: 'success' }] })).rejects.toThrow('conflicts');
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

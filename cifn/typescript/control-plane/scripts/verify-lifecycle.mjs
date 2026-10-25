/** Owned native SQLite, real LogFn sink, and killed-owner ambiguity acceptance. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const { DatabaseStore, CIFN_SQLITE_SCHEMA, CIFN_STATE_TABLE, LogFnLifecycleDispatcher, createApp, MemorySecFnClient, prepareRun, logDigest, LogFnStepOutputDispatcher } = require('../dist/index.js');
const SQLite = require('better-sqlite3');
const { Kysely, SqliteDialect } = require('kysely');
const { kyselyAdapter } = await import('@superfunctions/db/adapters');
async function createRuntimeStore(config) {
  const database = new SQLite(config.CIFN_SQLITE_PATH);
  database.pragma('journal_mode = WAL'); database.pragma('synchronous = FULL'); database.exec(CIFN_SQLITE_SCHEMA);
  const sql = new Kysely({ dialect: new SqliteDialect({ database }) });
  try {
    const store = await DatabaseStore.open({ database: kyselyAdapter({ db: sql, dialect: 'sqlite', schema: { [CIFN_STATE_TABLE]: CIFN_STATE_TABLE } }), encryptionKey: Buffer.from(config.CIFN_STORE_ENCRYPTION_KEY, 'base64') });
    return { store, close: () => sql.destroy() };
  } catch (error) { await sql.destroy(); throw error; }
}
async function bounded(operation, ms = 5000) {
  let timer;
  try { return await Promise.race([operation, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Owned lifecycle fixture deadline')), ms); })]); }
  finally { clearTimeout(timer); }
}
const env = path => ({ CIFN_STORE_ADAPTER: 'sqlite', CIFN_SQLITE_PATH: path, CIFN_STORE_ENCRYPTION_KEY: Buffer.alloc(32, 73).toString('base64') });
if (['claim-child', 'claim-output-child'].includes(process.argv[2])) {
  const runtime = await createRuntimeStore(env(process.argv[3]));
  const record = process.argv[2] === 'claim-child' ? await runtime.store.claimLifecycle(process.argv[4], Date.now(), 1) : await runtime.store.claimStepOutput(process.argv[4], Date.now(), 1);
  assert.ok(record);
  process.stdout.write('claimed\n');
  setInterval(() => {}, 1000);
} else {
  const directory = await mkdtemp(join(tmpdir(), 'cifn-lifecycle-'));
  const path = join(directory, 'state.sqlite');
  let runtime, child, server, dispatcher;
  try {
    runtime = await createRuntimeStore(env(path));
    const run = await runtime.store.createRun({ trigger: { type: 'workflow_dispatch' }, pipelineSpec: {
      name: 'owned-lifecycle', on: { workflow_dispatch: {} }, jobs: { build: { 'runs-on': 'default', steps: [{ run: 'not executed' }] } },
    } });
    await runtime.close(); runtime = undefined;
    child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'claim-child', path, run.id], { stdio: ['ignore', 'pipe', 'pipe'] });
    const exited = once(child, 'exit');
    await Promise.race([new Promise((resolve, reject) => {
      child.stdout.once('data', bytes => bytes.toString().includes('claimed') ? resolve() : reject(Error('Invalid child receipt')));
      child.once('error', reject); child.once('exit', () => reject(Error('Claim child exited before receipt')));
    }), new Promise((_, reject) => { const timer = setTimeout(() => reject(Error('Claim child deadline')), 10_000); timer.unref(); })]);
    child.kill('SIGKILL'); await bounded(exited); child = undefined;
    runtime = await createRuntimeStore(env(path));
    await runtime.store.claimLifecycle(run.id, Date.now() + 1000, 10);
    const parked = await runtime.store.getLifecycleRecords(run.id);
    assert.equal(parked[0].state, 'unknown');
    assert.equal(await runtime.store.pruneLifecycle(run.id, Date.now() + 1000), 0);
    await runtime.store.reconcileLifecycle(run.id, parked[0].event.id, 'retry', Date.now());
    const received = [];
    server = createServer(async (req, res) => {
      let body = ''; for await (const chunk of req) body += chunk;
      received.push(...JSON.parse(body)); res.writeHead(204); res.end();
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const endpoint = `http://127.0.0.1:${server.address().port}`;
    const sink = async batch => {
      const response = await fetch(endpoint, { method: 'POST', body: JSON.stringify(batch), signal: AbortSignal.timeout(2000) });
      await response.arrayBuffer(); assert.equal(response.status, 204);
    };
    dispatcher = new LogFnLifecycleDispatcher(runtime.store, sink);
    assert.equal((await dispatcher.tick()).delivered, 1);
    assert.equal(received[0].msg, 'run.created');
    assert.equal(received[0].ctx.eventId, parked[0].event.id);
    await dispatcher.close(); dispatcher = undefined;
    await runtime.store.updateRunStatus(run.id, 'running');
    dispatcher = new LogFnLifecycleDispatcher(runtime.store, async batch => { await sink(batch); throw Error('lost-after-sink-acceptance'); });
    await dispatcher.tick(); await dispatcher.tick();
    assert.equal(received.length, 2);
    assert.equal((await runtime.store.getLifecycleRecords(run.id))[1].state, 'unknown');
    await dispatcher.close(); dispatcher = undefined;
    const secrets = new MemorySecFnClient();
    await secrets.setSecret('CIFN_API_KEYS', 'owned-api-secret');
    await secrets.setSecret('CIFN_RUNNER_REGISTRATION_TOKEN', 'owned-registration-secret');
    const { app } = createApp({ store: runtime.store, secFn: secrets, pipelineResolver: async () => ({ doc: 'jobs: [private-parser-text', resolvedConfigPath: 'private-path' }) });
    const denied = await app.request('/api/v1/runs?secret=private-query', { headers: { Authorization: 'Bearer private-token' } });
    assert.equal(denied.status, 401); await denied.arrayBuffer();
    const malformed = await app.request('/api/v1/runs', { method: 'POST', headers: { Authorization: 'Bearer owned-api-secret', 'Content-Type': 'application/json' }, body: JSON.stringify({ trigger: { type: 'workflow_dispatch' }, pipelineRef: { repo: 'owned', ref: 'main' } }) });
    assert.equal(malformed.status, 422); await malformed.arrayBuffer();
    const registered = await app.request('/api/v1/runners/register', { method: 'POST', body: JSON.stringify({ token: 'owned-registration-secret', labels: ['private-label'] }) });
    assert.equal(registered.status, 200); const identity = (await registered.json()).data;
    const heartbeat = await app.request('/api/v1/runners/heartbeat', { method: 'POST', headers: { Authorization: `Bearer ${identity.runnerSecret}` }, body: JSON.stringify({ runnerId: identity.runnerId }) });
    assert.equal(heartbeat.status, 200); await heartbeat.arrayBuffer();
    await runtime.close(); runtime = await createRuntimeStore(env(path));
    const apiOwner = { kind: 'api', id: 'errors' };
    const runnerOwner = { kind: 'runner', id: identity.runnerId };
    const errors = await runtime.store.getTelemetryRecords(apiOwner);
    assert.deepEqual(errors.map(record => record.event.type), ['api.error', 'pipeline.parse_error', 'api.error']);
    assert.deepEqual((await runtime.store.getTelemetryRecords(runnerOwner)).map(record => record.event.type), ['runner.registered', 'runner.heartbeat']);
    assert.equal(JSON.stringify(errors).includes('private-'), false);
    assert.equal(Object.hasOwn(await runtime.store.getRunner(identity.runnerId), 'lifecycle'), false);
    dispatcher = new LogFnLifecycleDispatcher(runtime.store, sink);
    for (let attempt = 0; attempt < 8; attempt++) await dispatcher.tick();
    for (const owner of [apiOwner, runnerOwner]) {
      assert.ok((await runtime.store.getTelemetryRecords(owner)).every(record => record.state === 'delivered'));
      assert.ok(await runtime.store.pruneTelemetry(owner, Date.now() + 1) > 0);
    }
    assert.equal(received.filter(event => event.msg === 'pipeline.parse_error').length, 1);
    assert.equal(received.filter(event => event.msg === 'runner.heartbeat').length, 1);
    await dispatcher.close(); dispatcher = undefined;
    const outputRun = await runtime.store.createPreparedRun(await prepareRun({ trigger: { type: 'workflow_dispatch' }, pipelineSpec: { on: { workflow_dispatch: {} }, jobs: { build: { 'runs-on': 'default', steps: [{ run: 'never executed' }] } } } }));
    const dispatchId = JSON.stringify([outputRun.id, 'build', 1]);
    const payload = await runtime.store.claimDispatch(outputRun.id, dispatchId, 'fixture', ['default']);
    const outputIdentity = { runId: outputRun.id, dispatchId, runnerId: 'fixture', executionId: 'owned-output', claimToken: payload.claimToken };
    await runtime.store.acknowledgeDispatch(outputIdentity);
    const packet = { sequence: 0, events: ['owned forwarded line', 'owned second line'].map(msg => ({ ts: new Date().toISOString(), level: 'info', name: 'cifn', msg, version: '1', ctx: { stepKey: 'step-0' } })) };
    await runtime.store.appendDispatchLogs(outputIdentity, { ...packet, digest: logDigest(packet) });
    await runtime.close(); runtime = undefined;
    child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'claim-output-child', path, outputRun.id], { stdio: ['ignore', 'pipe', 'pipe'] });
    const outputExited = once(child, 'exit');
    await bounded(new Promise((resolve, reject) => {
      child.stdout.once('data', bytes => bytes.toString().includes('claimed') ? resolve() : reject(Error('Invalid output child receipt')));
      child.once('error', reject); child.once('exit', () => reject(Error('Output claim child exited before receipt')));
    }), 10_000);
    child.kill('SIGKILL'); await bounded(outputExited); child = undefined;
    runtime = await createRuntimeStore(env(path));
    assert.equal(await runtime.store.claimStepOutput(outputRun.id, Date.now() + 1000, 1000), undefined);
    let outputStatus = await runtime.store.getStepOutputStatus(outputRun.id, dispatchId);
    assert.equal(outputStatus.claim.state, 'unknown');
    await runtime.store.reconcileStepOutput(outputRun.id, dispatchId, outputStatus.claim.eventId, 'retry', Date.now());
    dispatcher = new LogFnStepOutputDispatcher(runtime.store, async batch => { await sink(batch); throw Error('owned post-acceptance response loss'); });
    await dispatcher.tick(); await dispatcher.tick(); await dispatcher.close(); dispatcher = undefined;
    assert.equal(received.filter(event => event.msg === 'owned forwarded line').length, 1);
    await runtime.close(); runtime = await createRuntimeStore(env(path));
    dispatcher = new LogFnStepOutputDispatcher(runtime.store, sink);
    await dispatcher.tick();
    assert.equal(received.filter(event => event.msg === 'owned forwarded line').length, 1);
    outputStatus = await runtime.store.getStepOutputStatus(outputRun.id, dispatchId);
    await runtime.store.reconcileStepOutput(outputRun.id, dispatchId, outputStatus.claim.eventId, 'delivered', Date.now());
    await dispatcher.tick(); await dispatcher.tick();
    assert.equal(received.filter(event => event.msg === 'owned second line').length, 1);
    assert.deepEqual(await runtime.store.getStepOutputStatus(outputRun.id, dispatchId), { version: 1, delivered: 2 });
    console.log(JSON.stringify({ passed: true, actualLogFnSink: true, killedOwnerParked: true, noBlindReplay: true, sqliteReopen: true, runnerApiTelemetry: true, sanitizedParseErrors: true, killedOutputOwnerParked: true, actualStepOutputSink: true }));
  } finally {
    const cleanup = [];
    if (child && child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill('SIGKILL'); cleanup.push(bounded(exited)); }
    cleanup.push(bounded(Promise.resolve().then(() => dispatcher?.close())));
    if (server) cleanup.push(bounded(new Promise(resolve => { server.close(resolve); server.closeAllConnections(); })));
    cleanup.push(bounded(Promise.resolve().then(() => runtime?.close())));
    const results = await Promise.allSettled(cleanup);
    const failures = results.filter(result => result.status === 'rejected');
    if (failures.length) throw new AggregateError(failures.map(result => result.reason), `Owned cleanup uncertain; retained ${directory}`);
    await rm(directory, { recursive: true, force: true });
  }
}

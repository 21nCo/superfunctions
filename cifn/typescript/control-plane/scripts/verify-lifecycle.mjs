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
const { DatabaseStore, CIFN_SQLITE_SCHEMA, CIFN_STATE_TABLE, LogFnLifecycleDispatcher } = require('../dist/index.js');
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
if (process.argv[2] === 'claim-child') {
  const runtime = await createRuntimeStore(env(process.argv[3]));
  const record = await runtime.store.claimLifecycle(process.argv[4], Date.now(), 1);
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
    console.log(JSON.stringify({ passed: true, actualLogFnSink: true, killedOwnerParked: true, noBlindReplay: true, sqliteReopen: true }));
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

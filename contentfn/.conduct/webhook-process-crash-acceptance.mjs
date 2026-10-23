// Build @contentfn/server first. Run with the Node runtime matching better-sqlite3.
// Uses only owned local processes, localhost HTTP and a disposable file SQLite DB.
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createHmac } from 'node:crypto';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { createContentfnServer, ALL_TABLES, runContentfnMigrations } from '../server/dist/index.js';
const require = createRequire(new URL('../server/package.json', import.meta.url));
const Database = require('better-sqlite3');
const { Kysely, SqliteDialect } = require('kysely');
const { kyselyAdapter } = await import('@superfunctions/db/adapters');
const timeoutMs = 500;
const secret = 'contentfn-owned-crash-fixture-secret';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function open(path, maxAttempts) {
  const sqlite = new Database(path);
  const sql = new Kysely({ dialect: new SqliteDialect({ database: sqlite }) });
  const db = kyselyAdapter({ db: sql, dialect: 'sqlite', schema: Object.fromEntries(ALL_TABLES.map(table => [table.name, table.name])) });
  return { sqlite, sql, db, server: createContentfnServer({ db, webhooks: { maxAttempts, timeoutMs } }) };
}
function row(path) {
  const sqlite = new Database(path, { readonly: true });
  try { return sqlite.prepare('SELECT eventId, status, attempt, nextRunAt, lastError FROM contentfn_webhook_queue').get(); }
  finally { sqlite.close(); }
}
async function initialize(path, maxAttempts, url) {
  const current = open(path, maxAttempts);
  try {
    await runContentfnMigrations({ async createTableIfNotExists(table) {
      let builder = current.sql.schema.createTable(table.name).ifNotExists(); const keys = [];
      for (const [name, column] of Object.entries(table.columns)) {
        builder = builder.addColumn(name, column.type === 'number' ? 'real' : column.type === 'boolean' ? 'integer' : 'text', column.nullable ? undefined : b => b.notNull());
        if (column.primaryKey) keys.push(name);
      }
      if (keys.length) builder = builder.addPrimaryKeyConstraint(`${table.name}_pk`, keys);
      await builder.execute();
    } });
    const api = current.server.api;
    for (const result of [
      await api.datasets.create({ dataset: 'crash' }),
      await api.webhooks.register({ dataset: 'crash', url, events: ['doc.published'], secret }),
      await api.schema.upsert({ dataset: 'crash', schema: { version: 1, documentTypes: [{ name: 'post', fields: [{ name: 'title', type: { kind: 'primitive', type: 'string' }, required: true }] }] } }),
      await api.docs.create({ dataset: 'crash', id: 'post', type: 'post', doc: { title: 'Crash acceptance' }, asDraft: true }),
      await api.docs.publish({ dataset: 'crash', id: 'post' }),
    ]) assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(row(path).attempt, 0);
  } finally { await current.db.close(); }
}
async function worker(path, maxAttempts) {
  const current = open(path, maxAttempts);
  try {
    process.send?.({ ready: true, pid: process.pid });
    const result = await current.server.processWebhookQueue();
    process.send?.({ result });
  } finally { await current.db.close(); process.disconnect?.(); }
}
if (process.argv[2] === 'worker') {
  await worker(process.argv[3], Number(process.argv[4]));
} else {
  const directory = await mkdtemp(join(tmpdir(), 'contentfn-killed-hook-'));
  const children = new Set();
  const script = fileURLToPath(import.meta.url);
  function launch(path, maxAttempts) {
    const child = spawn(process.execPath, [script, 'worker', path, String(maxAttempts)], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    children.add(child);
    let result, diagnostics = '';
    const collect = chunk => { diagnostics = (diagnostics + chunk.toString()).slice(-16000); };
    child.stdout.on('data', collect); child.stderr.on('data', collect);
    child.on('message', message => { if (message.result) result = message.result; });
    const exited = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => { children.delete(child); resolve({ pid: child.pid, code, signal, result, diagnostics }); });
    });
    return { child, exited };
  }
  async function finish(handle) {
    const timer = setTimeout(() => handle.child.kill('SIGKILL'), 10000);
    try { const result = await handle.exited; assert.equal(result.code, 0, JSON.stringify(result)); assert.equal(result.signal, null); assert.ok(result.result); return result; }
    finally { clearTimeout(timer); }
  }
  const receipts = [];
  let report;
  try {
    for (const maxAttempts of [2, 1]) {
      const path = join(directory, `attempt-cap-${maxAttempts}.sqlite`);
      const requests = [], logicalEvents = new Set();
      let acknowledge = false, resolveReceived, receiverError;
      const received = new Promise(resolve => { resolveReceived = resolve; });
      const receiver = createServer(async (request, response) => {
        try {
          const chunks = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
          const body = Buffer.concat(chunks).toString('utf8');
          const signature = request.headers['x-contentfn-signature'];
          assert.equal(signature, 'v1=' + createHmac('sha256', secret).update(body).digest('hex'));
          const payload = JSON.parse(body);
          assert.equal(typeof payload.eventId, 'string');
          const duplicate = logicalEvents.has(payload.eventId); logicalEvents.add(payload.eventId);
          const entry = { body, signature, eventId: payload.eventId, duplicate, receivedAt: new Date().toISOString(), completeRequest: request.complete, responseSent: response.headersSent };
          requests.push(entry);
          if (acknowledge) { response.writeHead(204); response.end(); }
          else resolveReceived({ response, entry }); // Intentionally no response bytes before kill.
        } catch (error) { receiverError = error; response.destroy(); resolveReceived({ error }); }
      });
      await new Promise(resolve => receiver.listen(0, '127.0.0.1', resolve));
      try {
        await initialize(path, maxAttempts, `http://127.0.0.1:${receiver.address().port}/webhook`);
        const original = launch(path, maxAttempts);
        let guard;
        const request = await Promise.race([received, new Promise((_, reject) => { guard = setTimeout(() => reject(new Error('Worker did not send HTTP request')), 10000); })]).finally(() => clearTimeout(guard));
        if (request.error) throw request.error;
        assert.equal(request.response.headersSent, false);
        assert.equal(request.entry.completeRequest, true);
        const beforeKill = row(path);
        assert.equal(beforeKill.status, 'processing'); assert.equal(beforeKill.attempt, 1);
        assert.ok(Date.parse(beforeKill.nextRunAt) > Date.now());
        const killedAt = new Date().toISOString();
        assert.equal(original.child.kill('SIGKILL'), true);
        const killed = await original.exited;
        assert.equal(killed.signal, 'SIGKILL'); assert.equal(killed.code, null);
        assert.equal(killed.result, undefined);
        assert.equal(request.response.headersSent, false);
        const afterKill = row(path);
        assert.deepEqual(afterKill, beforeKill);
        acknowledge = true;
        const beforeExpiry = await finish(launch(path, maxAttempts));
        assert.deepEqual(beforeExpiry.result, { delivered: 0, failed: 0 });
        assert.equal(requests.length, 1);
        assert.deepEqual(row(path), afterKill);
        const waitStarted = Date.now();
        const expiry = Date.parse(afterKill.nextRunAt);
        await sleep(Math.max(0, expiry - Date.now() + 30));
        assert.ok(Date.now() >= expiry);
        const realExpiryWaitMs = Date.now() - waitStarted;
        const recovery = maxAttempts === 2
          ? [await finish(launch(path, maxAttempts))]
          : await Promise.all([finish(launch(path, maxAttempts)), finish(launch(path, maxAttempts))]);
        if (receiverError) throw receiverError;
        const recovered = row(path);
        if (maxAttempts === 2) {
          assert.deepEqual(recovery[0].result, { delivered: 1, failed: 0 });
          assert.equal(requests.length, 2);
          assert.equal(requests[1].body, requests[0].body);
          assert.equal(requests[1].signature, requests[0].signature);
          assert.equal(requests[1].duplicate, true);
          assert.equal(recovered.status, 'delivered'); assert.equal(recovered.attempt, 2);
        } else {
          assert.equal(recovery.reduce((n, worker) => n + worker.result.failed, 0), 1);
          assert.equal(recovery.reduce((n, worker) => n + worker.result.delivered, 0), 0);
          assert.equal(requests.length, 1);
          assert.equal(recovered.status, 'failed'); assert.equal(recovered.attempt, 1);
          assert.match(recovered.lastError, /outcome may be unknown/);
        }
        assert.equal(logicalEvents.size, 1);
        const reopened = await finish(launch(path, maxAttempts));
        assert.deepEqual(reopened.result, { delivered: 0, failed: 0 });
        assert.deepEqual(row(path), recovered);
        receipts.push({ maxAttempts, killedAt, killedPid: killed.pid, termination: { code: killed.code, signal: killed.signal }, reservedBeforeKill: beforeKill, persistedAfterKill: afterKill, beforeExpiry: beforeExpiry.result, realExpiryWaitMs, recovery: recovery.map(r => ({ pid: r.pid, result: r.result })), final: recovered, httpRequests: requests.length, deduplicatedApplications: logicalEvents.size, requestReceipts: requests, reopened: reopened.result });
      } finally {
        receiver.closeAllConnections();
        await new Promise(resolve => receiver.close(resolve));
      }
    }
    assert.equal(children.size, 0);
    report = { runtime: process.version, timeoutMs, realProcessesKilled: 2, noLeaseOrAttemptStateInjection: true, cases: receipts, cleanup: { remainingOwnedWorkers: children.size, receiversClosed: true, directoryRemoved: false } };
  } finally {
    await Promise.all([...children].map(child => new Promise(resolve => { child.once('close', resolve); child.kill('SIGKILL'); })));
    await rm(directory, { recursive: true, force: true });
  }
  await assert.rejects(readdir(directory), { code: 'ENOENT' });
  report.cleanup.directoryRemoved = true;
  console.log(JSON.stringify(report, null, 2));
}

// Build CatchFn, @watchfn/browser, @watchfn/core and shared DB first.
// Requires the local native better-sqlite3 and kysely acceptance dependencies.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { Kysely, SqliteDialect } from 'kysely';
import { kyselyAdapter } from '@superfunctions/db/adapters';
import { pathToFileURL } from 'node:url';
const watchModule = process.env.CATCHFN_WATCH_CORE ? pathToFileURL(process.env.CATCHFN_WATCH_CORE).href : new URL('../../../watchfn/typescript/dist/index.mjs', import.meta.url).href;
const { WatchFn, getWatchFnSchema } = await import(watchModule);
import { catchFn } from '../dist/index.js';

const directory = await mkdtemp(join(tmpdir(), 'catchfn-watch-http-'));
const databasePath = join(directory, 'events.sqlite');
let sql;
let watch;
let server;
const catchers = [];
const requests = [];
let failBeforeStorage = 0;
let dropAfterStorage = false;
const connect = () => {
  sql = new Kysely({ dialect: new SqliteDialect({ database: new Database(databasePath) }) });
  const database = kyselyAdapter({ db: sql, dialect: 'sqlite', schema: { watchfn_events: 'watchfn_events' } });
  watch = new WatchFn({ name: 'bugs', storage: 'database', database,
    infra: { enabled: false }, auth: { enabled: true, apiKey: 'acceptance-only' } });
  watch.start();
};
try {
  connect();
  let migration = sql.schema.createTable('watchfn_events');
  for (const [name, field] of Object.entries(getWatchFnSchema().watchfn_events.fields)) {
    migration = migration.addColumn(name, 'text', column => name === 'id' ? column.primaryKey() : field.required ? column.notNull() : column);
  }
  await migration.execute();
  server = createServer(async (incoming, outgoing) => {
    try {
      const chunks = [];
      for await (const chunk of incoming) chunks.push(chunk);
      const body = Buffer.concat(chunks);
      if (incoming.url === '/ingest') {
        requests.push(JSON.parse(body.toString()));
        if (failBeforeStorage > 0) { failBeforeStorage--; outgoing.writeHead(503); outgoing.end(); return; }
      }
      const response = await watch.httpRouter.handle(new Request('http://local' + incoming.url, {
        method: incoming.method, headers: incoming.headers, body,
      }));
      if (incoming.url === '/ingest' && response.ok && dropAfterStorage) {
        dropAfterStorage = false; outgoing.destroy(); return;
      }
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      outgoing.end(Buffer.from(await response.arrayBuffer()));
    } catch { outgoing.writeHead(500); outgoing.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const endpoint = `http://127.0.0.1:${server.address().port}/ingest`;
  const query = async where => {
    const response = await fetch(endpoint.replace('/ingest', '/query'), {
      method: 'POST', headers: { Authorization: 'Bearer acceptance-only', 'Content-Type': 'application/json' },
      body: JSON.stringify({ where }), signal: AbortSignal.timeout(2000),
    });
    assert.equal(response.status, 200);
    return (await response.json()).results;
  };
  const client = (extra = {}) => {
    const catcher = catchFn({ name: 'shop', sessionId: 'session-one', watch: {
      endpoint, apiKey: 'acceptance-only', retries: 1, retryDelayMs: 0, timeoutMs: 1000, ...extra,
    } });
    catchers.push(catcher); return catcher;
  };
  const catcher = client();
  failBeforeStorage = 1;
  const report = await catcher.captureBug({ title: 'Checkout 文', steps: ['Open', 'Pay'], severity: 'high',
    metadata: { password: 'do-not-send', nested: [true, null, '文'] } });
  assert.equal(report.delivery, 'sent');
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[0], requests[1]);
  assert.equal(requests[1][0].id, report.id);
  assert.equal(requests[1][0].type, 'bug_report');
  assert.equal(requests[1][0].context.custom.password, '[REDACTED]');
  assert.equal(requests[1][0].report.title, 'Checkout 文');
  assert.equal('properties' in requests[1][0], false);
  const stored = await query({ type: 'bug_report', 'app.name': 'shop', 'report.severity': 'high' });
  assert.equal(stored.length, 1);
  assert.deepEqual(stored[0], requests[1][0]);

  const invalid = client({ apiKey: 'invalid' });
  const count = requests.length;
  await assert.rejects(invalid.captureBug({ title: 'Denied' }), error => error.status === 401);
  assert.equal(requests.length, count + 1); // Nonretryable authorization failure.

  dropAfterStorage = true;
  const repeated = await catcher.captureBug({ title: 'Lost response' });
  const repeatedRows = await query({ id: repeated.id });
  assert.equal(repeatedRows.length, 2); // Explicitly at-least-once, not deduplicated.

  await watch.stop();
  await sql.destroy(); sql = undefined;
  connect();
  const reopened = await query({ id: report.id });
  assert.deepEqual(reopened, [requests[1][0]]);
  await sql.schema.dropTable('watchfn_events').execute();
  await assert.rejects(catcher.captureBug({ title: 'Storage down' }), error => error.status === 503);
  await assert.rejects(watch.flush()); // Consume the explicitly surfaced storage failure.
  console.log('CatchFn -> WatchFn real HTTP + SQLite reopen passed: auth, canonical payload, retries, query, persistence failure; delivery is at least once');
} finally {
  for (const catcher of catchers) catcher.stop();
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  if (watch) await watch.stop().catch(() => {});
  if (sql) await sql.destroy();
  await rm(directory, { recursive: true, force: true });
}

/** Local cross-package acceptance. Build LogFn first; WATCHFN_ROOT selects the WatchFn checkout. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const watchRoot = resolve(process.env.WATCHFN_ROOT ?? root);
const requireWatch = createRequire(join(watchRoot, 'package.json'));
const { build } = requireWatch('esbuild');
const temporary = mkdtempSync(join(tmpdir(), 'logfn-watchfn-'));
const { createLogger, sinkHttp } = await import('../typescript/dist/index.js');
let server;
let watch;
let release;
const instances = [];
const sinks = [];
const deadline = setTimeout(() => { throw new Error('WatchFn integration acceptance exceeded 30 seconds'); }, 30_000);
try {
  // Bundle the actual core, router and storage, avoiding unrelated framework adapters.
  const output = join(temporary, 'watch.mjs');
  await build({ entryPoints: [join(watchRoot, 'watchfn/typescript/src/core/watch-fn.ts')], outfile: output, bundle: true, platform: 'node', format: 'esm', banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' }, logLevel: 'silent' });
  const { WatchFn } = await import(pathToFileURL(output).href);
  const makeWatch = (extra = {}) => {
    const instance = new WatchFn({ name: 'logfn-acceptance', storage: 'memory', infra: { enabled: false }, auth: { enabled: true, apiKey: 'local-test-key' }, ...extra });
    instance.start(); instances.push(instance); return instance;
  };
  watch = makeWatch();
  const statuses = [];
  server = createServer(async (request, response) => {
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const result = await watch.httpRouter.handler(new Request(`http://127.0.0.1${request.url}`, { method: request.method, headers: request.headers, body: Buffer.concat(chunks) }));
      statuses.push(result.status);
      response.writeHead(result.status, Object.fromEntries(result.headers));
      response.end(Buffer.from(await result.arrayBuffer()));
    } catch (error) { response.writeHead(500); response.end(String(error)); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/ingest`;
  const makeSink = (extra = {}) => {
    const sink = sinkHttp({ url, auth: { token: 'local-test-key' }, batch: 50, flushIntervalMs: 60_000, timeoutMs: 5000, retry: { attempts: 1 }, ...extra });
    sinks.push(sink); return sink;
  };
  const captured = [];
  const transportErrors = [];
  const sink = makeSink();
  const logger = createLogger({ name: 'checkout', onError: error => transportErrors.push(error), traceId: '0123456789abcdef0123456789abcdef', spanId: '0123456789abcdef', requestId: 'request-1', tenantId: 'tenant-1', userId: 'user-1', tags: ['integration'], sinks: [events => captured.push(...events), sink] });
  logger.info('paid', { nested: { amount: 42 }, unicode: '✓' });
  await logger.flush();
  assert.deepEqual(await watch.query({}), captured, 'MemoryStorage must retain the complete LogFn envelope');
  assert.equal(statuses.at(-1), 202);

  // Exercise DatabaseStorage with a deterministic adapter gate/failure, not a mock HTTP response.
  const stored = [];
  let fail = false;
  let gate;
  let entered;
  const database = {
    async insertEvent(event) { entered?.(); if (gate) await gate; if (fail) throw new Error('private storage detail'); stored.push(event); },
    async queryEvents() { return stored; },
  };
  watch = makeWatch({ storage: 'database', database });
  const storageEntered = new Promise(resolve => { entered = resolve; });
  gate = new Promise(resolve => { release = resolve; });
  logger.info('await persistence');
  let settled = false;
  const pending = logger.flush().then(() => { settled = true; });
  await storageEntered;
  assert.equal(settled, false);
  assert.equal(stored.length, 0);
  const countBeforeRelease = statuses.length;
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(statuses.length, countBeforeRelease, 'No HTTP success may precede storage completion');
  release(); gate = undefined;
  await pending;
  assert.equal(stored[0].msg, 'await persistence');

  fail = true;
  logger.info('retry retained event');
  await assert.rejects(logger.flush());
  assert.equal(statuses.at(-1), 503);
  assert.equal(stored.length, 1);
  fail = false;
  await logger.flush();
  assert.equal(stored.length, 2);
  assert.equal(stored[1].msg, 'retry retained event');

  const headers = { 'x-api-key': 'wrong-key' };
  const authenticated = makeSink({ auth: undefined, headers, retry: { attempts: 3, backoffMs: 0 } });
  authenticated([captured[0]]);
  const requestsBeforeAuth = statuses.length;
  await assert.rejects(authenticated.flush(), /HTTP 401/);
  assert.equal(statuses.length, requestsBeforeAuth + 1, 'Authentication failures must not retry automatically');
  assert.equal(stored.length, 2);
  headers['x-api-key'] = 'local-test-key';
  await authenticated.flush();
  assert.deepEqual(stored[2], captured[0]);

  watch.stop();
  logger.info('stopped storage retains event');
  await assert.rejects(logger.flush());
  assert.equal(statuses.at(-1), 503);
  watch.start();
  await logger.flush();
  assert.equal(stored.at(-1).msg, 'stopped storage retains event');
  assert.equal(transportErrors.length, 2, 'Storage failures must reach the logger error callback');
  for (const item of sinks) await item.close();
  console.log(`LogFn -> HTTP -> WatchFn acceptance passed (${statuses.length} requests): metadata, delayed storage, failure recovery, auth, stopped storage`);
} finally {
  clearTimeout(deadline);
  release?.();
  await Promise.allSettled(sinks.map(sink => sink.close()));
  for (const instance of instances) instance.stop();
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  rmSync(temporary, { recursive: true, force: true });
}

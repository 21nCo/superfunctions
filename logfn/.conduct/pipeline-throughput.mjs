// Build @logfn/core first. Run with stdout redirected to a file or /dev/null;
// console measurements include actual JSON console writes, not a no-op sink.
// Receipt is written to stderr. HTTP traffic stays on an owned loopback server.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { performance } from 'node:perf_hooks';
import { createLogger, enrichContext, sinkConsole, sinkHttp } from '../typescript/dist/index.js';

const count = Number(process.env.LOGFN_BENCH_EVENTS ?? 2000);
assert(Number.isSafeInteger(count) && count >= 100 && count <= 20000);
const secret = 'benchmark-private-sentinel';
const results = [];
const deadline = setTimeout(() => { process.stderr.write('Benchmark exceeded 60 seconds\n'); process.exit(1); }, 60000);
let received = new Set();
let failure;
let requests = 0;
const server = createServer(async (req, res) => {
  try {
    let bytes = 0;
    const chunks = [];
    for await (const chunk of req) {
      bytes += chunk.length;
      assert(bytes <= 2 * 1024 * 1024);
      chunks.push(chunk);
    }
    const body = Buffer.concat(chunks).toString();
    assert(!body.includes(secret), 'Default terminal redaction must remove secrets');
    for (const event of JSON.parse(body).events) {
      assert(!received.has(event.ctx.sequence), 'No duplicate receipt');
      received.add(event.ctx.sequence);
    }
    requests++;
    res.writeHead(204).end();
  } catch (error) {
    failure = error;
    res.writeHead(400).end();
  }
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
try {
  // Verify the actual console formatter's privacy behavior before timing.
  const previous = console.log;
  let preflight;
  try {
    console.log = value => { preflight = value; };
    createLogger({ name: 'preflight', sinks: [sinkConsole({ json: true })] }).info('probe', { nested: { password: secret } });
  } finally { console.log = previous; }
  assert(preflight && !preflight.includes(secret));

  for (const transport of ['console', 'http']) {
    for (const payloadBytes of [128, 4096]) {
      for (const depth of [0, 2, 4]) {
        received = new Set();
        requests = 0;
        failure = undefined;
        const errors = [];
        const sink = transport === 'console' ? sinkConsole({ json: true, color: false }) : sinkHttp({
          url: `http://127.0.0.1:${server.address().port}/events`,
          batch: 100, maxQueue: 200, timeoutMs: 2000,
          flushIntervalMs: 1000, retry: { attempts: 1 },
        });
        const logger = createLogger({
          name: 'pipeline-benchmark', sinks: [sink], onError: error => errors.push(error),
          pipeline: Array.from({ length: depth }, (_, i) => enrichContext({ [`stage${i}`]: i })),
        });
        const payload = { child: { data: 'x'.repeat(payloadBytes), password: secret } };
        const started = performance.now();
        try {
          for (let i = 0; i < count; i++) {
            logger.info('benchmark', { sequence: i, nested: payload });
            // Bound producer backlog and include real completion in throughput.
            if ((i + 1) % 100 === 0) await logger.flush();
          }
          await logger.flush();
          await sink.close?.();
          const elapsedMs = performance.now() - started;
          assert.equal(errors.length, 0);
          assert.equal(failure, undefined);
          if (transport === 'http') assert.equal(received.size, count);
          results.push({ transport, payloadBytes, depth, events: count, elapsedMs,
            eventsPerSecond: count * 1000 / elapsedMs, httpReceived: transport === 'http' ? received.size : null,
            requests: transport === 'http' ? requests : null });
        } finally { await sink.close?.(); }
      }
    }
  }
} finally {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  clearTimeout(deadline);
}
process.stderr.write(JSON.stringify({ node: process.version, defaultRedaction: true,
  pipeline: '0/2/4 real enrichContext stages; terminal redaction always enabled',
  consoleDestination: 'caller-selected stdout destination; not interactive terminal evidence',
  samplePolicy: 'single bounded sample per case; no performance threshold claim',
  cleanup: { serverClosed: !server.listening }, results }, null, 2) + '\n');

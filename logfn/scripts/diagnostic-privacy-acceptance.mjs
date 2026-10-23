/** Built-package process-signal and real HTTP diagnostic privacy acceptance. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { sinkHttp } from '../typescript/dist/index.js';

const entry = new URL('../typescript/dist/index.js', import.meta.url).href;
for (const signal of ['SIGTERM', 'SIGINT']) {
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import { registerProcessHandlers } from ${JSON.stringify(entry)};
    registerProcessHandlers({info() {}, async flush() {throw new Error('password=signal-private');}});
    setInterval(() => {}, 1000);
    console.log('ready');
  `], { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '', errors = '';
  child.stdout.on('data', chunk => { output += chunk; if (output.includes('ready')) child.kill(signal); });
  child.stderr.on('data', chunk => { errors += chunk; });
  const deadline = setTimeout(() => child.kill('SIGKILL'), 10000);
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', resolve);
  }).finally(() => clearTimeout(deadline));
  assert.equal(code, 1);
  assert.equal(errors.trim(), '[logfn] Failed to flush on shutdown');
}

let accept = false;
let requests = 0;
const server = createServer(async (request, response) => {
  for await (const _ of request) { /* Consume the bounded fixture request. */ }
  requests++;
  response.writeHead(accept ? 202 : 503, accept ? 'Accepted' : 'password=http-private');
  response.end();
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const sink = sinkHttp({ url: `http://127.0.0.1:${server.address().port}`, batch: 1, retry: { attempts: 1 } });
const originalError = console.error;
const diagnostics = [];
console.error = (...args) => diagnostics.push(args);
try {
  sink([{ ts: new Date().toISOString(), level: 'info', name: 'privacy', msg: 'retained', version: '0' }]);
  await assert.rejects(sink.flush(), /http-private/);
  assert.deepEqual(diagnostics, [['[logfn http-sink error] Background delivery failed']]);
} finally {
  console.error = originalError;
  accept = true;
  try { await sink.close(); }
  finally {
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}
assert.equal(requests, 2);
console.log(JSON.stringify({ signals: ['SIGTERM', 'SIGINT'], signalExitCodes: [1, 1], httpRequests: requests, diagnosticsContainRawErrors: false, retainedDeliveryRecovered: true, serverClosed: !server.listening }));

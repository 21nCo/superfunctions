/** Real built runner, LogFn, control-plane HTTP and SQLite crash/reopen acceptance. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { RemoteRunner } from '../../runner/dist/index.mjs';
const directory = await mkdtemp(join(tmpdir(), 'cifn-log-acceptance-'));
const key = randomBytes(32).toString('base64');
const secret = 'configured-log-secret-ascii';
const token = 'local-registration';
const stateDirectory = join(directory, 'runner');
const witness = join(directory, 'witness');
let control, proxy, port = 0, output = '';
const children = [];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function stop(child, signal = 'SIGTERM') {
  if (!child) return;
  if (child.process.exitCode === null && child.process.signalCode === null) child.process.kill(signal);
  await child.exited;
}
async function start() {
  const processChild = spawn(process.execPath, [fileURLToPath(new URL('../dist/server.js', import.meta.url))], {
    env: { ...process.env, PORT: String(port), CIFN_STORE_ADAPTER: 'sqlite', CIFN_SQLITE_PATH: join(directory, 'state.sqlite'), CIFN_STORE_ENCRYPTION_KEY: key,
      CIFN_RUNNER_REGISTRATION_TOKEN: token, CIFN_API_KEYS: secret, CIFN_QUEUE_ADAPTER: 'memory', CIFN_ARTIFACTS_ADAPTER: 'memory', CIFN_SECRETS_ADAPTER: 'memory', CIFN_LOGS_ADAPTER: 'memory' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const child = { process: processChild, exited: once(processChild, 'exit') }; children.push(child);
  let ready;
  processChild.stdout.on('data', chunk => { output += chunk; const match = /listening on port (\d+)/.exec(String(chunk)); if (match) ready = Number(match[1]); });
  processChild.stderr.on('data', chunk => { output += chunk; });
  for (let i = 0; !ready && i < 200; i++) { if (processChild.exitCode !== null) throw new Error('Control startup failed: ' + output); await delay(50); }
  assert.ok(ready, 'control ready'); port = ready; return child;
}
async function data(path, body, credential = secret) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${credential}` }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(5000) });
  assert.ok(res.ok, `${path}: ${res.status}`); const value = await res.json(); assert.equal(value.ok, true); return value.data;
}
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
try {
  control = await start();
  const registered = await data('/api/v1/runners/register', { token });
  let dropped = false, logsOffline = false, firstBody, replayBody;
  const requests = [];
  proxy = createServer(async (req, res) => {
    try {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const body = Buffer.concat(chunks); const text = body.toString();
      if (req.url.endsWith('/logs')) {
        assert.ok(!text.includes(secret), 'Configured secret must not reach log transport'); requests.push(JSON.parse(text).packet);
        if (logsOffline) { res.writeHead(503); res.end('{}'); return; }
        if (!firstBody) firstBody = text; else if (JSON.parse(text).packet.sequence === 0) replayBody = text;
      }
      const upstream = await fetch(`http://127.0.0.1:${port}${req.url}`, { method: req.method, headers: { Authorization: req.headers.authorization ?? '', 'Content-Type': 'application/json' }, body, signal: AbortSignal.timeout(5000) });
      const response = await upstream.text();
      if (!dropped && req.url.endsWith('/logs') && upstream.ok) { dropped = true; await stop(control, 'SIGKILL'); res.destroy(); return; }
      res.writeHead(upstream.status, { 'Content-Type': 'application/json' }); res.end(response);
    } catch { res.writeHead(503); res.end('{}'); }
  });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  const options = { baseUrl: `http://127.0.0.1:${proxy.address().port}`, runnerId: registered.runnerId, runnerSecret: registered.runnerSecret, stateDirectory };
  const js = `require('fs').appendFileSync(${JSON.stringify(witness)},'once\\n');process.stdout.write('stdout '+process.env.TOKEN+'\\n');process.stderr.write('stderr '+process.env.TOKEN+'\\n');`;
  const input = { trigger: { type: 'workflow_dispatch' }, pipelineSpec: { on: { workflow_dispatch: {} }, env: { TOKEN: '${{ secrets.CIFN_API_KEYS }}' }, jobs: { build: { 'runs-on': 'default', steps: [{ run: `${quote(process.execPath)} -e ${quote(js)}` }] } } } };
  const run = await data('/api/v1/runs', input);
  const runId = run.runId ?? run.id; assert.ok(runId);
  await assert.rejects(new RemoteRunner(options).tick());
  assert.equal(dropped, true);
  control = await start();
  const before = await data(`/api/v1/runs/${runId}/jobs/build/logs`);
  assert.equal(before.transfer.status, 'pending'); assert.ok(before.lines.length > 0);
  const runner = new RemoteRunner(options); await runner.tick(); await runner.tick();
  assert.equal(replayBody, firstBody, 'Exact stable replay after lost ACK');
  const logs = await data(`/api/v1/runs/${runId}/jobs/build/logs`);
  assert.equal(logs.transfer.status, 'complete');
  const lines = logs.lines.map(line => line.line);
  assert.equal(lines.filter(line => line === 'stdout ***').length, 1);
  assert.equal(lines.filter(line => line === 'stderr ***').length, 1);
  assert.ok(!JSON.stringify(logs).includes(secret));
  assert.equal(await readFile(witness, 'utf8'), 'once\n');
  await stop(control); control = await start();
  assert.deepEqual(await data(`/api/v1/runs/${runId}/jobs/build/logs`), logs);
  logsOffline = true;
  const outageRun = await data('/api/v1/runs', input);
  const outageId = outageRun.runId ?? outageRun.id;
  await new RemoteRunner(options).tick();
  assert.equal((await data(`/api/v1/runs/${outageId}`)).status, 'success');
  assert.equal((await data(`/api/v1/runs/${outageId}/jobs/build/logs`)).transfer.status, 'pending');
  logsOffline = false;
  await new RemoteRunner(options).tick();
  assert.equal((await data(`/api/v1/runs/${outageId}/jobs/build/logs`)).transfer.status, 'complete');
  assert.equal(await readFile(witness, 'utf8'), 'once\nonce\n');
  await stop(control); control = undefined;
  async function inspect(path) {
    for (const name of await readdir(path)) {
      const file = join(path, name); if ((await stat(file)).isDirectory()) await inspect(file);
      else assert.ok(!(await readFile(file)).includes(Buffer.from(secret)), `No configured secret persisted: ${name}`);
    }
  }
  await inspect(directory); assert.ok(!output.includes(secret));
  console.log(JSON.stringify({ passed: true, transportRequests: requests.length, retrievedLines: logs.lines.length, transfer: logs.transfer.status, executionCount: 2, logOnlyOutageRecovered: true, sqliteReopen: true, configuredSecretAbsent: true }));
} finally {
  if (proxy) { proxy.closeAllConnections(); await new Promise(resolve => proxy.close(resolve)); }
  for (const child of children) await stop(child);
  await rm(directory, { recursive: true, force: true });
}

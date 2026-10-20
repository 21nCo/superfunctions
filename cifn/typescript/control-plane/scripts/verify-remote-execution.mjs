import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const directory = await mkdtemp(join(tmpdir(), 'cifn-remote-acceptance-'));
const key = randomBytes(32).toString('base64');
const apiKey = 'disposable-remote-job-secret';
const token = 'disposable-remote-registration';
const children = [];
const ownedGroups = new Set();
let output = '', port = 0, control, proxy, runner, completionBody;
const stateDirectory = join(directory, 'runner-state');
const witness = join(directory, 'witness');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await check(); if (value) return value; await delay(50); }
  throw new Error(`Timed out: ${label}`);
}
function child(script, env, detached = false) {
  const processChild = spawn(process.execPath, [script], { env: { ...process.env, ...env }, detached, stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = once(processChild, 'exit'); children.push({ child: processChild, exited, detached });
  processChild.stdout.on('data', chunk => { output += chunk; }); processChild.stderr.on('data', chunk => { output += chunk; });
  return { child: processChild, exited, detached };
}
async function stop(value, signal = 'SIGTERM') {
  if (value.child.exitCode === null && value.child.signalCode === null) {
    if (value.detached) process.kill(-value.child.pid, signal); else value.child.kill(signal);
  }
  await value.exited;
}
async function startControl() {
  const value = child(fileURLToPath(new URL('../dist/server.js', import.meta.url)), {
    PORT: String(port), CIFN_RUNNER_REGISTRATION_TOKEN: token, CIFN_API_KEYS: apiKey,
    CIFN_STORE_ADAPTER: 'sqlite', CIFN_SQLITE_PATH: join(directory, 'state.sqlite'), CIFN_STORE_ENCRYPTION_KEY: key,
    CIFN_QUEUE_ADAPTER: 'memory', CIFN_ARTIFACTS_ADAPTER: 'memory', CIFN_SECRETS_ADAPTER: 'memory', CIFN_LOGS_ADAPTER: 'memory',
  });
  let listened;
  value.child.stdout.on('data', chunk => { const match = /Control Plane listening on port (\d+)/.exec(String(chunk)); if (match) listened = Number(match[1]); });
  port = await until(async () => { if (value.child.exitCode !== null) throw new Error('Control plane exited before readiness'); return listened; }, 'control startup');
  return value;
}
async function request(path, body, credential = apiKey) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${credential}` }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(5000) });
  return response;
}
async function data(path, body, credential) { const response = await request(path, body, credential); assert.ok(response.ok, `${path}: ${response.status}`); return (await response.json()).data; }
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
const command = (label, sleep = false) => `${quote(process.execPath)} -e ${quote(`const fs=require('fs');if(process.env.CIFN_RUNNER_SECRET||process.env.CIFN_API_KEYS||!process.env.TOKEN)process.exit(23);fs.appendFileSync(${JSON.stringify(witness)},${JSON.stringify(label + '\n')});${sleep ? 'setTimeout(()=>{},10000);' : ''}`)}`;
try {
  control = await startControl();
  const registration = await data('/api/v1/runners/register', { token });
  let dropped = false;
  proxy = createServer(async (req, res) => {
    try {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const body = Buffer.concat(chunks);
      const upstream = await fetch(`http://127.0.0.1:${port}${req.url}`, { method: req.method, headers: { Authorization: req.headers.authorization ?? '', 'Content-Type': 'application/json' }, body, signal: AbortSignal.timeout(5000) });
      const responseBody = await upstream.text();
      if (!dropped && req.url.endsWith('/claims/complete') && upstream.ok) {
        dropped = true; completionBody = JSON.parse(body.toString());
        await stop(control, 'SIGKILL'); res.destroy(); return;
      }
      res.writeHead(upstream.status, { 'Content-Type': 'application/json' }); res.end(responseBody);
    } catch { res.destroy(); }
  });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  const proxyPort = proxy.address().port;
  const startRunner = () => child(fileURLToPath(new URL('../../runner/dist/server.js', import.meta.url)), {
    CIFN_CONTROL_PLANE_URL: `http://127.0.0.1:${proxyPort}`, CIFN_RUNNER_ID: registration.runnerId,
    CIFN_RUNNER_SECRET: registration.runnerSecret, CIFN_RUNNER_STATE_DIR: stateDirectory, CIFN_POLL_INTERVAL_MS: '100',
    CIFN_API_KEYS: 'must-not-reach-shell',
  }, true);
  const input = { trigger: { type: 'workflow_dispatch' }, pipelineSpec: { on: { workflow_dispatch: {} }, env: { TOKEN: '${{ secrets.CIFN_API_KEYS }}' }, jobs: {
    build: { 'runs-on': 'default', steps: [{ run: command('build') }] },
    test: { 'runs-on': 'default', needs: ['build'], steps: [{ run: command('test') }] },
  } } };
  const run = await data('/api/v1/runs', input);
  // Lose the initial offer response: authenticated resume must recover this offer.
  const offered = await data('/api/v1/runners/heartbeat', { runnerId: registration.runnerId }, registration.runnerSecret);
  assert.equal(offered.job.runId, run.runId);
  runner = startRunner();
  await until(async () => dropped && control.child.signalCode !== null, 'committed completion response loss');
  assert.equal(await readFile(witness, 'utf8'), 'build\n');
  control = await startControl();
  await until(async () => (await data(`/api/v1/runs/${run.runId}`)).status === 'success', 'DAG completion after restart');
  assert.equal(await readFile(witness, 'utf8'), 'build\ntest\n');
  const repeat = await request('/api/v1/runners/claims/complete', completionBody, registration.runnerSecret);
  assert.equal(repeat.status, 200);
  assert.equal((await request('/api/v1/runners/claims/complete', { ...completionBody, claimToken: 'wrong' }, registration.runnerSecret)).status, 409);
  const final = await data(`/api/v1/runs/${run.runId}`);
  assert.ok(final.jobs.every(job => job.status === 'success' && job.steps.every(step => step.status === 'success')));
  await stop(runner); await stop(control); control = await startControl();
  assert.deepEqual(await data(`/api/v1/runs/${run.runId}`), final);
  // Cancellation is observed over authenticated HTTP while a resistant descendant runs.
  const cancelReady = join(directory, 'cancel-ready'); const cancelledWitness = join(directory, 'cancel-late');
  const cancelledGroup = join(directory, 'cancel-group');
  const sentinelScript = join(directory, 'sentinel.cjs');
  await writeFile(sentinelScript, 'setInterval(()=>{},1000);');
  const sentinel = child(sentinelScript, {});
  const resistant = `require('fs').writeFileSync(${JSON.stringify(cancelReady)},'ready');process.on('SIGTERM',()=>{});require('fs').closeSync(1);require('fs').closeSync(2);setTimeout(()=>require('fs').writeFileSync(${JSON.stringify(cancelledWitness)},'late'),8000);setInterval(()=>{},1000);`;
  const cancelCommand = `echo $$ > ${quote(cancelledGroup)}; ${quote(process.execPath)} -e ${quote(resistant)} & wait`;
  const cancelRun = await data('/api/v1/runs', { ...input, pipelineSpec: { ...input.pipelineSpec, jobs: { cancel: {
    'runs-on': 'default', steps: [{ run: cancelCommand }, { run: `echo later > ${quote(cancelledWitness)}` }],
  } } } });
  runner = startRunner();
  await until(async () => readFile(cancelReady, 'utf8').catch(() => ''), 'resistant descendant startup');
  const cancelGroup = Number(await readFile(cancelledGroup, 'utf8')); ownedGroups.add(cancelGroup);
  await data(`/api/v1/runs/${cancelRun.runId}/cancel`, {});
  const cancellationEntry = await until(async () => {
    for (const name of await readdir(stateDirectory)) {
      if (!name.endsWith('.json')) continue;
      const entry = JSON.parse(await readFile(join(stateDirectory, name), 'utf8'));
      if (entry.runId === cancelRun.runId && entry.phase === 'finished') return entry;
    }
  }, 'durable cancellation receipt');
  assert.throws(() => process.kill(-cancelGroup, 0), { code: 'ESRCH' }); ownedGroups.delete(cancelGroup);
  assert.equal(await readFile(cancelledWitness, 'utf8').catch(() => ''), '');
  assert.doesNotThrow(() => process.kill(sentinel.child.pid, 0));
  assert.equal((await data(`/api/v1/runs/${cancelRun.runId}`)).status, 'cancelled');
  assert.deepEqual(await data('/api/v1/runners/claims/status', cancellationEntry, registration.runnerSecret), { cancelRequested: true, completed: false, stopped: true });
  assert.equal((await request('/api/v1/runners/claims/stopped', { ...cancellationEntry, claimToken: 'wrong' }, registration.runnerSecret)).status, 409);
  await stop(sentinel); await stop(runner);
  // Kill a real subprocess after its side effect but before result persistence.
  const uncertainGroup = join(directory, 'uncertain-group');
  const uncertain = await data('/api/v1/runs', { ...input, pipelineSpec: { ...input.pipelineSpec, jobs: { uncertain: { 'runs-on': 'default', steps: [{ run: `echo $$ > ${quote(uncertainGroup)}; ${command('uncertain', true)}` }] } } } });
  runner = startRunner();
  await until(async () => (await readFile(witness, 'utf8')).includes('uncertain'), 'real started execution');
  const uncertainProcessGroup = Number(await readFile(uncertainGroup, 'utf8')); ownedGroups.add(uncertainProcessGroup);
  await stop(runner, 'SIGKILL'); runner = startRunner();
  await delay(1200);
  assert.equal(await readFile(witness, 'utf8'), 'build\ntest\nuncertain\n');
  assert.equal((await data(`/api/v1/runs/${uncertain.runId}`)).status, 'running');
  assert.ok(output.includes('automatic replay refused'));
  process.kill(-uncertainProcessGroup, 'SIGKILL'); ownedGroups.delete(uncertainProcessGroup);
  await stop(runner); await stop(control);
  assert.equal((await stat(stateDirectory)).mode & 0o777, 0o700);
  for (const name of await readdir(stateDirectory)) {
    const bytes = await readFile(join(stateDirectory, name));
    assert.equal((await stat(join(stateDirectory, name))).mode & 0o777, 0o600);
    for (const value of [apiKey, registration.runnerSecret, token, key]) assert.equal(bytes.includes(Buffer.from(value)), false, 'Journal must not contain raw job/provider credentials');
  }
  for (const value of [apiKey, registration.runnerSecret, token, key]) assert.equal(output.includes(value), false, 'Child output must not contain credentials');
  console.log('Remote shell DAG passed: real side effects, lost offer/completion recovery, SQLite restart, idempotent completion, authenticated cancellation with owned descendant termination, and uncertain execution refusal');
} finally {
  for (const group of ownedGroups) { try { process.kill(-group, 'SIGKILL'); } catch {} }
  for (const value of children) await stop(value, 'SIGKILL');
  if (proxy) { proxy.closeAllConnections(); await new Promise(resolve => proxy.close(resolve)); }
  await rm(directory, { recursive: true, force: true });
}

/** Actual step transitions through built runner + HTTP + native SQLite. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RemoteRunner } from '../../runner/dist/index.mjs';
const directory = await mkdtemp(join(tmpdir(), 'cifn-step-status-'));
const gate = join(directory, 'release');
const witness = join(directory, 'first');
const active = join(directory, 'second');
const credential = randomBytes(24).toString('hex');
const registration = randomBytes(24).toString('hex');
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
const command = script => `${quote(process.execPath)} -e ${quote(script)}`;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let control, exited, execution, port, output = '';
async function bounded(promise, milliseconds, label) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(label + ' deadline exceeded')), milliseconds); })]); }
  finally { clearTimeout(timer); }
}
async function stopControl() {
  if (!control || !exited) return;
  if (control.exitCode !== null || control.signalCode !== null) { await bounded(exited, 1000, 'Control exit observation'); return; }
  control.kill('SIGTERM');
  try { await bounded(exited, 2000, 'Control TERM'); }
  catch {
    // Only the ChildProcess created above is eligible for forced cleanup.
    if (control.exitCode === null && control.signalCode === null) control.kill('SIGKILL');
    await bounded(exited, 2000, 'Control KILL');
  }
}
async function api(path, body) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${credential}`, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(5000) });
  assert.ok(response.ok, `HTTP ${response.status}`); const envelope = await response.json(); assert.equal(envelope.ok, true); return envelope.data;
}
try {
  control = spawn(process.execPath, [fileURLToPath(new URL('../dist/server.js', import.meta.url))], {
    env: { ...process.env, PORT: '0', CIFN_STORE_ADAPTER: 'sqlite', CIFN_SQLITE_PATH: join(directory, 'state.sqlite'), CIFN_STORE_ENCRYPTION_KEY: randomBytes(32).toString('base64'), CIFN_RUNNER_REGISTRATION_TOKEN: registration, CIFN_API_KEYS: credential, CIFN_QUEUE_ADAPTER: 'memory', CIFN_ARTIFACTS_ADAPTER: 'memory', CIFN_SECRETS_ADAPTER: 'memory', CIFN_LOGS_ADAPTER: 'memory', CIFN_LIFECYCLE_LOGS: 'console', CIFN_NOTIFY_ON_RUN_COMPLETE: 'false' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  exited = once(control, 'exit');
  control.stdout.on('data', bytes => { output += bytes; const match = /listening on port (\d+)/.exec(output); if (match) port = Number(match[1]); });
  control.stderr.on('data', bytes => { output += bytes; });
  for (let i = 0; !port && i < 200; i++) { assert.equal(control.exitCode, null, 'control remains alive'); await delay(25); }
  assert.ok(port, 'control ready');
  const runner = await api('/api/v1/runners/register', { token: registration });
  const run = await api('/api/v1/runs', { trigger: { type: 'workflow_dispatch' }, pipelineSpec: { on: { workflow_dispatch: {} }, jobs: { build: { 'runs-on': 'default', steps: [
    { run: command(`require('fs').writeFileSync(${JSON.stringify(witness)},'finished');`) },
    { run: command(`const fs=require('fs');fs.writeFileSync(${JSON.stringify(active)},'running');const tick=setInterval(()=>{if(fs.existsSync(${JSON.stringify(gate)})){clearInterval(tick);process.exit(0)}},20);setTimeout(()=>process.exit(9),10000);`) },
  ] } } } });
  const runId = run.runId ?? run.id;
  let lostAck = false, terminalAttempts = 0;
  const fetcher = async (url, options) => {
    const response = await fetch(url, options);
    if (String(url).endsWith('/step')) {
      const event = JSON.parse(options.body).event;
      if (event.sequence === 1) {
        terminalAttempts++;
        if (!lostAck && response.ok) { lostAck = true; await response.arrayBuffer(); throw new Error('Owned post-commit lost acknowledgement'); }
      }
    }
    return response;
  };
  execution = new RemoteRunner({ fetch: fetcher, baseUrl: `http://127.0.0.1:${port}`, runnerId: runner.runnerId, runnerSecret: runner.runnerSecret, stateDirectory: join(directory, 'runner') }).tick();
  void execution.catch(() => {});
  let observedActive = false;
  for (let i = 0; i < 150; i++) { try { observedActive = (await readFile(active, 'utf8')) === 'running'; } catch (error) { if (error.code !== 'ENOENT') throw error; } if (observedActive) break; await delay(25); }
  assert.ok(observedActive, 'second shell is active');
  assert.equal(await readFile(witness, 'utf8'), 'finished');
  const before = await api(`/api/v1/runs/${runId}`);
  assert.equal(before.status, 'running'); assert.equal(before.jobs[0].status, 'running');
  assert.deepEqual(before.jobs[0].steps.map(step => step.status), ['success', 'running'], 'actual first completion and second start must be persisted before job completion');
  await writeFile(gate, 'release'); await bounded(execution, 60000, 'Runner completion');
  const after = await api(`/api/v1/runs/${runId}`);
  assert.equal(after.status, 'success'); assert.deepEqual(after.jobs[0].steps.map(step => step.status), ['success', 'success']);
  assert.equal(lostAck, true); assert.ok(terminalAttempts >= 2, 'lost terminal ACK replayed idempotently');
  for (let i = 0; !output.includes('\"msg\":\"run.created\"') && i < 100; i++) await delay(25);
  const lifecycle = output.split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line)).find(event => event.msg === 'run.created');
  assert.equal(lifecycle?.ctx?.runId, runId, 'built server dispatches actual LogFn lifecycle event');
  assert.match(lifecycle.ctx.eventId, /^[a-f0-9]{64}$/);
  console.log(JSON.stringify({ serverLogFnLifecycle: true, stepStatusesPersisted: true, lostAckReplayed: true, whileSecondShellActive: { run: before.status, job: before.jobs[0].status, steps: before.jobs[0].steps.map(step => step.status) }, actualWitnesses: ['first finished', 'second running'], afterRelease: { run: after.status, steps: after.jobs[0].steps.map(step => step.status) }, node: process.version }));
} finally {
  const errors = [];
  try { await writeFile(gate, 'release'); } catch (error) { errors.push(error); }
  // Allow the shell's ten-second safety exit and existing ten-second HTTP requests.
  // A deadline is uncertainty, not proof that a shell stopped: retain its state.
  try { await bounded(execution, 60000, 'Runner cleanup'); } catch (error) { errors.push(error); }
  try { await stopControl(); } catch (error) { errors.push(error); }
  if (errors.length) throw new AggregateError(errors, 'Diagnostic cleanup or execution failed; directory retained');
  await rm(directory, { recursive: true, force: true });
}

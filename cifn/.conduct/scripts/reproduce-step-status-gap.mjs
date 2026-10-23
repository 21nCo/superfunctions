/** Diagnostic baseline: expects the current RUNNER-005 step-status gap, not a readiness pass. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RemoteRunner } from '../../typescript/runner/dist/index.mjs';
const directory = await mkdtemp(join(tmpdir(), 'cifn-step-status-gap-'));
const gate = join(directory, 'release');
const witness = join(directory, 'first');
const active = join(directory, 'second');
const credential = randomBytes(24).toString('hex');
const registration = randomBytes(24).toString('hex');
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
const command = script => `${quote(process.execPath)} -e ${quote(script)}`;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let control, exited, execution, port, output = '';
async function api(path, body) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${credential}`, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(5000) });
  assert.ok(response.ok, `HTTP ${response.status}`); const envelope = await response.json(); assert.equal(envelope.ok, true); return envelope.data;
}
try {
  control = spawn(process.execPath, [fileURLToPath(new URL('../../typescript/control-plane/dist/server.js', import.meta.url))], {
    env: { ...process.env, PORT: '0', CIFN_STORE_ADAPTER: 'sqlite', CIFN_SQLITE_PATH: join(directory, 'state.sqlite'), CIFN_STORE_ENCRYPTION_KEY: randomBytes(32).toString('base64'), CIFN_RUNNER_REGISTRATION_TOKEN: registration, CIFN_API_KEYS: credential, CIFN_QUEUE_ADAPTER: 'memory', CIFN_ARTIFACTS_ADAPTER: 'memory', CIFN_SECRETS_ADAPTER: 'memory', CIFN_LOGS_ADAPTER: 'memory' }, stdio: ['ignore', 'pipe', 'pipe'],
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
  execution = new RemoteRunner({ baseUrl: `http://127.0.0.1:${port}`, runnerId: runner.runnerId, runnerSecret: runner.runnerSecret, stateDirectory: join(directory, 'runner') }).tick();
  void execution.catch(() => {});
  let observedActive = false;
  for (let i = 0; i < 150; i++) { try { observedActive = (await readFile(active, 'utf8')) === 'running'; } catch (error) { if (error.code !== 'ENOENT') throw error; } if (observedActive) break; await delay(25); }
  assert.ok(observedActive, 'second shell is active');
  assert.equal(await readFile(witness, 'utf8'), 'finished');
  const before = await api(`/api/v1/runs/${runId}`);
  assert.equal(before.status, 'running'); assert.equal(before.jobs[0].status, 'running');
  assert.deepEqual(before.jobs[0].steps.map(step => step.status), ['pending', 'pending'], 'baseline gap: first completed and second active are not persisted');
  await writeFile(gate, 'release'); await execution;
  const after = await api(`/api/v1/runs/${runId}`);
  assert.equal(after.status, 'success'); assert.deepEqual(after.jobs[0].steps.map(step => step.status), ['success', 'success']);
  console.log(JSON.stringify({ baselineGapReproduced: true, whileSecondShellActive: { run: before.status, job: before.jobs[0].status, steps: before.jobs[0].steps.map(step => step.status) }, actualWitnesses: ['first finished', 'second running'], afterRelease: { run: after.status, steps: after.jobs[0].steps.map(step => step.status) }, node: process.version }));
} finally {
  const errors = [];
  try { await writeFile(gate, 'release'); } catch (error) { errors.push(error); }
  try { await execution; } catch (error) { errors.push(error); }
  if (control && control.exitCode === null && control.signalCode === null) control.kill('SIGTERM');
  try { if (exited) await exited; } catch (error) { errors.push(error); }
  if (errors.length) throw new AggregateError(errors, 'Diagnostic cleanup or execution failed; directory retained');
  await rm(directory, { recursive: true, force: true });
}

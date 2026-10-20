import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const directory = await mkdtemp(join(tmpdir(), 'cifn-notification-'));
const key = randomBytes(32).toString('base64');
const apiKey = 'disposable-notification-secret'; const token = 'disposable-registration';
const children = []; let port, control, output = '';
let attempts = 0, dropAccepted = true; const received = new Map(); const deliveredIds = [];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label, timeout = 20_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const result = await check(); if (result) return result; await delay(30); }
  throw Error(`Timed out: ${label}`);
}
const receiver = createServer(async (req, res) => {
  const chunks = []; for await (const chunk of req) chunks.push(chunk);
  const payload = JSON.parse(Buffer.concat(chunks));
  assert.equal(req.headers['idempotency-key'], payload.eventId);
  assert.equal(req.headers['x-cifn-event-id'], payload.eventId);
  attempts++;
  if (attempts === 1) { res.writeHead(503); res.end(); return; }
  received.set(payload.eventId, payload); deliveredIds.push(payload.eventId);
  if (dropAccepted) { dropAccepted = false; res.destroy(); return; }
  res.writeHead(204); res.end();
});
async function stop(value, signal = 'SIGTERM') {
  if (value.child.exitCode === null && value.child.signalCode === null) value.child.kill(signal);
  await value.exited;
}
async function start(enabled = true) {
  const child = spawn(process.execPath, [fileURLToPath(new URL('../dist/server.js', import.meta.url))], {
    env: { ...process.env, PORT: '0', CIFN_RUNNER_REGISTRATION_TOKEN: token, CIFN_API_KEYS: apiKey,
      CIFN_STORE_ADAPTER: 'sqlite', CIFN_SQLITE_PATH: join(directory, 'state.sqlite'), CIFN_STORE_ENCRYPTION_KEY: key,
      CIFN_NOTIFY_ON_RUN_COMPLETE: String(enabled), CIFN_NOTIFICATION_WEBHOOK_URL: `http://127.0.0.1:${receiver.address().port}/events?credential=private-webhook-token`,
      CIFN_QUEUE_ADAPTER: 'memory', CIFN_ARTIFACTS_ADAPTER: 'memory', CIFN_SECRETS_ADAPTER: 'memory', CIFN_LOGS_ADAPTER: 'memory',
    }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const value = { child, exited: once(child, 'exit') }; children.push(value);
  let listening;
  child.stdout.on('data', chunk => { output += chunk; const match = /Control Plane listening on port (\d+)/.exec(String(chunk)); if (match) listening = Number(match[1]); });
  child.stderr.on('data', chunk => { output += chunk; });
  port = await until(async () => { if (child.exitCode !== null) throw Error('Server exited before readiness'); return listening; }, 'control startup');
  return value;
}
async function data(path, body, credential = apiKey) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${credential}` }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(5_000) });
  assert.ok(response.ok, `${path}: ${response.status}`); return (await response.json()).data;
}
const input = { trigger: { type: 'workflow_dispatch', payload: { token: apiKey } }, pipelineSpec: { on: { workflow_dispatch: {} }, env: { TOKEN: '${{ secrets.CIFN_API_KEYS }}' }, jobs: { job: { 'runs-on': 'default', steps: [{ run: 'true' }] } } } };
try {
  await new Promise(resolve => receiver.listen(0, '127.0.0.1', resolve));
  control = await start();
  const runner = await data('/api/v1/runners/register', { token });
  const run = await data('/api/v1/runs', input);
  const offer = await data('/api/v1/runners/heartbeat', { runnerId: runner.runnerId }, runner.runnerSecret);
  const identity = { runId: run.runId, dispatchId: offer.job.dispatchId, claimToken: offer.job.claimToken, runnerId: runner.runnerId, executionId: 'notification-protocol-acceptance' };
  await data('/api/v1/runners/claims/ack', identity, runner.runnerSecret);
  const completion = { ...identity, result: { status: 'success', steps: [{ stepKey: 'step-0', status: 'success' }] } };
  await data('/api/v1/runners/claims/complete', completion, runner.runnerSecret);
  await until(async () => deliveredIds.length === 1, 'receiver accepted response loss');
  await stop(control, 'SIGKILL'); control = await start();
  await until(async () => deliveredIds.length >= 2, 'outbox retry after process restart');
  assert.equal(received.size, 1); assert.equal(new Set(deliveredIds).size, 1);
  const first = [...received.values()][0]; assert.equal(first.status, 'success'); assert.equal(first.runId, run.runId);
  assert.deepEqual(first.trigger, { type: 'workflow_dispatch' }); assert.equal(JSON.stringify(first).includes(apiKey), false);
  await data('/api/v1/runners/claims/complete', completion, runner.runnerSecret);
  const cancelled = await data('/api/v1/runs', input); await data(`/api/v1/runs/${cancelled.runId}/cancel`, {});
  await until(async () => received.size === 2, 'cancel intent delivery');
  assert.ok([...received.values()].some(value => value.status === 'cancelled' && value.summary.includes('cancellation requested')));
  await delay(250); await stop(control); control = await start(false);
  const before = attempts; const disabled = await data('/api/v1/runs', input); await data(`/api/v1/runs/${disabled.runId}/cancel`, {});
  await delay(1_200); assert.equal(attempts, before); await stop(control);
  // Durable receipt evidence is also exercised by the native SQLite unit tests.
  const bytes = await readFile(join(directory, 'state.sqlite'));
  assert.equal(bytes.includes(Buffer.from('private-webhook-token')), false);
  assert.equal(bytes.includes(Buffer.from(apiKey)), false);
  for (const value of [apiKey, key, token, 'private-webhook-token']) assert.equal(output.includes(value), false);
  console.log('Notification HTTP acceptance passed: failure, accepted response loss, SIGKILL/restart replay, receiver dedupe, cancellation intent, disabled configuration, and secret-safe persistence/output');
} finally {
  for (const child of children) await stop(child, 'SIGKILL');
  receiver.closeAllConnections(); await new Promise(resolve => receiver.close(resolve));
  await rm(directory, { recursive: true, force: true });
}

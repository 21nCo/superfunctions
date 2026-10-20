import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const directory = await mkdtemp(join(tmpdir(), 'cifn-process-recovery-'));
const key = randomBytes(32).toString('base64');
const apiKey = 'disposable-process-api-secret';
const token = 'disposable-process-registration-token';
const children = [];
let output = '';
async function start() {
  const child = spawn(process.execPath, [fileURLToPath(new URL('../dist/server.js', import.meta.url))], {
    env: { ...process.env, PORT: '0', CIFN_RUNNER_REGISTRATION_TOKEN: token, CIFN_API_KEYS: apiKey,
      CIFN_STORE_ADAPTER: 'sqlite', CIFN_SQLITE_PATH: join(directory, 'state.sqlite'),
      CIFN_STORE_ENCRYPTION_KEY: key, CIFN_STORE_NAMESPACE: 'process-acceptance',
      CIFN_QUEUE_ADAPTER: 'memory', CIFN_ARTIFACTS_ADAPTER: 'memory', CIFN_SECRETS_ADAPTER: 'memory', CIFN_LOGS_ADAPTER: 'memory' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const exited = once(child, 'exit');
  children.push({ child, exited });
  child.stderr.on('data', chunk => { output += chunk; });
  let timer;
  try {
    const port = await new Promise((resolve, reject) => {
      let stdout = '';
      timer = setTimeout(() => reject(new Error('Server readiness timed out')), 10000);
      child.once('error', reject);
      child.once('exit', () => reject(new Error(`Server exited before readiness: ${output}`)));
      child.stdout.on('data', chunk => {
        output += chunk; stdout += chunk;
        const match = /Control Plane listening on port (\d+)/.exec(stdout);
        if (match) resolve(Number(match[1]));
      });
    });
    const request = async (path, body, credential = apiKey) => {
      const response = await fetch(`http://127.0.0.1:${port}${path}`, {
        method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${credential}` },
        body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(5000),
      });
      assert.ok(response.ok, `${path}: HTTP ${response.status}`);
      const result = await response.json(); assert.equal(result.ok, true); return result.data;
    };
    return { child, exited, request };
  } finally { clearTimeout(timer); }
}
try {
  const first = await start();
  const registration = await first.request('/api/v1/runners/register', { token, labels: ['default'] });
  const input = { trigger: { type: 'workflow_dispatch' }, pipelineSpec: {
    name: 'restart', on: { workflow_dispatch: {} }, env: { TOKEN: '${{ secrets.CIFN_API_KEYS }}' },
    jobs: { build: { 'runs-on': 'default', steps: [{ run: 'echo restart' }] } },
  } };
  const running = await first.request('/api/v1/runs', input);
  const queued = await first.request('/api/v1/runs', input);
  const assigned = await first.request('/api/v1/runners/heartbeat', { runnerId: registration.runnerId }, registration.runnerSecret);
  assert.equal(assigned.job.runId, running.runId);
  const before = await first.request(`/api/v1/runs/${running.runId}`);
  assert.equal(before.jobs[0].status, 'running');
  first.child.kill('SIGKILL'); await first.exited;
  const second = await start();
  assert.deepEqual(await second.request(`/api/v1/runs/${running.runId}`), before);
  const pending = await second.request(`/api/v1/runs/${queued.runId}`);
  assert.equal(pending.status, 'queued'); assert.equal(pending.jobs[0].status, 'pending');
  const heartbeat = await second.request('/api/v1/runners/heartbeat', { runnerId: registration.runnerId }, registration.runnerSecret);
  // Only unclaimed intent is replayed after the delivery interval. The job
  // assigned before SIGKILL must never be silently reassigned.
  let replay = heartbeat.job;
  const deadline = Date.now() + 40_000;
  while (!replay && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 250));
    replay = (await second.request('/api/v1/runners/heartbeat', { runnerId: registration.runnerId }, registration.runnerSecret)).job;
  }
  assert.ok(replay, 'Unclaimed dispatch must recover from lost memory transport');
  assert.equal(replay.runId, queued.runId);
  assert.equal(typeof replay.dispatchId, 'string');
  assert.equal(typeof replay.claimToken, 'string');
  assert.equal((await second.request('/api/v1/runners/heartbeat', { runnerId: registration.runnerId }, registration.runnerSecret)).job, null);
  for (const name of await readdir(directory)) {
    const bytes = await readFile(join(directory, name));
    for (const value of [apiKey, token, registration.runnerSecret, key]) {
      assert.equal(bytes.includes(Buffer.from(value)), false, 'Database must not contain plaintext secrets');
      assert.equal(output.includes(value), false, 'Process output must not contain secrets');
    }
  }
  console.log('Built SQLite server SIGKILL/restart passed: jobs and runner authentication survive; only unclaimed dispatch is replayed');
} finally {
  for (const { child, exited } of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    await exited;
  }
  await rm(directory, { recursive: true, force: true });
}

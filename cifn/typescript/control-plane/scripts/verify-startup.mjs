import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

const child = spawn(process.execPath, [fileURLToPath(new URL('../dist/server.js', import.meta.url))], {
  env: { ...process.env, PORT: '0', CIFN_RUNNER_REGISTRATION_TOKEN: 'disposable-startup-token', CIFN_API_KEYS: '',
    CIFN_QUEUE_ADAPTER: 'memory', CIFN_ARTIFACTS_ADAPTER: 'memory', CIFN_SECRETS_ADAPTER: 'memory', CIFN_LOGS_ADAPTER: 'memory' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const exited = once(child, 'exit');
let timer;
try {
  const port = await new Promise((resolve, reject) => {
    let output = '';
    timer = setTimeout(() => reject(new Error('Startup did not listen within 10 seconds')), 10000);
    child.once('error', reject);
    child.once('exit', code => reject(new Error(`Server exited before readiness: ${code}`)));
    child.stdout.on('data', chunk => {
      output += chunk;
      const match = /Control Plane listening on port (\d+)/.exec(output);
      if (match) resolve(Number(match[1]));
    });
  });
  clearTimeout(timer);
  const base = `http://127.0.0.1:${port}`;
  const post = (path, body, headers = {}) => fetch(base + path, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(5000) });
  const denied = await post('/api/v1/runners/register', { token: 'wrong-token' });
  assert.equal(denied.status, 401);
  const response = await post('/api/v1/runners/register', { token: 'disposable-startup-token', labels: ['default'] });
  assert.equal(response.status, 200, 'Configured registration token must work through the actual server entrypoint');
  const registration = await response.json();
  assert.equal(registration.ok, true);
  assert.equal(typeof registration.data.runnerSecret, 'string');
  const heartbeat = await post('/api/v1/runners/heartbeat', { runnerId: registration.data.runnerId }, { Authorization: `Bearer ${registration.data.runnerSecret}` });
  assert.equal(heartbeat.status, 200);
  assert.deepEqual(await heartbeat.json(), { ok: true, data: { job: null } });
  console.log('Built startup registration and heartbeat passed');
} finally {
  clearTimeout(timer);
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  await exited;
}

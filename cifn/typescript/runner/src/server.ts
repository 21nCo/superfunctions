import { OwnedDockerExecutor } from './owned-docker-executor.js';
import { join } from 'node:path';
import { RemoteRunner } from './remote-runner.js';

const required = ['CIFN_CONTROL_PLANE_URL', 'CIFN_RUNNER_SECRET', 'CIFN_RUNNER_ID', 'CIFN_RUNNER_STATE_DIR'] as const;
for (const name of required) {
  if (!process.env[name]) { console.error(`Missing required environment variable: ${name}`); process.exit(1); }
}
const hostFnText = process.env.CIFN_HOSTFN_POLICY;
if (hostFnText !== undefined && Buffer.byteLength(hostFnText) > 8192) throw new Error('HostFn policy exceeds limit');
let hostFn;
try { hostFn = hostFnText === undefined ? undefined : JSON.parse(hostFnText); } catch { throw new Error('Invalid trusted HostFn policy'); }
const runner = new RemoteRunner({ hostFn, ownedDockerExecutor: process.env.CIFN_DOCKER_CONTEXT ? new OwnedDockerExecutor({context:process.env.CIFN_DOCKER_CONTEXT,stateDirectory:join(process.env.CIFN_RUNNER_STATE_DIR!,'containers')}) : undefined, baseUrl: process.env.CIFN_CONTROL_PLANE_URL!, runnerSecret: process.env.CIFN_RUNNER_SECRET!, runnerId: process.env.CIFN_RUNNER_ID!, stateDirectory: process.env.CIFN_RUNNER_STATE_DIR!, logRetentionMs: process.env.CIFN_LOG_RETENTION_MS === undefined ? undefined : Number(process.env.CIFN_LOG_RETENTION_MS) });
const interval = Number(process.env.CIFN_POLL_INTERVAL_MS ?? '1000');
if (!Number.isFinite(interval) || interval < 10) throw new Error('Invalid runner poll interval');
let stopping = false;
process.once('SIGTERM', () => { stopping = true; });
process.once('SIGINT', () => { stopping = true; });
async function main() {
  console.log('CiFn remote shell runner started');
  while (!stopping) {
    try { await runner.tick(); } catch { console.error('CiFn runner request failed; saved work remains pending'); }
    if (!stopping) await new Promise(resolve => setTimeout(resolve, interval));
  }
}
void main().catch(() => { console.error('CiFn runner stopped unexpectedly'); process.exitCode = 1; });

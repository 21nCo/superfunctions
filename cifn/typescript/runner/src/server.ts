import { RemoteRunner } from './remote-runner.js';

const required = ['CIFN_CONTROL_PLANE_URL', 'CIFN_RUNNER_SECRET', 'CIFN_RUNNER_ID', 'CIFN_RUNNER_STATE_DIR'] as const;
for (const name of required) {
  if (!process.env[name]) { console.error(`Missing required environment variable: ${name}`); process.exit(1); }
}
const runner = new RemoteRunner({ baseUrl: process.env.CIFN_CONTROL_PLANE_URL!, runnerSecret: process.env.CIFN_RUNNER_SECRET!, runnerId: process.env.CIFN_RUNNER_ID!, stateDirectory: process.env.CIFN_RUNNER_STATE_DIR! });
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

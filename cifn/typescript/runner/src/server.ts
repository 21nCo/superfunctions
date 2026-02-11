import { Runner } from './runner.js';

const CONTROL_PLANE_URL = process.env.CIFN_CONTROL_PLANE_URL;
const RUNNER_SECRET = process.env.CIFN_RUNNER_SECRET;
const RUNNER_ID = process.env.CIFN_RUNNER_ID;
const LABELS = (process.env.CIFN_RUNNER_LABELS ?? 'default').split(',').map(l => l.trim());
const POLL_INTERVAL = parseInt(process.env.CIFN_POLL_INTERVAL_MS ?? '5000', 10);

const required: Record<string, string | undefined> = {
  CIFN_CONTROL_PLANE_URL: CONTROL_PLANE_URL,
  CIFN_RUNNER_SECRET: RUNNER_SECRET,
  CIFN_RUNNER_ID: RUNNER_ID,
};

for (const [name, value] of Object.entries(required)) {
  if (!value) {
    console.error(`Missing required environment variable: ${name}`);
    process.exit(1);
  }
}

async function poll(): Promise<void> {
  try {
    const res = await fetch(`${CONTROL_PLANE_URL}/api/v1/runners/heartbeat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${RUNNER_SECRET}`,
      },
      body: JSON.stringify({ runnerId: RUNNER_ID }),
    });
    const body = await res.json() as { ok: boolean; data?: { job: unknown } };
    if (body.ok && body.data?.job) {
      console.log(`Received job: ${JSON.stringify(body.data.job)}`);
    }
  } catch (err) {
    console.error('Heartbeat failed:', err instanceof Error ? err.message : err);
  }
}

console.log(`CiFn Runner starting (id=${RUNNER_ID}, labels=${LABELS.join(',')})`);
console.log(`Polling ${CONTROL_PLANE_URL} every ${POLL_INTERVAL}ms`);

async function main() {
  while (true) {
    await poll();
    await new Promise(r => setTimeout(r, POLL_INTERVAL));
  }
}

main().catch(err => {
  console.error('Runner failed:', err);
  process.exit(1);
});

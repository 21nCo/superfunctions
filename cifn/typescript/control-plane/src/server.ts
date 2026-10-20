import { createControlPlaneServer } from './http-server.js';
import { createApp } from './api/routes.js';
import { parseAdapterConfig, validateAdapterConfig } from './integrations/config.js';
import { createQueueAdapter } from './integrations/flowfn.js';
import { createArtifactsAdapter } from './integrations/filefn.js';
import { createSecretsAdapter } from './integrations/secfn.js';
import { createLogsAdapter } from './integrations/logfn.js';
import { createRuntimeStore } from './store/runtime-store.js';

const PORT = parseInt(process.env.PORT ?? '3100', 10);

const requiredEnv: Record<string, string | undefined> = {
  CIFN_RUNNER_REGISTRATION_TOKEN: process.env.CIFN_RUNNER_REGISTRATION_TOKEN,
};

for (const [name, value] of Object.entries(requiredEnv)) {
  if (!value) {
    console.error(`Fatal: missing required environment variable: ${name}`);
    process.exit(1);
  }
}

const adapterConfig = parseAdapterConfig(process.env);
const validation = validateAdapterConfig(adapterConfig);
if (!validation.ok) {
  for (const err of validation.errors) {
    console.error(`Fatal: ${err}`);
  }
  process.exit(1);
}

const adapters = {
  queue: createQueueAdapter(adapterConfig.queue),
  artifacts: createArtifactsAdapter(adapterConfig.artifacts),
  secrets: createSecretsAdapter(adapterConfig.secrets),
  logs: createLogsAdapter(adapterConfig.logs),
};

async function start() {
  const initialApiKeys = process.env.CIFN_API_KEYS;
  if (initialApiKeys && adapterConfig.secrets.type === 'memory') {
    await adapters.secrets.setSecret('CIFN_API_KEYS', initialApiKeys);
  }

  const registrationToken = process.env.CIFN_RUNNER_REGISTRATION_TOKEN!;
  if (adapterConfig.secrets.type === 'memory') {
    await adapters.secrets.setSecret('CIFN_RUNNER_REGISTRATION_TOKEN', registrationToken);
  }

  const webhookSecret = process.env.CIFN_WEBHOOK_SECRET;

  const runtimeStore = await createRuntimeStore();
  const { app } = createApp({ adapters, webhookSecret, store: runtimeStore.store });

  const server = createControlPlaneServer(app);
  let closing = false;
  const close = () => {
    if (closing) return;
    closing = true;
    server.close(async () => {
      try { await runtimeStore.close(); }
      catch { console.error('CiFn store shutdown failed'); process.exitCode = 1; }
    });
  };
  process.once('SIGTERM', close);
  process.once('SIGINT', close);
  server.once('error', () => {
    process.exitCode = 1;
    void runtimeStore.close().catch(() => console.error('CiFn store shutdown failed'));
  });

  server.listen(PORT, () => {
    const address = server.address();
    const listeningPort = address && typeof address === 'object' ? address.port : PORT;
    console.log(`CiFn Control Plane listening on port ${listeningPort}`);
    console.log(`Store: ${runtimeStore.mode}`);
    console.log(`Adapters: queue=${adapterConfig.queue.type}, artifacts=${adapterConfig.artifacts.type}, secrets=${adapterConfig.secrets.type}, logs=${adapterConfig.logs.type}`);
  });
}
start().catch((cause: unknown) => {
  console.error(`Fatal: ${cause instanceof Error ? cause.message : "Control-plane startup failed"}`);
  process.exitCode = 1;
});

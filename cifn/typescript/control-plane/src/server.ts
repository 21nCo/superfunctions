import { createControlPlaneServer } from './http-server.js';
import { createApp } from './api/routes.js';
import { parseAdapterConfig, validateAdapterConfig } from './integrations/config.js';
import { createQueueAdapter } from './integrations/flowfn.js';
import { createArtifactsAdapter } from './integrations/filefn.js';
import { createSecretsAdapter } from './integrations/secfn.js';
import { createLogsAdapter } from './integrations/logfn.js';

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

const initialApiKeys = process.env.CIFN_API_KEYS;
if (initialApiKeys && adapterConfig.secrets.type === 'memory') {
  adapters.secrets.setSecret('CIFN_API_KEYS', initialApiKeys);
}

const registrationToken = process.env.CIFN_RUNNER_REGISTRATION_TOKEN!;
if (adapterConfig.secrets.type === 'memory') {
  adapters.secrets.setSecret('CIFN_RUNNER_REGISTRATION_TOKEN', registrationToken);
}

const webhookSecret = process.env.CIFN_WEBHOOK_SECRET;

const { app } = createApp({ adapters, webhookSecret });

const server = createControlPlaneServer(app);

server.listen(PORT, () => {
  const address = server.address();
  const listeningPort = address && typeof address === 'object' ? address.port : PORT;
  console.log(`CiFn Control Plane listening on port ${listeningPort}`);
  console.log(`Adapters: queue=${adapterConfig.queue.type}, artifacts=${adapterConfig.artifacts.type}, secrets=${adapterConfig.secrets.type}, logs=${adapterConfig.logs.type}`);
});

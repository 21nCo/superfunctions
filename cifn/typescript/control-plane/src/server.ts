import { createServer } from 'node:http';
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
  adapters.secrets.setSecret('cifn.runner.registration_token', registrationToken);
}

const webhookSecret = process.env.CIFN_WEBHOOK_SECRET;

const { app } = createApp({ adapters, webhookSecret });

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);

  if (url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value) headers.set(key, Array.isArray(value) ? value.join(', ') : value);
  }

  const bodyParts: Buffer[] = [];
  for await (const chunk of req) {
    bodyParts.push(chunk);
  }
  const body = Buffer.concat(bodyParts);

  const request = new Request(url.toString(), {
    method: req.method,
    headers,
    body: ['GET', 'HEAD'].includes(req.method ?? 'GET') ? undefined : body,
  });

  const response = await app.fetch(request);

  const respHeaders: Record<string, string> = {};
  response.headers.forEach((v, k) => { respHeaders[k] = v; });
  res.writeHead(response.status, respHeaders);

  const respBody = await response.arrayBuffer();
  res.end(Buffer.from(respBody));
});

server.listen(PORT, () => {
  console.log(`CiFn Control Plane listening on port ${PORT}`);
  console.log(`Adapters: queue=${adapterConfig.queue.type}, artifacts=${adapterConfig.artifacts.type}, secrets=${adapterConfig.secrets.type}, logs=${adapterConfig.logs.type}`);
});

import {
  MemoryAdminAuditSink,
  MemoryAdminIdempotencyStore,
} from '../../../packages/admin/dist/index.js';
import {
  createCiFnAdminAdapter,
  createCiFnControlPlaneAdminService,
} from '../../../cifn/admin/dist/index.js';
import {
  createApp,
  MemoryArtifactsAdapter,
  MemoryLogsAdapter,
  MemoryQueueAdapter,
  MemorySecretsAdapter,
} from '../../../cifn/typescript/control-plane/dist/index.js';
import { createSuperConsole } from '../../dist/server/index.js';

const scope = {
  organizationId: 'probe-org',
  workspaceId: 'probe-workspace',
  projectId: 'probe-project',
  environmentId: 'probe-environment',
  namespace: 'probe-tenant',
  region: 'local',
};

const principal = {
  actor: { id: 'probe-operator', permissions: ['*'] },
  displayName: 'Probe Operator',
  email: 'probe@example.test',
  role: 'installation administrator',
  defaultScope: scope,
};

const operationContext = {
  scope,
  actor: principal.actor,
  requestId: 'probe-installation-seed',
  source: 'console',
  idempotencyKey: 'probe-seed-run',
};

const API_KEY = 'probe-control-plane-key';
const artifacts = new MemoryArtifactsAdapter();
const logs = new MemoryLogsAdapter();
const queue = new MemoryQueueAdapter();
const secrets = new MemorySecretsAdapter();
await secrets.setSecret('CIFN_API_KEYS', API_KEY);

const controlPlane = createApp({
  adapters: { artifacts, logs, queue, secrets },
  pipelineResolver: async () => ({
    doc: JSON.stringify({
      name: 'Super Console production probe',
      on: { workflow_dispatch: {} },
      jobs: {
        verify: {
          'runs-on': 'default',
          steps: [{ run: 'npm test' }],
        },
      },
    }),
    resolvedConfigPath: '.ci/probe.json',
  }),
});

const ciFnService = createCiFnControlPlaneAdminService({
  resolveConnection: async () => ({
    baseUrl: 'http://cifn-control-plane.probe',
    apiKey: API_KEY,
    fetch: (input, init) => controlPlane.app.fetch(new Request(input, init)),
  }),
});

const seededRun = await ciFnService.triggerRun({
  trigger: { type: 'workflow_dispatch' },
  pipelineRef: {
    repo: '21nCo/super-functions',
    ref: 'refs/heads/codex/super-console',
    configPath: '.ci/probe.json',
  },
}, operationContext);
controlPlane.store.updateRunStatus(seededRun.runId, 'running');
await logs.appendJobLogLine(seededRun.runId, 'verify', {
  line: 'CiFn control-plane probe run started',
  timestamp: '2026-08-13T06:00:00.000Z',
  stepKey: 'step-0',
});

const ciFn = createCiFnAdminAdapter(ciFnService);

const confirmation = {
  issue: async () => ({
    token: 'probe-bound-confirmation',
    expiresAt: '2026-08-13T10:00:00.000Z',
  }),
  verify: async ({ token }) => token === 'probe-bound-confirmation',
};

export const superConsole = createSuperConsole({
  adapters: [ciFn],
  enabledModules: ['cifn'],
  auth: {
    authenticate: async () => principal,
    authorizeScope: async ({ requested }) => requested,
    authorizeMutation: async () => undefined,
  },
  shellPolicy: { authorize: () => true },
  openApiSecuritySchemes: {
    operatorSession: { type: 'apiKey', in: 'cookie', name: 'probe.session' },
    operatorApiKey: { type: 'http', scheme: 'bearer', bearerFormat: 'Operator API key' },
  },
  openApiCsrfHeader: { name: 'X-Probe-CSRF' },
  audit: new MemoryAdminAuditSink(),
  idempotency: new MemoryAdminIdempotencyStore(),
  confirmation,
  overview: {
    read: async () => ({
      metrics: [{ id: 'probe-runs', label: 'Probe runs', value: 1, detail: 'CiFn control-plane-backed production smoke run' }],
      alerts: [],
      activity: [],
      health: [{ moduleId: 'cifn', moduleName: 'CiFn', status: 'healthy' }],
    }),
  },
});

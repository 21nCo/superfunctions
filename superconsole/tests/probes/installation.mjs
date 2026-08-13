import {
  MemoryAdminAuditSink,
  MemoryAdminIdempotencyStore,
} from '../../../packages/admin/dist/index.js';
import { createCiFnAdminAdapter } from '../../../cifn/admin/dist/index.js';
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

const run = {
  id: 'probe-run-001',
  runId: 'probe-run-001',
  status: 'running',
  createdAt: '2026-08-13T03:30:00.000Z',
  updatedAt: '2026-08-13T03:32:00.000Z',
  pipelineRef: {
    repo: '21nCo/super-functions',
    ref: 'refs/heads/codex/super-console',
    configPath: '.github/workflows/verify.yml',
  },
  trigger: { type: 'workflow_dispatch' },
  jobs: [{
    id: 'probe-job-001',
    jobKey: 'verify',
    status: 'running',
    startedAt: '2026-08-13T03:30:10.000Z',
    steps: [{ id: 'probe-step-001', stepKey: 'test', status: 'success' }],
  }],
};

const ciFn = createCiFnAdminAdapter({
  execute({ operationId, input }) {
    if (operationId === 'cifn.runs.list') {
      return { ok: true, data: { items: [run], nextCursor: null } };
    }
    if (operationId === 'cifn.runs.get') {
      return { ok: true, data: { item: run } };
    }
    if (operationId.endsWith('.list')) {
      return { ok: true, data: { items: [], nextCursor: null } };
    }
    if (operationId.endsWith('.get')) {
      return { ok: true, data: { item: { id: String(input?.id ?? 'probe-item') } } };
    }
    return {
      ok: true,
      data: { accepted: true, operationReference: `probe:${operationId}` },
    };
  },
});

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
  audit: new MemoryAdminAuditSink(),
  idempotency: new MemoryAdminIdempotencyStore(),
  confirmation,
  overview: {
    read: async () => ({
      metrics: [{ id: 'probe-runs', label: 'Probe runs', value: 1, detail: 'Production-build smoke fixture' }],
      alerts: [],
      activity: [],
      health: [{ moduleId: 'cifn', moduleName: 'CiFn', status: 'healthy' }],
    }),
  },
});

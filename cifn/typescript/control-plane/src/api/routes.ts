import { prepareRun, acceptRun } from '../dispatch/prepare.js';
import { isDispatchStore } from '../dispatch/types.js';
import { DispatchPublisher } from '../dispatch/publisher.js';
import { Hono } from 'hono';
import { readJsonBody, readBodyText, PayloadTooLargeError } from './body.js';
import type { ControlPlaneStore } from '../store/store.js';
import { MemoryStore, type CreateRunInput } from '../store/memory-store.js';
import { validate } from '../pipeline/validator.js';
import { parse, normalizeParsedPipeline } from '../pipeline/parser.js';
import { resolvePipelineDoc, ResolverError, type PipelineRef } from '../pipeline/resolver.js';
import { success, error } from './envelope.js';
import { MemoryQueueClient, DEFAULT_QUEUE_NAME, type QueueClient } from '../queue/flowfn-client.js';
import type { RunStatus, TriggerType, PipelineSpec } from '../pipeline/types.js';
import { handleWebhook } from '../triggers/webhook.js';
import type { IntegrationAdapters } from '../integrations/types.js';
import { authMiddleware } from './auth.js';
import { registerRunner } from '../runners/register.js';
import { compareSecretHash } from '../runners/crypto.js';
import { SendFnClient, MemorySendFnClient, type SendFnConfig } from '../sendfn/sendfn-client.js';

const VALID_TRIGGER_TYPES: TriggerType[] = ['push', 'pull_request', 'schedule', 'workflow_dispatch'];

export type PipelineDocResolver = (ref: PipelineRef) => Promise<{ doc: string; resolvedConfigPath: string }>;

export interface CreateAppOptions<TStore extends ControlPlaneStore = ControlPlaneStore> {
  store?: TStore;
  /** @deprecated Use adapters.queue instead */
  queue?: QueueClient;
  /** @deprecated Use adapters.logs instead */
  logClient?: { getLines(runId: string, jobKey: string): Array<{ line: string; timestamp: string; stepKey: string }> };
  webhookSecret?: string;
  /** Resolves pipelineRef to pipeline document string. Required for pipelineRef and webhook run creation. */
  pipelineResolver?: PipelineDocResolver;
  /** @deprecated Use adapters.secrets instead */
  secFn?: any;
  sendFn?: SendFnClient;
  sendFnConfig?: SendFnConfig;
  /** Integration adapters for queue, artifacts, secrets, and logs. Takes precedence over individual options. */
  adapters?: IntegrationAdapters;
}

export function createApp<TStore extends ControlPlaneStore = MemoryStore>(options: CreateAppOptions<TStore> = {}) {
  const app = new Hono();
  const runStore = (options.store ?? new MemoryStore()) as TStore;
  
  const queue = options.adapters?.queue ?? options.queue ?? new MemoryQueueClient();
  const artifactAdapter = options.adapters?.artifacts;
  const secFn = options.adapters?.secrets ?? options.secFn;
  const logs = options.adapters?.logs;
  const logClient = options.logClient;
  
  const sendFn = options.sendFn ?? new MemorySendFnClient();
  const sendFnConfig = options.sendFnConfig ?? { enabled: false };

  // Set up sendfn notification hook for run status changes
  runStore.setRunStatusChangeCallback((run) => {
    if (sendFnConfig.enabled && (run.status === 'success' || run.status === 'failure')) {
      const summary = `Run ${run.id} ${run.status}: ${Object.keys(run.jobs).length} job(s)`;
      sendFn.sendNotification({
        runId: run.id,
        status: run.status,
        pipelineRef: run.pipelineRef,
        trigger: run.trigger,
        createdAt: run.createdAt,
        completedAt: run.updatedAt,
        summary,
      }).catch(err => {
        console.error(`Failed to send notification for run ${run.id}:`, err);
      });
    }
  });

  const api = new Hono();

  // Apply Auth Middleware to all /api/v1 routes
  // Exclude /runners/register (uses token in body) and /runners/heartbeat (custom runner auth)
  // Health check is handled in middleware but we can also exclude it here if needed.
  api.use('/*', authMiddleware(secFn, ['/api/v1/runners/register', '/api/v1/runners/heartbeat']));

  api.post('/runs', async (c) => {
    let body: Record<string, unknown>;
    try {
      body = await readJsonBody(c.req.raw);
    } catch (cause) {
      if (cause instanceof PayloadTooLargeError) return c.json(error('PAYLOAD_TOO_LARGE', 'Request body too large'), 413);
      return c.json(error('BAD_REQUEST', 'Invalid or missing JSON body'), 400);
    }

    if (!body || typeof body !== 'object') {
      return c.json(error('BAD_REQUEST', 'Request body must be a JSON object'), 400);
    }

    const trigger = body.trigger as { type?: string; payload?: Record<string, unknown> } | undefined;
    if (!trigger || typeof trigger !== 'object' || !trigger.type) {
      return c.json(error('BAD_REQUEST', 'Missing or invalid trigger'), 400);
    }

    if (!VALID_TRIGGER_TYPES.includes(trigger.type as TriggerType)) {
      return c.json(error('BAD_REQUEST', `Invalid trigger type: ${trigger.type}`), 400);
    }

    const pipelineSpec = body.pipelineSpec as Record<string, unknown> | undefined;
    const pipelineRef = body.pipelineRef as { repo?: string; ref?: string; configPath?: string } | undefined;

    if (!pipelineSpec && !pipelineRef) {
      return c.json(error('BAD_REQUEST', 'Either pipelineSpec or pipelineRef is required'), 400);
    }

    let resolvedSpec: PipelineSpec;
    let runPipelineRef: { repo: string; ref: string; configPath?: string } | undefined;

    // If both provided, use pipelineSpec (per SPEC)
    if (pipelineSpec) {
      const validationResult = validate(normalizeParsedPipeline(pipelineSpec));
      if (!validationResult.ok) {
        const details = pipelineRef ? { ...validationResult.details, warning: 'Both pipelineSpec and pipelineRef provided; pipelineSpec was used' } : validationResult.details;
        return c.json(error('PIPELINE_INVALID', validationResult.message, details), 422);
      }
      resolvedSpec = validationResult.spec;
      if (pipelineRef) {
        runPipelineRef = { repo: pipelineRef.repo ?? '', ref: pipelineRef.ref ?? '', configPath: pipelineRef.configPath };
      }
    } else if (pipelineRef) {
      if (!pipelineRef.repo || !pipelineRef.ref) {
        return c.json(error('BAD_REQUEST', 'pipelineRef requires repo and ref'), 400);
      }
      const resolver = options.pipelineResolver;
      if (!resolver) {
        return c.json(error('RUN_CREATE_FAILED', 'Pipeline resolver not configured'), 422);
      }
      const ref: PipelineRef = { repo: pipelineRef.repo, ref: pipelineRef.ref, configPath: pipelineRef.configPath };
      let doc: string;
      let resolvedConfigPath: string;
      try {
        const result = await resolver(ref);
        doc = result.doc;
        resolvedConfigPath = result.resolvedConfigPath;
      } catch (err) {
        const message = err instanceof ResolverError ? err.message : (err instanceof Error ? err.message : 'Pipeline resolution failed');
        return c.json(error('RUN_CREATE_FAILED', message), 422);
      }
      let parsed: unknown;
      try {
        parsed = parse(doc);
      } catch {
        return c.json(error('PIPELINE_INVALID', 'Pipeline document parse failed'), 422);
      }
      const validationResult = validate(normalizeParsedPipeline(parsed));
      if (!validationResult.ok) {
        return c.json(error('PIPELINE_INVALID', validationResult.message, validationResult.details), 422);
      }
      resolvedSpec = validationResult.spec;
      runPipelineRef = { repo: pipelineRef.repo, ref: pipelineRef.ref, configPath: resolvedConfigPath };
    } else {
      return c.json(error('BAD_REQUEST', 'Either pipelineSpec or pipelineRef is required'), 400);
    }

    const input: CreateRunInput = {
      pipelineSpec: resolvedSpec,
      pipelineRef: runPipelineRef,
      trigger: { type: trigger.type as TriggerType, payload: trigger.payload },
    };

    const prepared = await prepareRun(input, secFn);
    const run = await acceptRun(runStore, queue, prepared);
    if (logs) {
      await logs.emitEvent({ timestamp: new Date().toISOString(), eventType: 'run.created', runId: run.id,
        status: run.status, metadata: { trigger: trigger.type } }).catch(() => console.error('CiFn run-created event delivery failed'));
    }

    return c.json(
      success({ runId: run.id, status: run.status, createdAt: run.createdAt }),
      201,
    );
  });

  api.get('/runs', async (c) => {
    const limitParam = c.req.query('limit');
    const cursor = c.req.query('cursor');
    const status = c.req.query('status') as RunStatus | undefined;

    let limit = 20;
    if (limitParam !== undefined) {
      limit = parseInt(limitParam, 10);
      if (isNaN(limit) || limit < 1) {
        return c.json(error('BAD_REQUEST', 'limit must be a positive integer'), 400);
      }
      if (limit > 100) {
        return c.json(error('BAD_REQUEST', 'limit must not exceed 100'), 400);
      }
    }

    if (status && !['queued', 'running', 'success', 'failure', 'cancelled'].includes(status)) {
      return c.json(error('BAD_REQUEST', `Invalid status filter: ${status}`), 400);
    }

    const result = await runStore.listRuns({ limit, cursor: cursor || undefined, status });
    return c.json(success({
      runs: result.runs.map(formatRun),
      nextCursor: result.nextCursor ?? null,
    }));
  });

  api.get('/runs/:runId/jobs/:jobKey/logs', async (c) => {
    const runId = c.req.param('runId');
    const jobKey = c.req.param('jobKey');
    const run = await runStore.getRun(runId);
    if (!run) {
      return c.json(error('RUN_NOT_FOUND', `Run ${runId} not found`), 404);
    }
    const job = run.jobs.find(j => j.jobKey === jobKey);
    if (!job) {
      return c.json(error('RUN_NOT_FOUND', `Job ${jobKey} not found in run ${runId}`), 404);
    }
    
    let entries: Array<{ line: string; timestamp: string; stepKey: string }> = [];
    if (logs) {
      entries = await logs.readJobLogs(runId, jobKey);
    } else if (logClient) {
      entries = logClient.getLines(runId, jobKey);
    }
    
    const secretValues = await runStore.getSecretValues(runId);
    
    const lines = entries.map(e => {
      let redactedLine = e.line;
      for (const secret of secretValues) {
        if (secret.length > 0) {
          redactedLine = redactedLine.split(secret).join('***');
        }
      }
      return { line: redactedLine, timestamp: e.timestamp, stepKey: e.stepKey };
    });
    return c.json(success({ lines }));
  });

  api.get('/runs/:runId/artifacts', async (c) => {
    const runId = c.req.param('runId');
    const run = await runStore.getRun(runId);
    if (!run) {
      return c.json(error('RUN_NOT_FOUND', `Run ${runId} not found`), 404);
    }
    const artifacts = await runStore.getArtifacts(runId);
    const projectedArtifacts = await Promise.all(artifacts.map(async (artifact) => {
      const signedUrl = artifact.url
        ?? (artifactAdapter?.getSignedUrl
          ? await artifactAdapter.getSignedUrl(artifact.fileId, 300)
          : undefined);
      return {
        name: artifact.name,
        fileId: artifact.fileId,
        ...(signedUrl ? { url: signedUrl } : {}),
      };
    }));
    return c.json(success({
      artifacts: projectedArtifacts,
    }));
  });

  api.get('/runs/:runId', async (c) => {
    const runId = c.req.param('runId');
    const run = await runStore.getRun(runId);
    if (!run) {
      return c.json(error('RUN_NOT_FOUND', `Run ${runId} not found`), 404);
    }
    return c.json(success(formatRun(run)));
  });

  api.post('/runs/:runId/cancel', async (c) => {
    const runId = c.req.param('runId');
    const result = await runStore.cancelRun(runId);
    if (result.error === 'NOT_FOUND') {
      return c.json(error('RUN_NOT_FOUND', `Run ${runId} not found`), 404);
    }
    if (result.error === 'ALREADY_FINISHED') {
      return c.json(error('RUN_ALREADY_FINISHED', `Run ${runId} has already finished`), 409);
    }
    return c.json(success({ runId: result.run!.id, status: result.run!.status }));
  });

  // Runner Registration
  api.post('/runners/register', async (c) => {
    let body: { token?: string; labels?: string[] };
    try {
      body = await readJsonBody(c.req.raw);
    } catch (cause) {
      if (cause instanceof PayloadTooLargeError) return c.json(error('PAYLOAD_TOO_LARGE', 'Request body too large'), 413);
      return c.json(error('BAD_REQUEST', 'Invalid or missing JSON body'), 400);
    }

    if (!body || !body.token) {
      return c.json(error('BAD_REQUEST', 'Missing registration token'), 400); // Or UNAUTHORIZED / RUNNER_TOKEN_INVALID
    }

    const result = await registerRunner(runStore, secFn, body.token, body.labels);
    if (!result.ok) {
      return c.json(error('RUNNER_TOKEN_INVALID', 'Invalid registration token'), 401);
    }

    return c.json(success({ runnerId: result.runnerId, runnerSecret: result.runnerSecret }));
  });

  // Runner Heartbeat
  api.post('/runners/heartbeat', async (c) => {
    let body: { runnerId?: string };
    try {
      body = await readJsonBody(c.req.raw);
    } catch (cause) {
      if (cause instanceof PayloadTooLargeError) return c.json(error('PAYLOAD_TOO_LARGE', 'Request body too large'), 413);
      return c.json(error('BAD_REQUEST', 'Invalid JSON'), 400);
    }
    const { runnerId } = body;
    if (!runnerId) {
      return c.json(error('BAD_REQUEST', 'Missing runnerId'), 400);
    }

    // Auth check: Bearer token must be the runner-scoped secret
    const authHeader = c.req.header('Authorization');
    let runnerSecret = '';
    if (authHeader && authHeader.startsWith('Bearer ')) {
      runnerSecret = authHeader.substring(7);
    }

    if (!runnerSecret) {
      return c.json(error('UNAUTHORIZED', 'Missing runner secret'), 401);
    }
    
    const runner = await runStore.getRunner(runnerId);
    if (!runner) {
      return c.json(error('RUNNER_NOT_FOUND', `Runner ${runnerId} not found`), 404);
    }

    if (!compareSecretHash(runnerSecret, runner.secretHash)) {
      return c.json(error('UNAUTHORIZED', 'Invalid runner secret'), 401);
    }

    await runStore.updateRunnerLastSeen(runnerId);

    const runnerLabels = runner.labels.length > 0 ? runner.labels : ['default'];
    // Bound duplicate draining per request. A later heartbeat continues draining.
    for (let attempt = 0; attempt < 100; attempt++) {
      const message = await queue.dequeueMatching(DEFAULT_QUEUE_NAME, candidate => runnerLabels.includes(candidate.jobSpec['runs-on']));
      if (!message) break;
      if (isDispatchStore(runStore)) {
        if (!message.dispatchId) continue; // Legacy records require explicit reconciliation.
        const job = await runStore.claimDispatch(message.runId, message.dispatchId, runnerId, runnerLabels);
        if (job) return c.json(success({ job }));
        continue;
      }
      await runStore.updateJobStatus(message.runId, message.jobKey, 'running', new Date().toISOString());
      return c.json(success({ job: message }));
    }

    return c.json(success({ job: null }), 200);
  });

  app.route('/api/v1', api);

  // Webhook
  app.post('/webhooks/github', async (c) => {
      // Determine secret
      let secret = options.webhookSecret;
      if (!secret) {
          const s = await secFn.getSecret('cifn.webhook.github');
          if (s) secret = s;
      }
      
      if (!secret) {
           return c.json(error('INTERNAL_ERROR', 'Webhook secret not configured'), 500);
      }

      let rawBody: string;
      try {
        rawBody = await readBodyText(c.req.raw);
      } catch (cause) {
        if (cause instanceof PayloadTooLargeError) return c.json(error('PAYLOAD_TOO_LARGE', 'Request body too large'), 413);
        throw cause;
      }
      const signature = c.req.header('X-Hub-Signature-256') ?? '';
      const eventType = c.req.header('X-GitHub-Event') ?? '';
      const result = await handleWebhook(rawBody, signature, eventType, {
        store: runStore,
        queue,
        webhookSecret: secret,
        pipelineResolver: options.pipelineResolver,
        secFn,
      });
      return c.json(result.body, result.status as any);
  });

  return { app, store: runStore, queue, dispatchPublisher: isDispatchStore(runStore) ? new DispatchPublisher(runStore, queue) : undefined };
}

function formatRun(run: {
  id: string;
  pipelineRef: { repo: string; ref: string; configPath?: string };
  trigger: { type: TriggerType; payload?: Record<string, unknown> };
  status: RunStatus;
  createdAt: string;
  updatedAt: string;
  jobs: Array<{
    id: string;
    runId: string;
    jobKey: string;
    status: string;
    steps: Array<{ id: string; jobId: string; stepKey: string; status: string }>;
    startedAt?: string;
    completedAt?: string;
  }>;
}) {
  return {
    runId: run.id,
    pipelineRef: run.pipelineRef,
    trigger: run.trigger,
    status: run.status,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    jobs: run.jobs.map(j => ({
      id: j.id,
      jobKey: j.jobKey,
      status: j.status,
      steps: j.steps.map(s => ({
        id: s.id,
        stepKey: s.stepKey,
        status: s.status,
      })),
      startedAt: j.startedAt,
      completedAt: j.completedAt,
    })),
  };
}

import { describe, it, expect, beforeEach } from 'vitest';
import { signWebhookPayload } from '@superfunctions/webhooks';
import { verifySignature, handleWebhook, parseGitHubEvent } from './webhook.js';
import { CronScheduler } from './cron.js';
import { MemoryStore } from '../store/memory-store.js';
import { MemoryQueueClient, DEFAULT_QUEUE_NAME } from '../queue/flowfn-client.js';
import { MemorySecFnClient } from '../secrets/secfn-client.js';
import type { PipelineSpec } from '../pipeline/types.js';
import type { PipelineRef } from '../pipeline/resolver.js';

const SECRET = 'test-webhook-secret';
const API_KEY = 'test-key';

const validPipeline: PipelineSpec = {
  name: 'ci',
  on: { push: { branches: ['main'] } },
  jobs: {
    build: { 'runs-on': 'default', steps: [{ run: 'echo build' }] },
  },
};

/** Produces a pipeline doc string from a spec for use with pipelineRef resolver. */
function pipelineSpecToDoc(spec: PipelineSpec): string {
  return JSON.stringify(spec);
}

/** Resolver that returns the given spec as doc for any ref (for tests). */
function mockPipelineResolver(spec: PipelineSpec) {
  return async (_ref: PipelineRef) => ({
    doc: pipelineSpecToDoc(spec),
    resolvedConfigPath: '.ci/pipeline.yml',
  });
}

function sign(payload: string, secret: string): string {
  return signWebhookPayload(payload, secret, { algorithm: 'sha256', encoding: 'hex', prefix: 'sha256=' });
}

function makePayload(repo: string, ref: string): string {
  return JSON.stringify({
    repository: { clone_url: `https://github.com/${repo}.git`, full_name: repo },
    ref: `refs/heads/${ref}`,
  });
}

function authHeaders() {
  return { 'Content-Type': 'application/json', 'Authorization': `Bearer ${API_KEY}` };
}

describe('verifySignature', () => {
  it('returns true for valid signature', () => {
    const payload = '{"test": true}';
    const sig = sign(payload, SECRET);
    expect(verifySignature(payload, sig, SECRET)).toBe(true);
  });

  it('returns false for invalid signature', () => {
    const payload = '{"test": true}';
    expect(verifySignature(payload, 'sha256=invalid', SECRET)).toBe(false);
  });

  it('returns false for missing signature', () => {
    expect(verifySignature('body', '', SECRET)).toBe(false);
  });

  it('returns false for non-sha256 prefix', () => {
    expect(verifySignature('body', 'sha1=abc', SECRET)).toBe(false);
  });
});

describe('parseGitHubEvent', () => {
  it('maps push to push trigger type', () => {
    expect(parseGitHubEvent('push')).toBe('push');
  });

  it('maps pull_request to pull_request trigger type', () => {
    expect(parseGitHubEvent('pull_request')).toBe('pull_request');
  });

  it('returns null for unknown event', () => {
    expect(parseGitHubEvent('issues')).toBeNull();
  });
});

describe('handleWebhook', () => {
  let store: MemoryStore;
  let queue: MemoryQueueClient;

  beforeEach(() => {
    store = new MemoryStore();
    queue = new MemoryQueueClient();
  });

  it('TV-SEC-004: returns 401 for invalid signature', async () => {
    const payload = makePayload('org/repo', 'main');
    const result = await handleWebhook(payload, 'sha256=bad', 'push', {
      store, queue, webhookSecret: SECRET,
    });
    expect(result.status).toBe(401);
    expect((result.body as any).ok).toBe(false);
    expect(store.listRuns().runs).toHaveLength(0);
  });

  it('TV-SEC-004: returns 401 for missing signature', async () => {
    const payload = makePayload('org/repo', 'main');
    const result = await handleWebhook(payload, '', 'push', {
      store, queue, webhookSecret: SECRET,
    });
    expect(result.status).toBe(401);
    expect(store.listRuns().runs).toHaveLength(0);
  });

  it('TV-INT-005 / TV-SEC-005: valid signature creates run via pipelineRef', async () => {
    const payload = makePayload('org/repo', 'main');
    const sig = sign(payload, SECRET);
    const result = await handleWebhook(payload, sig, 'push', {
      store, queue, webhookSecret: SECRET,
      pipelineResolver: mockPipelineResolver(validPipeline),
    });
    expect(result.status).toBe(201);
    expect((result.body as any).ok).toBe(true);
    expect((result.body as any).data.runId).toBeDefined();
    expect(store.listRuns().runs).toHaveLength(1);
    const run = store.listRuns().runs[0];
    expect(run.pipelineRef.repo).toBeDefined();
    expect(run.pipelineRef.ref).toBe('main');
    expect(run.pipelineRef.configPath).toBe('.ci/pipeline.yml');
  });

  it('valid push webhook enqueues root jobs', async () => {
    const payload = makePayload('org/repo', 'main');
    const sig = sign(payload, SECRET);
    await handleWebhook(payload, sig, 'push', {
      store, queue, webhookSecret: SECRET,
      pipelineResolver: mockPipelineResolver(validPipeline),
    });
    expect(queue.size(DEFAULT_QUEUE_NAME)).toBe(1);
    const queued = queue.peek(DEFAULT_QUEUE_NAME);
    expect(queued[0].jobKey).toBe('build');
  });

  it('pull_request event creates run with correct trigger', async () => {
    const payload = makePayload('org/repo', 'feature');
    const sig = sign(payload, SECRET);
    const result = await handleWebhook(payload, sig, 'pull_request', {
      store, queue, webhookSecret: SECRET,
      pipelineResolver: mockPipelineResolver(validPipeline),
    });
    expect(result.status).toBe(201);
    const run = store.listRuns().runs[0];
    expect(run.trigger.type).toBe('pull_request');
  });

  it('returns 400 for unsupported event type', async () => {
    const payload = makePayload('org/repo', 'main');
    const sig = sign(payload, SECRET);
    const result = await handleWebhook(payload, sig, 'issues', {
      store, queue, webhookSecret: SECRET,
    });
    expect(result.status).toBe(400);
  });

  it('returns 422 when pipeline resolver not configured', async () => {
    const payload = makePayload('org/repo', 'main');
    const sig = sign(payload, SECRET);
    const result = await handleWebhook(payload, sig, 'push', {
      store, queue, webhookSecret: SECRET,
    });
    expect(result.status).toBe(422);
  });

  it('returns 422 when pipeline resolver throws (e.g. config not found)', async () => {
    const payload = makePayload('org/repo', 'main');
    const sig = sign(payload, SECRET);
    const { ResolverError } = await import('../pipeline/resolver.js');
    const result = await handleWebhook(payload, sig, 'push', {
      store, queue, webhookSecret: SECRET,
      pipelineResolver: async () => { throw new ResolverError('Config path not found'); },
    });
    expect(result.status).toBe(422);
    expect((result.body as any).error.code).toBe('RUN_CREATE_FAILED');
  });
});

describe('handleWebhook via routes', () => {
  it('POST /webhooks/github with valid signature creates run via pipelineRef (TV-INT-005)', async () => {
    const store = new MemoryStore();
    const queue = new MemoryQueueClient();
    const { createApp } = await import('../api/routes.js');
    const { app } = createApp({
      store, queue,
      webhookSecret: SECRET,
      pipelineResolver: mockPipelineResolver(validPipeline),
    });

    const payload = makePayload('org/repo', 'main');
    const sig = sign(payload, SECRET);

    const res = await app.request('http://localhost/webhooks/github', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Hub-Signature-256': sig,
        'X-GitHub-Event': 'push',
      },
      body: payload,
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.runId).toBeDefined();
  });

  it('POST /webhooks/github with invalid signature returns 401', async () => {
    const store = new MemoryStore();
    const queue = new MemoryQueueClient();
    const { createApp } = await import('../api/routes.js');
    const { app } = createApp({
      store, queue,
      webhookSecret: SECRET,
    });

    const payload = makePayload('org/repo', 'main');

    const res = await app.request('http://localhost/webhooks/github', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Hub-Signature-256': 'sha256=badbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadb',
        'X-GitHub-Event': 'push',
      },
      body: payload,
    });

    expect(res.status).toBe(401);
    expect(store.listRuns().runs).toHaveLength(0);
  });
});

describe('CronScheduler', () => {
  it('triggerPipeline creates a run with schedule trigger', async () => {
    const store = new MemoryStore();
    const queue = new MemoryQueueClient();
    const scheduler = new CronScheduler({ store, queue });

    const pipeline = {
      id: 'cron-1',
      spec: validPipeline,
      pipelineRef: { repo: 'org/repo', ref: 'main' },
      cronExpression: '0 * * * *',
    };

    const runId = await scheduler.triggerPipeline(pipeline);
    expect(runId).toBeDefined();

    const run = store.getRun(runId)!;
    expect(run.trigger.type).toBe('schedule');
    expect((run.trigger.payload as any).cron).toBe('0 * * * *');
    expect(run.status).toBe('queued');

    expect(queue.size(DEFAULT_QUEUE_NAME)).toBe(1);
  });

  it('register and getRegisteredPipelines', () => {
    const store = new MemoryStore();
    const queue = new MemoryQueueClient();
    const scheduler = new CronScheduler({ store, queue });

    const pipeline = {
      id: 'cron-1',
      spec: validPipeline,
      pipelineRef: { repo: 'org/repo', ref: 'main' },
      cronExpression: '0 * * * *',
    };

    scheduler.register(pipeline);
    expect(scheduler.getRegisteredPipelines()).toHaveLength(1);
    expect(scheduler.getRegisteredPipelines()[0].id).toBe('cron-1');
  });
});

describe('TV-PIPE-007: All trigger types', () => {
  it('workflow_dispatch via API already works (POST /runs)', async () => {
    const store = new MemoryStore();
    const queue = new MemoryQueueClient();
    const { createApp } = await import('../api/routes.js');
    
    // Inject secFn
    const secFn = new MemorySecFnClient();
    await secFn.setSecret('CIFN_API_KEYS', API_KEY);
    
    const { app } = createApp({ store, queue, secFn });

    const res = await app.request('http://localhost/api/v1/runs', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        trigger: { type: 'workflow_dispatch' },
        pipelineSpec: validPipeline,
      }),
    });
    expect(res.status).toBe(201);
  });

  it('push via webhook creates run', async () => {
    const store = new MemoryStore();
    const queue = new MemoryQueueClient();
    const payload = makePayload('org/repo', 'main');
    const sig = sign(payload, SECRET);
    const result = await handleWebhook(payload, sig, 'push', {
      store, queue, webhookSecret: SECRET,
      pipelineResolver: mockPipelineResolver(validPipeline),
    });
    expect(result.status).toBe(201);
    expect(store.listRuns().runs[0].trigger.type).toBe('push');
  });

  it('pull_request via webhook creates run', async () => {
    const store = new MemoryStore();
    const queue = new MemoryQueueClient();
    const payload = makePayload('org/repo', 'feature');
    const sig = sign(payload, SECRET);
    const result = await handleWebhook(payload, sig, 'pull_request', {
      store, queue, webhookSecret: SECRET,
      pipelineResolver: mockPipelineResolver(validPipeline),
    });
    expect(result.status).toBe(201);
    expect(store.listRuns().runs[0].trigger.type).toBe('pull_request');
  });

  it('schedule via cron scheduler creates run', async () => {
    const store = new MemoryStore();
    const queue = new MemoryQueueClient();
    const scheduler = new CronScheduler({ store, queue });
    const runId = await scheduler.triggerPipeline({
      id: 'cron-1', spec: validPipeline,
      pipelineRef: { repo: 'org/repo', ref: 'main' },
      cronExpression: '0 0 * * *',
    });
    expect(store.getRun(runId)!.trigger.type).toBe('schedule');
  });
});

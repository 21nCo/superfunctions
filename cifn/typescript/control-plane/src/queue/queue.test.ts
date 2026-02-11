import { describe, it, expect, beforeEach } from 'vitest';
import { createApp } from '../api/routes.js';
import { MemoryQueueClient, DEFAULT_QUEUE_NAME } from './flowfn-client.js';
import { MemoryStore } from '../store/memory-store.js';
import { MemorySecFnClient } from '../secrets/secfn-client.js';
import { resolveDAG, getReadyJobs } from '../pipeline/dag.js';
import type { PipelineSpec } from '../pipeline/types.js';

const twoJobPipeline: PipelineSpec = {
  name: 'dag-test',
  on: { workflow_dispatch: {} },
  jobs: {
    build: { 'runs-on': 'default', steps: [{ run: 'echo build' }] },
    test: { 'runs-on': 'default', needs: ['build'], steps: [{ run: 'echo test' }] },
  },
};

const threeJobDiamondPipeline: PipelineSpec = {
  name: 'diamond',
  on: { workflow_dispatch: {} },
  jobs: {
    lint: { 'runs-on': 'default', steps: [{ run: 'echo lint' }] },
    build: { 'runs-on': 'default', steps: [{ run: 'echo build' }] },
    deploy: { 'runs-on': 'default', needs: ['lint', 'build'], steps: [{ run: 'echo deploy' }] },
  },
};

const singleJobPipeline: PipelineSpec = {
  name: 'single',
  on: { workflow_dispatch: {} },
  jobs: {
    build: { 'runs-on': 'default', steps: [{ run: 'echo build' }] },
  },
};

const API_KEY = 'test-key';

async function createAuthApp(store: MemoryStore, queue: MemoryQueueClient) {
  const secFn = new MemorySecFnClient();
  await secFn.setSecret('CIFN_API_KEYS', API_KEY);
  return createApp({ store, queue, secFn });
}

function authHeaders() {
  return { 'Content-Type': 'application/json', 'Authorization': `Bearer ${API_KEY}` };
}

describe('DAG resolution', () => {
  it('identifies root jobs (no needs)', () => {
    const dag = resolveDAG(twoJobPipeline);
    expect(dag.rootJobs).toEqual(['build']);
  });

  it('returns topological order', () => {
    const dag = resolveDAG(twoJobPipeline);
    const buildIdx = dag.order.indexOf('build');
    const testIdx = dag.order.indexOf('test');
    expect(buildIdx).toBeLessThan(testIdx);
  });

  it('identifies dependents', () => {
    const dag = resolveDAG(twoJobPipeline);
    expect(dag.dependents.get('build')).toContain('test');
  });

  it('diamond: two root jobs', () => {
    const dag = resolveDAG(threeJobDiamondPipeline);
    expect(dag.rootJobs.sort()).toEqual(['build', 'lint']);
  });

  it('diamond: deploy comes after lint and build in order', () => {
    const dag = resolveDAG(threeJobDiamondPipeline);
    const deployIdx = dag.order.indexOf('deploy');
    const lintIdx = dag.order.indexOf('lint');
    const buildIdx = dag.order.indexOf('build');
    expect(deployIdx).toBeGreaterThan(lintIdx);
    expect(deployIdx).toBeGreaterThan(buildIdx);
  });

  it('single job: root is the only job', () => {
    const dag = resolveDAG(singleJobPipeline);
    expect(dag.rootJobs).toEqual(['build']);
    expect(dag.order).toEqual(['build']);
  });
});

describe('getReadyJobs', () => {
  it('returns root jobs when nothing completed', () => {
    const ready = getReadyJobs(twoJobPipeline, new Set(), new Set());
    expect(ready).toEqual(['build']);
  });

  it('returns dependent job after dependency completes', () => {
    const ready = getReadyJobs(twoJobPipeline, new Set(['build']), new Set());
    expect(ready).toEqual(['test']);
  });

  it('does not return already-enqueued jobs', () => {
    const ready = getReadyJobs(twoJobPipeline, new Set(), new Set(['build']));
    expect(ready).toEqual([]);
  });

  it('diamond: deploy ready only when both deps complete', () => {
    expect(getReadyJobs(threeJobDiamondPipeline, new Set(['lint']), new Set())).not.toContain('deploy');
    expect(getReadyJobs(threeJobDiamondPipeline, new Set(['build']), new Set())).not.toContain('deploy');
    expect(getReadyJobs(threeJobDiamondPipeline, new Set(['lint', 'build']), new Set())).toContain('deploy');
  });
});

describe('MemoryQueueClient', () => {
  let queue: MemoryQueueClient;

  beforeEach(() => {
    queue = new MemoryQueueClient();
  });

  it('enqueue and dequeue', async () => {
    const payload = { runId: 'r1', jobKey: 'build', jobSpec: twoJobPipeline.jobs.build };
    await queue.enqueue('test-q', payload);
    expect(queue.size('test-q')).toBe(1);
    const item = await queue.dequeue('test-q');
    expect(item).toEqual(payload);
    expect(queue.size('test-q')).toBe(0);
  });

  it('dequeue returns null on empty queue', async () => {
    expect(await queue.dequeue('empty')).toBeNull();
  });

  it('FIFO order', async () => {
    await queue.enqueue('q', { runId: 'r1', jobKey: 'a', jobSpec: singleJobPipeline.jobs.build });
    await queue.enqueue('q', { runId: 'r1', jobKey: 'b', jobSpec: singleJobPipeline.jobs.build });
    const first = await queue.dequeue('q');
    const second = await queue.dequeue('q');
    expect(first!.jobKey).toBe('a');
    expect(second!.jobKey).toBe('b');
  });

  it('peek does not remove items', async () => {
    await queue.enqueue('q', { runId: 'r1', jobKey: 'a', jobSpec: singleJobPipeline.jobs.build });
    expect(queue.peek('q')).toHaveLength(1);
    expect(queue.size('q')).toBe(1);
  });

  it('dequeueMatching returns first payload that matches runs-on label', async () => {
    await queue.enqueue('q', { runId: 'r1', jobKey: 'default-job', jobSpec: singleJobPipeline.jobs.build });
    await queue.enqueue('q', {
      runId: 'r1',
      jobKey: 'hostfn-job',
      jobSpec: { ...singleJobPipeline.jobs.build, 'runs-on': 'hostfn-runner' },
    });

    const matched = await queue.dequeueMatching('q', payload => payload.jobSpec['runs-on'] === 'hostfn-runner');

    expect(matched?.jobKey).toBe('hostfn-job');
    expect(queue.size('q')).toBe(1);
    expect(queue.peek('q')[0].jobKey).toBe('default-job');
  });
});

describe('TV-INT-001: Run creation enqueues root jobs', () => {
  it('two-job pipeline: only root job (build) is enqueued', async () => {
    const queue = new MemoryQueueClient();
    const store = new MemoryStore();
    const { app } = await createAuthApp(store, queue);

    const res = await app.request('http://localhost/api/v1/runs', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        trigger: { type: 'workflow_dispatch' },
        pipelineSpec: twoJobPipeline,
      }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    const runId = body.data.runId;

    expect(queue.size(DEFAULT_QUEUE_NAME)).toBe(1);

    const queued = queue.peek(DEFAULT_QUEUE_NAME);
    expect(queued[0].runId).toBe(runId);
    expect(queued[0].jobKey).toBe('build');
    expect(queued[0].jobSpec).toEqual(twoJobPipeline.jobs.build);
  });

  it('diamond pipeline: two root jobs (lint, build) are enqueued', async () => {
    const queue = new MemoryQueueClient();
    const store = new MemoryStore();
    const { app } = await createAuthApp(store, queue);

    const res = await app.request('http://localhost/api/v1/runs', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        trigger: { type: 'workflow_dispatch' },
        pipelineSpec: threeJobDiamondPipeline,
      }),
    });

    expect(res.status).toBe(201);

    expect(queue.size(DEFAULT_QUEUE_NAME)).toBe(2);
    const queued = queue.peek(DEFAULT_QUEUE_NAME);
    const keys = queued.map(q => q.jobKey).sort();
    expect(keys).toEqual(['build', 'lint']);
  });

  it('single job pipeline: the only job is enqueued', async () => {
    const queue = new MemoryQueueClient();
    const store = new MemoryStore();
    const { app } = await createAuthApp(store, queue);

    await app.request('http://localhost/api/v1/runs', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        trigger: { type: 'workflow_dispatch' },
        pipelineSpec: singleJobPipeline,
      }),
    });

    expect(queue.size(DEFAULT_QUEUE_NAME)).toBe(1);
    const queued = queue.peek(DEFAULT_QUEUE_NAME);
    expect(queued[0].jobKey).toBe('build');
  });

  it('GET /runs/:runId shows jobs after run creation', async () => {
    const queue = new MemoryQueueClient();
    const store = new MemoryStore();
    const { app } = await createAuthApp(store, queue);

    const createRes = await app.request('http://localhost/api/v1/runs', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        trigger: { type: 'workflow_dispatch' },
        pipelineSpec: twoJobPipeline,
      }),
    });
    const runId = (await createRes.json()).data.runId;

    const getRes = await app.request(`http://localhost/api/v1/runs/${runId}`, { headers: authHeaders() });
    const body = await getRes.json();
    expect(body.ok).toBe(true);
    expect(body.data.jobs).toHaveLength(2);
    const jobKeys = body.data.jobs.map((j: any) => j.jobKey).sort();
    expect(jobKeys).toEqual(['build', 'test']);
    body.data.jobs.forEach((j: any) => expect(j.status).toBe('pending'));
  });

  it('dependent job (test) is NOT in the queue', async () => {
    const queue = new MemoryQueueClient();
    const store = new MemoryStore();
    const { app } = await createAuthApp(store, queue);

    await app.request('http://localhost/api/v1/runs', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        trigger: { type: 'workflow_dispatch' },
        pipelineSpec: twoJobPipeline,
      }),
    });

    const queued = queue.peek(DEFAULT_QUEUE_NAME);
    const queuedKeys = queued.map(q => q.jobKey);
    expect(queuedKeys).not.toContain('test');
  });
});

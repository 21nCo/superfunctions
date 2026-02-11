import { describe, it, expect, beforeEach } from 'vitest';
import {
  MemoryStore,
  MemoryQueueClient,
  MemorySecFnClient,
  MemoryFileFnClient,
  DEFAULT_QUEUE_NAME,
  createApp,
  type PipelineSpec,
} from 'cifn';
import { Runner } from './runner.js';
import { MemoryLogFnClient } from './reporting/logfn-client.js';
import { DockerExecutor } from './docker-executor.js';
import { executeRunStep } from './executor/run-step.js';
import { executeCheckout } from './steps/checkout.js';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const singleJobPipeline: PipelineSpec = {
  name: 'single',
  on: { workflow_dispatch: {} },
  jobs: {
    build: {
      'runs-on': 'default',
      steps: [{ run: 'echo hello' }, { run: 'echo world' }],
    },
  },
};

const twoJobPipeline: PipelineSpec = {
  name: 'dag-test',
  on: { workflow_dispatch: {} },
  jobs: {
    build: { 'runs-on': 'default', steps: [{ run: 'echo build' }] },
    test: { 'runs-on': 'default', needs: ['build'], steps: [{ run: 'echo test' }] },
  },
};

const failingPipeline: PipelineSpec = {
  name: 'fail',
  on: { workflow_dispatch: {} },
  jobs: {
    build: {
      'runs-on': 'default',
      steps: [
        { run: 'echo before' },
        { run: 'exit 1' },
        { run: 'echo after' },
      ],
    },
  },
};

const TEST_API_KEY = 'runner-test-key';

async function createAuthApp(
  options: { store: MemoryStore; queue: MemoryQueueClient; logClient?: MemoryLogFnClient }
) {
  const secFn = new MemorySecFnClient();
  await secFn.setSecret('CIFN_API_KEYS', TEST_API_KEY);
  return createApp({ ...options, secFn });
}

function authHeaders() {
  return {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${TEST_API_KEY}`,
  };
}

describe('executeRunStep', () => {
  let workspace: string;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), 'cifn-test-'));
  });

  it('executes shell command and captures stdout', () => {
    const result = executeRunStep('echo hello', workspace);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('hello');
    expect(result.lines).toContain('hello');
  });

  it('returns non-zero exit code for failing command', () => {
    const result = executeRunStep('exit 1', workspace);
    expect(result.exitCode).toBe(1);
  });

  it('captures stderr for failing command', () => {
    const result = executeRunStep('echo err >&2 && exit 1', workspace);
    expect(result.exitCode).toBe(1);
    expect(result.lines).toContain('err');
  });

  it('runs in specified workspace directory', () => {
    const result = executeRunStep('pwd', workspace);
    expect(result.exitCode).toBe(0);
    const { realpathSync } = require('node:fs');
    expect(result.stdout.trim()).toBe(realpathSync(workspace));
  });
});

describe('MemoryLogFnClient', () => {
  it('stores and retrieves log entries by runId and jobKey', () => {
    const logClient = new MemoryLogFnClient();
    logClient.appendLines('r1', 'build', 'step-0', ['line1', 'line2']);
    logClient.appendLines('r1', 'test', 'step-0', ['line3']);
    logClient.appendLines('r2', 'build', 'step-0', ['line4']);

    const r1Build = logClient.getLines('r1', 'build');
    expect(r1Build).toHaveLength(2);
    expect(r1Build[0].line).toBe('line1');
    expect(r1Build[1].line).toBe('line2');

    const r1Test = logClient.getLines('r1', 'test');
    expect(r1Test).toHaveLength(1);

    const r1All = logClient.getAllLines('r1');
    expect(r1All).toHaveLength(3);
  });
});

describe('Runner - single job with run steps', () => {
  let store: MemoryStore;
  let queue: MemoryQueueClient;
  let logClient: MemoryLogFnClient;
  let runner: Runner;

  beforeEach(() => {
    store = new MemoryStore();
    queue = new MemoryQueueClient();
    logClient = new MemoryLogFnClient();
    runner = new Runner({ store, queue, logClient });
  });

  it('end-to-end: runs one job with two run steps (echo hello, echo world)', async () => {
    const run = store.createRun({
      pipelineSpec: singleJobPipeline,
      trigger: { type: 'workflow_dispatch' },
    });

    runner.registerPipelineSpec(run.id, singleJobPipeline);

    await queue.enqueue(DEFAULT_QUEUE_NAME, {
      runId: run.id,
      jobKey: 'build',
      jobSpec: singleJobPipeline.jobs.build,
    });

    const processed = await runner.processAllJobs();
    expect(processed).toBe(1);

    const updatedRun = store.getRun(run.id)!;
    expect(updatedRun.status).toBe('success');

    const job = updatedRun.jobs.find(j => j.jobKey === 'build')!;
    expect(job.status).toBe('success');
    expect(job.startedAt).toBeDefined();
    expect(job.completedAt).toBeDefined();

    expect(job.steps[0].status).toBe('success');
    expect(job.steps[1].status).toBe('success');

    const logs = logClient.getLines(run.id, 'build');
    const logLines = logs.map(l => l.line);
    expect(logLines.some(l => l.includes('hello'))).toBe(true);
    expect(logLines.some(l => l.includes('world'))).toBe(true);
  });

  it('TV-OBS-001: events logged (job started, step started/completed, job completed)', async () => {
    const run = store.createRun({
      pipelineSpec: singleJobPipeline,
      trigger: { type: 'workflow_dispatch' },
    });

    runner.registerPipelineSpec(run.id, singleJobPipeline);

    await queue.enqueue(DEFAULT_QUEUE_NAME, {
      runId: run.id,
      jobKey: 'build',
      jobSpec: singleJobPipeline.jobs.build,
    });

    await runner.processAllJobs();

    const logs = logClient.getLines(run.id, 'build');
    const logLines = logs.map(l => l.line);
    expect(logLines.some(l => l.includes('Job "build" started'))).toBe(true);
    expect(logLines.some(l => l.includes('step-0') && l.includes('started'))).toBe(true);
    expect(logLines.some(l => l.includes('step-0') && l.includes('completed successfully'))).toBe(true);
    expect(logLines.some(l => l.includes('step-1') && l.includes('started'))).toBe(true);
    expect(logLines.some(l => l.includes('step-1') && l.includes('completed successfully'))).toBe(true);
    expect(logLines.some(l => l.includes('Job "build" completed successfully'))).toBe(true);
  });

  it('RUNNER-003: runner only executes steps from job payload', async () => {
    const run = store.createRun({
      pipelineSpec: singleJobPipeline,
      trigger: { type: 'workflow_dispatch' },
    });

    runner.registerPipelineSpec(run.id, singleJobPipeline);

    await queue.enqueue(DEFAULT_QUEUE_NAME, {
      runId: run.id,
      jobKey: 'build',
      jobSpec: singleJobPipeline.jobs.build,
    });

    await runner.processAllJobs();

    const job = store.getRun(run.id)!.jobs.find(j => j.jobKey === 'build')!;
    expect(job.steps).toHaveLength(2);
    job.steps.forEach(s => {
      expect(['success', 'failure', 'skipped']).toContain(s.status);
    });
  });
});

describe('Runner - step failure', () => {
  let store: MemoryStore;
  let queue: MemoryQueueClient;
  let logClient: MemoryLogFnClient;
  let runner: Runner;

  beforeEach(() => {
    store = new MemoryStore();
    queue = new MemoryQueueClient();
    logClient = new MemoryLogFnClient();
    runner = new Runner({ store, queue, logClient });
  });

  it('marks job as failed on step failure and skips remaining steps', async () => {
    const run = store.createRun({
      pipelineSpec: failingPipeline,
      trigger: { type: 'workflow_dispatch' },
    });

    runner.registerPipelineSpec(run.id, failingPipeline);

    await queue.enqueue(DEFAULT_QUEUE_NAME, {
      runId: run.id,
      jobKey: 'build',
      jobSpec: failingPipeline.jobs.build,
    });

    await runner.processAllJobs();

    const updatedRun = store.getRun(run.id)!;
    expect(updatedRun.status).toBe('failure');

    const job = updatedRun.jobs.find(j => j.jobKey === 'build')!;
    expect(job.status).toBe('failure');

    expect(job.steps[0].status).toBe('success');
    expect(job.steps[1].status).toBe('failure');
    expect(job.steps[2].status).toBe('skipped');
  });

  it('TV-EXPR-001: failure() step runs after failure; default step skipped', async () => {
    const fileFn = new MemoryFileFnClient();
    const storeWithArtifacts = new MemoryStore();
    const queueExpr = new MemoryQueueClient();
    const logClientExpr = new MemoryLogFnClient();
    const runnerExpr = new Runner({
      store: storeWithArtifacts,
      queue: queueExpr,
      logClient: logClientExpr,
      fileFnClient: fileFn,
      artifactStore: { addArtifact: (runId, a) => storeWithArtifacts.addArtifact(runId, a) },
    });

    const pipeline: PipelineSpec = {
      name: 'if',
      on: { workflow_dispatch: {} },
      jobs: {
        build: {
          'runs-on': 'default',
          steps: [
            { run: 'node -e "process.exit(1)"' },
            {
              uses: 'artifact/upload',
              if: 'failure()',
              with: { name: 'fail-info', path: './' },
            },
            { run: 'echo should-skip-by-default' },
          ],
        },
      },
    };

    const run = storeWithArtifacts.createRun({
      pipelineSpec: pipeline,
      trigger: { type: 'workflow_dispatch', payload: { github: { ref: 'refs/heads/main' } } },
    });

    runnerExpr.registerPipelineSpec(run.id, pipeline);

    await queueExpr.enqueue(DEFAULT_QUEUE_NAME, {
      runId: run.id,
      jobKey: 'build',
      jobSpec: pipeline.jobs.build,
      pipelineRef: { repo: 'https://github.com/org/repo', ref: 'main' },
    });

    await runnerExpr.processAllJobs();

    const updatedRun = storeWithArtifacts.getRun(run.id)!;
    expect(updatedRun.status).toBe('failure');

    const job = updatedRun.jobs.find(j => j.jobKey === 'build')!;
    expect(job.status).toBe('failure');
    expect(job.steps[0].status).toBe('failure');
    expect(job.steps[1].status).toBe('success');
    expect(job.steps[2].status).toBe('skipped');
  });
});

describe('TV-EXPR-002: Job if false => skipped and satisfies needs', () => {
  it('job with if false is skipped; dependent job still runs', async () => {
    const store = new MemoryStore();
    const queue = new MemoryQueueClient();
    const logClient = new MemoryLogFnClient();
    const runner = new Runner({ store, queue, logClient });

    const pipeline: PipelineSpec = {
      name: 'job-if',
      on: { workflow_dispatch: {} },
      jobs: {
        a: {
          'runs-on': 'default',
          if: "github.ref == 'refs/heads/nope'",
          steps: [{ run: 'echo a' }],
        },
        b: {
          'runs-on': 'default',
          needs: ['a'],
          steps: [{ run: 'echo b' }],
        },
      },
    };

    const run = store.createRun({
      pipelineSpec: pipeline,
      trigger: { type: 'workflow_dispatch', payload: { github: { ref: 'refs/heads/main' } } },
    });

    runner.registerPipelineSpec(run.id, pipeline);

    await queue.enqueue(DEFAULT_QUEUE_NAME, {
      runId: run.id,
      jobKey: 'a',
      jobSpec: pipeline.jobs.a,
      pipelineRef: { repo: 'https://github.com/org/repo', ref: 'main' },
    });

    const processed = await runner.processAllJobs();

    const updatedRun = store.getRun(run.id)!;
    const jobA = updatedRun.jobs.find(j => j.jobKey === 'a')!;
    const jobB = updatedRun.jobs.find(j => j.jobKey === 'b')!;

    expect(jobA.status).toBe('skipped');
    expect(jobB.status).toBe('success');
    expect(processed).toBe(2);
  });
});

describe('Runner - DAG: job order respects needs (TV-RUN-002)', () => {
  let store: MemoryStore;
  let queue: MemoryQueueClient;
  let logClient: MemoryLogFnClient;
  let runner: Runner;

  beforeEach(() => {
    store = new MemoryStore();
    queue = new MemoryQueueClient();
    logClient = new MemoryLogFnClient();
    runner = new Runner({ store, queue, logClient });
  });

  it('build runs first, then test (dependent job enqueued after build completes)', async () => {
    const run = store.createRun({
      pipelineSpec: twoJobPipeline,
      trigger: { type: 'workflow_dispatch' },
    });

    runner.registerPipelineSpec(run.id, twoJobPipeline);

    await queue.enqueue(DEFAULT_QUEUE_NAME, {
      runId: run.id,
      jobKey: 'build',
      jobSpec: twoJobPipeline.jobs.build,
    });

    const first = await runner.processNextJob();
    expect(first).toBe(true);

    const afterBuild = store.getRun(run.id)!;
    const buildJob = afterBuild.jobs.find(j => j.jobKey === 'build')!;
    expect(buildJob.status).toBe('success');

    expect(queue.size(DEFAULT_QUEUE_NAME)).toBe(1);
    const nextPayload = queue.peek(DEFAULT_QUEUE_NAME);
    expect(nextPayload[0].jobKey).toBe('test');

    const second = await runner.processNextJob();
    expect(second).toBe(true);

    const finalRun = store.getRun(run.id)!;
    expect(finalRun.status).toBe('success');
    const testJob = finalRun.jobs.find(j => j.jobKey === 'test')!;
    expect(testJob.status).toBe('success');
  });

  it('dependent job not enqueued when build fails', async () => {
    const failBuildPipeline: PipelineSpec = {
      name: 'fail-build',
      on: { workflow_dispatch: {} },
      jobs: {
        build: { 'runs-on': 'default', steps: [{ run: 'exit 1' }] },
        test: { 'runs-on': 'default', needs: ['build'], steps: [{ run: 'echo test' }] },
      },
    };

    const run = store.createRun({
      pipelineSpec: failBuildPipeline,
      trigger: { type: 'workflow_dispatch' },
    });

    runner.registerPipelineSpec(run.id, failBuildPipeline);

    await queue.enqueue(DEFAULT_QUEUE_NAME, {
      runId: run.id,
      jobKey: 'build',
      jobSpec: failBuildPipeline.jobs.build,
    });

    await runner.processAllJobs();

    const updatedRun = store.getRun(run.id)!;
    expect(updatedRun.status).toBe('failure');

    expect(queue.size(DEFAULT_QUEUE_NAME)).toBe(0);
  });
});

describe('Runner - RUN-003: Step order', () => {
  let store: MemoryStore;
  let queue: MemoryQueueClient;
  let logClient: MemoryLogFnClient;
  let runner: Runner;

  beforeEach(() => {
    store = new MemoryStore();
    queue = new MemoryQueueClient();
    logClient = new MemoryLogFnClient();
    runner = new Runner({ store, queue, logClient });
  });

  it('steps execute in array order', async () => {
    const orderedPipeline: PipelineSpec = {
      name: 'ordered',
      on: { workflow_dispatch: {} },
      jobs: {
        build: {
          'runs-on': 'default',
          steps: [{ run: 'echo first' }, { run: 'echo second' }, { run: 'echo third' }],
        },
      },
    };

    const run = store.createRun({
      pipelineSpec: orderedPipeline,
      trigger: { type: 'workflow_dispatch' },
    });

    runner.registerPipelineSpec(run.id, orderedPipeline);

    await queue.enqueue(DEFAULT_QUEUE_NAME, {
      runId: run.id,
      jobKey: 'build',
      jobSpec: orderedPipeline.jobs.build,
    });

    await runner.processAllJobs();

    const logs = logClient.getLines(run.id, 'build');
    const outputLines = logs.map(l => l.line).filter(l => ['first', 'second', 'third'].includes(l));
    expect(outputLines).toEqual(['first', 'second', 'third']);
  });
});

describe('Runner + API logs endpoint (TV-API-012)', () => {
  it('GET /runs/:runId/jobs/:jobKey/logs returns log lines after runner execution', async () => {
    const store = new MemoryStore();
    const queue = new MemoryQueueClient();
    const logClient = new MemoryLogFnClient();

    const { app } = await createAuthApp({ store, queue, logClient });
    const runner = new Runner({ store, queue, logClient });

    const createRes = await app.request('http://localhost/api/v1/runs', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        trigger: { type: 'workflow_dispatch' },
        pipelineSpec: singleJobPipeline,
      }),
    });
    const { data } = await createRes.json() as { data: { runId: string } };
    const runId = data.runId;

    runner.registerPipelineSpec(runId, singleJobPipeline);

    await runner.processAllJobs();

    const logsRes = await app.request(`http://localhost/api/v1/runs/${runId}/jobs/build/logs`, {
      headers: authHeaders(),
    });
    expect(logsRes.status).toBe(200);
    const logsBody = await logsRes.json() as { ok: boolean; data: { lines: Array<{ line: string }> } };
    expect(logsBody.ok).toBe(true);
    const lineTexts = logsBody.data.lines.map(l => l.line);
    expect(lineTexts.some(l => l.includes('hello'))).toBe(true);
    expect(lineTexts.some(l => l.includes('world'))).toBe(true);
  });

  it('TV-API-013: GET logs returns 404 for nonexistent job', async () => {
    const store = new MemoryStore();
    const queue = new MemoryQueueClient();
    const logClient = new MemoryLogFnClient();

    const { app } = await createAuthApp({ store, queue, logClient });

    const createRes = await app.request('http://localhost/api/v1/runs', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        trigger: { type: 'workflow_dispatch' },
        pipelineSpec: singleJobPipeline,
      }),
    });
    const { data } = await createRes.json() as { data: { runId: string } };

    const logsRes = await app.request(`http://localhost/api/v1/runs/${data.runId}/jobs/nonexistent/logs`, {
      headers: authHeaders(),
    });
    expect(logsRes.status).toBe(404);
  });

  it('GET logs returns 404 for nonexistent runId', async () => {
    const store = new MemoryStore();
    const queue = new MemoryQueueClient();
    const logClient = new MemoryLogFnClient();

    const { app } = await createAuthApp({ store, queue, logClient });

    const logsRes = await app.request('http://localhost/api/v1/runs/nonexistent/jobs/build/logs', {
      headers: authHeaders(),
    });
    expect(logsRes.status).toBe(404);
  });
});

describe('RUNNER-001: Default runner executes jobs with runs-on: default', () => {
  it('processes job for runs-on: default', async () => {
    const store = new MemoryStore();
    const queue = new MemoryQueueClient();
    const logClient = new MemoryLogFnClient();
    const runner = new Runner({ store, queue, logClient });

    const run = store.createRun({
      pipelineSpec: singleJobPipeline,
      trigger: { type: 'workflow_dispatch' },
    });

    runner.registerPipelineSpec(run.id, singleJobPipeline);

    await queue.enqueue(DEFAULT_QUEUE_NAME, {
      runId: run.id,
      jobKey: 'build',
      jobSpec: singleJobPipeline.jobs.build,
    });

    await runner.processAllJobs();

    const updatedRun = store.getRun(run.id)!;
    expect(updatedRun.status).toBe('success');
  });

  it('runs a default job in docker when job image is specified', async () => {
    const store = new MemoryStore();
    const queue = new MemoryQueueClient();
    const logClient = new MemoryLogFnClient();
    const capturedArgs: string[][] = [];
    const dockerExecutor = new DockerExecutor({
      run(args) {
        capturedArgs.push(args);
        return {
          status: 0,
          stdout: 'inside-container\n',
          stderr: '',
        };
      },
    });
    const runner = new Runner({ store, queue, logClient, dockerExecutor });

    const dockerPipeline: PipelineSpec = {
      name: 'docker-default',
      on: { workflow_dispatch: {} },
      jobs: {
        build: {
          'runs-on': 'default',
          image: 'node:20',
          steps: [{ run: 'echo "inside-container"' }],
        },
      },
    };

    const run = store.createRun({
      pipelineSpec: dockerPipeline,
      trigger: { type: 'workflow_dispatch' },
    });
    runner.registerPipelineSpec(run.id, dockerPipeline);

    await queue.enqueue(DEFAULT_QUEUE_NAME, {
      runId: run.id,
      jobKey: 'build',
      jobSpec: dockerPipeline.jobs.build,
    });

    await runner.processAllJobs();

    const updatedRun = store.getRun(run.id)!;
    expect(updatedRun.status).toBe('success');
    expect(capturedArgs).toHaveLength(1);
    expect(capturedArgs[0]).toContain('run');
    expect(capturedArgs[0]).toContain('node:20');
    expect(capturedArgs[0]).toContain('echo "inside-container"');
    const lines = logClient.getLines(run.id, 'build').map(entry => entry.line);
    expect(lines.some(line => line.includes('inside-container'))).toBe(true);
  });

  it('does not claim jobs with mismatched runs-on labels', async () => {
    const store = new MemoryStore();
    const queue = new MemoryQueueClient();
    const logClient = new MemoryLogFnClient();
    const runner = new Runner({ store, queue, logClient, labels: ['default'] });

    const hostRunnerJobPipeline: PipelineSpec = {
      name: 'hostfn-only',
      on: { workflow_dispatch: {} },
      jobs: {
        deploy: {
          'runs-on': 'hostfn-runner',
          steps: [{ run: 'echo deploy' }],
        },
      },
    };
    const run = store.createRun({
      pipelineSpec: hostRunnerJobPipeline,
      trigger: { type: 'workflow_dispatch' },
    });
    runner.registerPipelineSpec(run.id, hostRunnerJobPipeline);

    await queue.enqueue(DEFAULT_QUEUE_NAME, {
      runId: run.id,
      jobKey: 'deploy',
      jobSpec: hostRunnerJobPipeline.jobs.deploy,
    });

    const processed = await runner.processAllJobs();
    expect(processed).toBe(0);
    expect(queue.size(DEFAULT_QUEUE_NAME)).toBe(1);
    const updatedRun = store.getRun(run.id)!;
    expect(updatedRun.jobs.find(j => j.jobKey === 'deploy')?.status).toBe('pending');
  });
});

describe('RUNNER-005: Runner reports logs and status', () => {
  it('step logs reported to logfn client, job/run status updated in store', async () => {
    const store = new MemoryStore();
    const queue = new MemoryQueueClient();
    const logClient = new MemoryLogFnClient();
    const runner = new Runner({ store, queue, logClient });

    const run = store.createRun({
      pipelineSpec: singleJobPipeline,
      trigger: { type: 'workflow_dispatch' },
    });

    runner.registerPipelineSpec(run.id, singleJobPipeline);

    await queue.enqueue(DEFAULT_QUEUE_NAME, {
      runId: run.id,
      jobKey: 'build',
      jobSpec: singleJobPipeline.jobs.build,
    });

    await runner.processAllJobs();

    const allLogs = logClient.getAllLines(run.id);
    expect(allLogs.length).toBeGreaterThan(0);

    const updatedRun = store.getRun(run.id)!;
    expect(updatedRun.status).toBe('success');
    expect(updatedRun.jobs[0].status).toBe('success');
    updatedRun.jobs[0].steps.forEach(s => expect(s.status).toBe('success'));
  });
});

describe('executeCheckout', () => {
  let workspace: string;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), 'cifn-checkout-test-'));
  });

  it('TV-INT-005: clones a public repo at ref into workspace', () => {
    const result = executeCheckout({
      repo: 'https://github.com/octocat/Hello-World.git',
      ref: 'master',
      workspace,
    });
    expect(result.success).toBe(true);
    expect(result.lines.some(l => l.includes('Checkout complete'))).toBe(true);

    const files = readdirSync(workspace);
    expect(files.length).toBeGreaterThan(0);
    expect(files).toContain('README');
  });

  it('TV-INT-005 negative: invalid ref fails checkout', () => {
    const result = executeCheckout({
      repo: 'https://github.com/octocat/Hello-World.git',
      ref: 'nonexistent-branch-xyz-999',
      workspace,
    });
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });

  it('invalid repo URL fails checkout', () => {
    const result = executeCheckout({
      repo: 'https://github.com/nonexistent-org-xyz/nonexistent-repo-abc.git',
      ref: 'main',
      workspace,
    });
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });
});

describe('Runner with checkout step', () => {
  it('TV-INT-005: checkout step populates workspace for subsequent run step', async () => {
    const store = new MemoryStore();
    const queue = new MemoryQueueClient();
    const logClient = new MemoryLogFnClient();
    const runner = new Runner({ store, queue, logClient, cleanWorkspace: true });

    const checkoutPipeline: PipelineSpec = {
      name: 'checkout-test',
      on: { workflow_dispatch: {} },
      jobs: {
        build: {
          'runs-on': 'default',
          steps: [
            { uses: 'checkout', with: { repository: 'https://github.com/octocat/Hello-World.git', ref: 'master' } },
            { run: 'ls -la && cat README' },
          ],
        },
      },
    };

    const run = store.createRun({
      pipelineSpec: checkoutPipeline,
      trigger: { type: 'workflow_dispatch' },
    });

    runner.registerPipelineSpec(run.id, checkoutPipeline);

    await queue.enqueue(DEFAULT_QUEUE_NAME, {
      runId: run.id,
      jobKey: 'build',
      jobSpec: checkoutPipeline.jobs.build,
      pipelineRef: { repo: 'https://github.com/octocat/Hello-World.git', ref: 'master' },
    });

    await runner.processAllJobs();

    const updatedRun = store.getRun(run.id)!;
    expect(updatedRun.status).toBe('success');

    const job = updatedRun.jobs.find(j => j.jobKey === 'build')!;
    expect(job.steps[0].status).toBe('success');
    expect(job.steps[1].status).toBe('success');

    const logs = logClient.getLines(run.id, 'build');
    const logLines = logs.map(l => l.line);
    expect(logLines.some(l => l.includes('Checkout complete'))).toBe(true);
    expect(logLines.some(l => l.includes('README'))).toBe(true);
  });

  it('checkout step uses pipelineRef when no with.repository', async () => {
    const store = new MemoryStore();
    const queue = new MemoryQueueClient();
    const logClient = new MemoryLogFnClient();
    const runner = new Runner({ store, queue, logClient, cleanWorkspace: true });

    const checkoutPipeline: PipelineSpec = {
      name: 'checkout-ref-test',
      on: { workflow_dispatch: {} },
      jobs: {
        build: {
          'runs-on': 'default',
          steps: [
            { uses: 'checkout' },
            { run: 'cat README' },
          ],
        },
      },
    };

    const run = store.createRun({
      pipelineSpec: checkoutPipeline,
      trigger: { type: 'workflow_dispatch' },
    });

    runner.registerPipelineSpec(run.id, checkoutPipeline);

    await queue.enqueue(DEFAULT_QUEUE_NAME, {
      runId: run.id,
      jobKey: 'build',
      jobSpec: checkoutPipeline.jobs.build,
      pipelineRef: { repo: 'https://github.com/octocat/Hello-World.git', ref: 'master' },
    });

    await runner.processAllJobs();

    const updatedRun = store.getRun(run.id)!;
    expect(updatedRun.status).toBe('success');
  });
});

describe('TV-INT-006: testfn/run uses SDK and produces JSON report', () => {
  let workspace: string;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), 'cifn-testfn-test-'));
  });

  it('testfn/run step uses testfn SDK with vitest framework', async () => {
    const store = new MemoryStore();
    const queue = new MemoryQueueClient();
    const logClient = new MemoryLogFnClient();
    const runner = new Runner({ store, queue, logClient, cleanWorkspace: false });

    const testFnPipeline: PipelineSpec = {
      name: 'testfn-test',
      on: { workflow_dispatch: {} },
      jobs: {
        test: {
          'runs-on': 'default',
          steps: [
            {
              uses: 'testfn/run',
              with: {
                framework: 'vitest',
                testPattern: './tests/**/*.test.ts',
                reporter: 'json',
                outputPath: './testfn-results.json',
              },
            },
          ],
        },
      },
    };

    const run = store.createRun({
      pipelineSpec: testFnPipeline,
      trigger: { type: 'workflow_dispatch' },
    });

    runner.registerPipelineSpec(run.id, testFnPipeline);

    await queue.enqueue(DEFAULT_QUEUE_NAME, {
      runId: run.id,
      jobKey: 'test',
      jobSpec: testFnPipeline.jobs.test,
    });

    await runner.processAllJobs();

    const updatedRun = store.getRun(run.id)!;
    const job = updatedRun.jobs.find(j => j.jobKey === 'test')!;

    const logs = logClient.getLines(run.id, 'test');
    const logLines = logs.map(l => l.line);
    expect(logLines.some(l => l.includes('Running tests with testfn SDK'))).toBe(true);
    expect(logLines.some(l => l.includes('framework: vitest'))).toBe(true);
  });

  it('testfn/run with invalid framework fails deterministically', async () => {
    const store = new MemoryStore();
    const queue = new MemoryQueueClient();
    const logClient = new MemoryLogFnClient();
    const runner = new Runner({ store, queue, logClient, cleanWorkspace: false });

    const testFnPipeline: PipelineSpec = {
      name: 'testfn-invalid',
      on: { workflow_dispatch: {} },
      jobs: {
        test: {
          'runs-on': 'default',
          steps: [
            {
              uses: 'testfn/run',
              with: {
                framework: 'notreal',
                testPattern: './tests/**/*.test.ts',
              },
            },
          ],
        },
      },
    };

    const run = store.createRun({
      pipelineSpec: testFnPipeline,
      trigger: { type: 'workflow_dispatch' },
    });

    runner.registerPipelineSpec(run.id, testFnPipeline);

    await queue.enqueue(DEFAULT_QUEUE_NAME, {
      runId: run.id,
      jobKey: 'test',
      jobSpec: testFnPipeline.jobs.test,
    });

    await runner.processAllJobs();

    const updatedRun = store.getRun(run.id)!;
    expect(updatedRun.status).toBe('failure');

    const job = updatedRun.jobs.find(j => j.jobKey === 'test')!;
    expect(job.status).toBe('failure');
    expect(job.steps[0].status).toBe('failure');

    const logs = logClient.getLines(run.id, 'test');
    const logLines = logs.map(l => l.line);
    expect(logLines.some(l => l.includes('Unsupported framework'))).toBe(true);
  });
});

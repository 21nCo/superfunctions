import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MemoryStore,
  MemoryQueueClient,
  MemoryFileFnClient,
  MemorySecFnClient,
  DEFAULT_QUEUE_NAME,
  createApp,
  type PipelineSpec,
} from '@cifn/control-plane';
import { Runner } from './runner.js';
import { MemoryLogFnClient } from './reporting/logfn-client.js';
import { executeArtifactUpload } from './steps/artifact-upload.js';
import { executeArtifactDownload } from './steps/artifact-download.js';
import { executeCacheSave } from './steps/cache-save.js';
import { executeCacheRestore } from './steps/cache-restore.js';

const TEST_API_KEY = 'runner-artifacts-test-key';

async function createAuthApp(options: { store: MemoryStore; queue?: MemoryQueueClient; logClient?: MemoryLogFnClient }) {
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

describe('executeArtifactUpload', () => {
  let workspace: string;
  let fileFn: MemoryFileFnClient;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), 'cifn-art-up-'));
    fileFn = new MemoryFileFnClient();
  });

  it('uploads a single file', async () => {
    writeFileSync(join(workspace, 'output.txt'), 'hello artifact');
    const result = await executeArtifactUpload({
      name: 'out',
      path: 'output.txt',
      workspace,
      runId: 'r1',
      fileFnClient: fileFn,
    });
    expect(result.success).toBe(true);
    expect(result.fileId).toBeDefined();
    expect(result.lines.some(l => l.includes('Uploaded'))).toBe(true);
  });

  it('uploads a directory', async () => {
    mkdirSync(join(workspace, 'dist'));
    writeFileSync(join(workspace, 'dist', 'a.js'), 'console.log("a")');
    writeFileSync(join(workspace, 'dist', 'b.js'), 'console.log("b")');
    const result = await executeArtifactUpload({
      name: 'dist',
      path: 'dist',
      workspace,
      runId: 'r1',
      fileFnClient: fileFn,
    });
    expect(result.success).toBe(true);
    expect(result.lines.some(l => l.includes('2 file(s)'))).toBe(true);
  });

  it('fails when path does not exist', async () => {
    const result = await executeArtifactUpload({
      name: 'missing',
      path: 'nonexistent',
      workspace,
      runId: 'r1',
      fileFnClient: fileFn,
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain('not found');
  });

  // TV-LIMIT-001: Artifact name length validation
  it('TV-LIMIT-001: rejects artifact name exceeding 256 chars', async () => {
    writeFileSync(join(workspace, 'output.txt'), 'content');
    const longName = 'a'.repeat(257);
    const result = await executeArtifactUpload({
      name: longName,
      path: 'output.txt',
      workspace,
      runId: 'r1',
      fileFnClient: fileFn,
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain('256');
  });

  it('TV-LIMIT-001: accepts artifact name of exactly 256 chars', async () => {
    writeFileSync(join(workspace, 'output.txt'), 'content');
    const name = 'a'.repeat(256);
    const result = await executeArtifactUpload({
      name,
      path: 'output.txt',
      workspace,
      runId: 'r1',
      fileFnClient: fileFn,
    });
    expect(result.success).toBe(true);
  });
});

describe('executeArtifactDownload', () => {
  let fileFn: MemoryFileFnClient;

  beforeEach(() => {
    fileFn = new MemoryFileFnClient();
  });

  it('downloads and extracts uploaded artifact', async () => {
    const uploadWorkspace = mkdtempSync(join(tmpdir(), 'cifn-art-up2-'));
    mkdirSync(join(uploadWorkspace, 'dist'));
    writeFileSync(join(uploadWorkspace, 'dist', 'index.js'), 'main()');

    await executeArtifactUpload({
      name: 'dist',
      path: 'dist',
      workspace: uploadWorkspace,
      runId: 'r1',
      fileFnClient: fileFn,
    });

    const downloadWorkspace = mkdtempSync(join(tmpdir(), 'cifn-art-down-'));
    const result = await executeArtifactDownload({
      name: 'dist',
      workspace: downloadWorkspace,
      runId: 'r1',
      fileFnClient: fileFn,
    });

    expect(result.success).toBe(true);
    expect(existsSync(join(downloadWorkspace, 'index.js'))).toBe(true);
    expect(readFileSync(join(downloadWorkspace, 'index.js'), 'utf-8')).toBe('main()');
  });

  it('fails when artifact not found', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'cifn-art-down2-'));
    const result = await executeArtifactDownload({
      name: 'missing',
      workspace,
      runId: 'r1',
      fileFnClient: fileFn,
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain('not found');
  });
});

describe('executeCacheSave and executeCacheRestore', () => {
  let fileFn: MemoryFileFnClient;

  beforeEach(() => {
    fileFn = new MemoryFileFnClient();
  });

  it('TV-INT-003: save then restore populates workspace', async () => {
    const saveWorkspace = mkdtempSync(join(tmpdir(), 'cifn-cache-save-'));
    mkdirSync(join(saveWorkspace, 'node_modules'));
    writeFileSync(join(saveWorkspace, 'node_modules', 'pkg.json'), '{"name":"test"}');

    const saveResult = await executeCacheSave({
      key: 'deps-1',
      paths: ['node_modules'],
      workspace: saveWorkspace,
      fileFnClient: fileFn,
    });
    expect(saveResult.success).toBe(true);

    const restoreWorkspace = mkdtempSync(join(tmpdir(), 'cifn-cache-restore-'));
    const restoreResult = await executeCacheRestore({
      key: 'deps-1',
      workspace: restoreWorkspace,
      fileFnClient: fileFn,
    });
    expect(restoreResult.success).toBe(true);
    expect(restoreResult.hit).toBe(true);
    expect(existsSync(join(restoreWorkspace, 'node_modules', 'pkg.json'))).toBe(true);
    expect(readFileSync(join(restoreWorkspace, 'node_modules', 'pkg.json'), 'utf-8')).toBe('{"name":"test"}');
  });

  it('TV-INT-003: cache miss does not fail step', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'cifn-cache-miss-'));
    const result = await executeCacheRestore({
      key: 'nonexistent-key',
      workspace,
      fileFnClient: fileFn,
    });
    expect(result.success).toBe(true);
    expect(result.hit).toBe(false);
  });

  it('save with no matching files succeeds', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'cifn-cache-empty-'));
    const result = await executeCacheSave({
      key: 'empty',
      paths: ['nonexistent-dir'],
      workspace,
      fileFnClient: fileFn,
    });
    expect(result.success).toBe(true);
    expect(result.lines.some(l => l.includes('No files found'))).toBe(true);
  });

  // TV-LIMIT-001: Cache key length validation
  it('TV-LIMIT-001: rejects cache key exceeding 1KB in save', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'cifn-cache-long-'));
    writeFileSync(join(workspace, 'file.txt'), 'content');
    const longKey = 'k'.repeat(1025);
    const result = await executeCacheSave({
      key: longKey,
      paths: ['file.txt'],
      workspace,
      fileFnClient: fileFn,
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain('1KB');
  });

  it('TV-LIMIT-001: rejects cache key exceeding 1KB in restore', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'cifn-cache-long-'));
    const longKey = 'k'.repeat(1025);
    const result = await executeCacheRestore({
      key: longKey,
      workspace,
      fileFnClient: fileFn,
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain('1KB');
  });

  it('TV-LIMIT-001: accepts cache key of exactly 1KB', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'cifn-cache-1kb-'));
    writeFileSync(join(workspace, 'file.txt'), 'content');
    const key = 'k'.repeat(1024);
    const saveResult = await executeCacheSave({
      key,
      paths: ['file.txt'],
      workspace,
      fileFnClient: fileFn,
    });
    expect(saveResult.success).toBe(true);
    
    const restoreResult = await executeCacheRestore({
      key,
      workspace,
      fileFnClient: fileFn,
    });
    expect(restoreResult.success).toBe(true);
  });
});

describe('TV-INT-002: Runner artifact upload/download across jobs', () => {
  it('job A uploads artifact, job B downloads it', async () => {
    const store = new MemoryStore();
    const queue = new MemoryQueueClient();
    const logClient = new MemoryLogFnClient();
    const fileFn = new MemoryFileFnClient();

    const runner = new Runner({
      store, queue, logClient,
      fileFnClient: fileFn,
      artifactStore: store,
      cleanWorkspace: false,
    });

    const pipeline: PipelineSpec = {
      name: 'artifact-test',
      on: { workflow_dispatch: {} },
      jobs: {
        build: {
          'runs-on': 'default',
          steps: [
            { run: 'mkdir -p dist && echo "built" > dist/output.txt' },
            { uses: 'artifact/upload' as any, with: { name: 'dist', path: 'dist' } },
          ],
        },
        deploy: {
          'runs-on': 'default',
          needs: ['build'],
          steps: [
            { uses: 'artifact/download' as any, with: { name: 'dist' } },
            { run: 'cat output.txt' },
          ],
        },
      },
    };

    const run = store.createRun({
      pipelineSpec: pipeline,
      trigger: { type: 'workflow_dispatch' },
    });

    runner.registerPipelineSpec(run.id, pipeline);

    await queue.enqueue(DEFAULT_QUEUE_NAME, {
      runId: run.id,
      jobKey: 'build',
      jobSpec: pipeline.jobs.build,
    });

    await runner.processAllJobs();

    const updatedRun = store.getRun(run.id)!;
    expect(updatedRun.status).toBe('success');

    const buildJob = updatedRun.jobs.find(j => j.jobKey === 'build')!;
    expect(buildJob.status).toBe('success');
    expect(buildJob.steps[0].status).toBe('success');
    expect(buildJob.steps[1].status).toBe('success');

    const deployJob = updatedRun.jobs.find(j => j.jobKey === 'deploy')!;
    expect(deployJob.status).toBe('success');
    expect(deployJob.steps[0].status).toBe('success');
    expect(deployJob.steps[1].status).toBe('success');

    const artifacts = store.getArtifacts(run.id);
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0].name).toBe('dist');
    expect(artifacts[0].fileId).toBeDefined();

    const logs = logClient.getLines(run.id, 'deploy');
    const logLines = logs.map(l => l.line);
    expect(logLines.some(l => l.includes('built'))).toBe(true);
  });
});

describe('TV-INT-003: Runner cache save/restore', () => {
  it('cache/save then cache/restore in another run restores files', async () => {
    const store = new MemoryStore();
    const queue = new MemoryQueueClient();
    const logClient = new MemoryLogFnClient();
    const fileFn = new MemoryFileFnClient();

    const runner = new Runner({
      store, queue, logClient,
      fileFnClient: fileFn,
    });

    const savePipeline: PipelineSpec = {
      name: 'cache-save',
      on: { workflow_dispatch: {} },
      jobs: {
        build: {
          'runs-on': 'default',
          steps: [
            { run: 'mkdir -p node_modules && echo "cached" > node_modules/pkg.txt' },
            { uses: 'cache/save' as any, with: { key: 'deps-1', paths: ['node_modules'] } },
          ],
        },
      },
    };

    const run1 = store.createRun({
      pipelineSpec: savePipeline,
      trigger: { type: 'workflow_dispatch' },
    });
    runner.registerPipelineSpec(run1.id, savePipeline);
    await queue.enqueue(DEFAULT_QUEUE_NAME, {
      runId: run1.id,
      jobKey: 'build',
      jobSpec: savePipeline.jobs.build,
    });
    await runner.processAllJobs();

    expect(store.getRun(run1.id)!.status).toBe('success');

    const restorePipeline: PipelineSpec = {
      name: 'cache-restore',
      on: { workflow_dispatch: {} },
      jobs: {
        build: {
          'runs-on': 'default',
          steps: [
            { uses: 'cache/restore' as any, with: { key: 'deps-1' } },
            { run: 'cat node_modules/pkg.txt' },
          ],
        },
      },
    };

    const run2 = store.createRun({
      pipelineSpec: restorePipeline,
      trigger: { type: 'workflow_dispatch' },
    });
    runner.registerPipelineSpec(run2.id, restorePipeline);
    await queue.enqueue(DEFAULT_QUEUE_NAME, {
      runId: run2.id,
      jobKey: 'build',
      jobSpec: restorePipeline.jobs.build,
    });
    await runner.processAllJobs();

    const updatedRun2 = store.getRun(run2.id)!;
    expect(updatedRun2.status).toBe('success');

    const job = updatedRun2.jobs.find(j => j.jobKey === 'build')!;
    expect(job.steps[0].status).toBe('success');
    expect(job.steps[1].status).toBe('success');

    const logs = logClient.getLines(run2.id, 'build');
    const logLines = logs.map(l => l.line);
    expect(logLines.some(l => l.includes('cache hit'))).toBe(true);
    expect(logLines.some(l => l.includes('cached'))).toBe(true);
  });

  it('cache/restore with missing key is cache miss, step still succeeds', async () => {
    const store = new MemoryStore();
    const queue = new MemoryQueueClient();
    const logClient = new MemoryLogFnClient();
    const fileFn = new MemoryFileFnClient();

    const runner = new Runner({
      store, queue, logClient,
      fileFnClient: fileFn,
    });

    const pipeline: PipelineSpec = {
      name: 'cache-miss',
      on: { workflow_dispatch: {} },
      jobs: {
        build: {
          'runs-on': 'default',
          steps: [
            { uses: 'cache/restore' as any, with: { key: 'nonexistent' } },
            { run: 'echo ok' },
          ],
        },
      },
    };

    const run = store.createRun({
      pipelineSpec: pipeline,
      trigger: { type: 'workflow_dispatch' },
    });
    runner.registerPipelineSpec(run.id, pipeline);
    await queue.enqueue(DEFAULT_QUEUE_NAME, {
      runId: run.id,
      jobKey: 'build',
      jobSpec: pipeline.jobs.build,
    });
    await runner.processAllJobs();

    const updatedRun = store.getRun(run.id)!;
    expect(updatedRun.status).toBe('success');

    const job = updatedRun.jobs.find(j => j.jobKey === 'build')!;
    expect(job.steps[0].status).toBe('success');
    expect(job.steps[1].status).toBe('success');

    const logs = logClient.getLines(run.id, 'build');
    expect(logs.some(l => l.line.includes('cache miss'))).toBe(true);
  });
});

describe('TV-API-014: GET /runs/:runId/artifacts', () => {
  it('returns artifacts after upload', async () => {
    const store = new MemoryStore();
    const queue = new MemoryQueueClient();
    const logClient = new MemoryLogFnClient();
    const fileFn = new MemoryFileFnClient();

    const { app } = await createAuthApp({ store, queue, logClient });
    const runner = new Runner({
      store, queue, logClient,
      fileFnClient: fileFn,
      artifactStore: store,
    });

    const pipeline: PipelineSpec = {
      name: 'art-api',
      on: { workflow_dispatch: {} },
      jobs: {
        build: {
          'runs-on': 'default',
          steps: [
            { run: 'mkdir dist && echo x > dist/out.txt' },
            { uses: 'artifact/upload' as any, with: { name: 'out', path: 'dist' } },
          ],
        },
      },
    };

    const createRes = await app.request('http://localhost/api/v1/runs', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        trigger: { type: 'workflow_dispatch' },
        pipelineSpec: pipeline,
      }),
    });
    const { data } = await createRes.json() as { data: { runId: string } };
    const runId = data.runId;

    runner.registerPipelineSpec(runId, pipeline);
    await runner.processAllJobs();

    const artRes = await app.request(`http://localhost/api/v1/runs/${runId}/artifacts`, {
      headers: authHeaders(),
    });
    expect(artRes.status).toBe(200);
    const artBody = await artRes.json() as { ok: boolean; data: { artifacts: Array<{ name: string; fileId?: string }> } };
    expect(artBody.ok).toBe(true);
    expect(artBody.data.artifacts).toHaveLength(1);
    expect(artBody.data.artifacts[0].name).toBe('out');
    expect(artBody.data.artifacts[0].fileId).toBeDefined();
  });

  it('returns empty array when no artifacts', async () => {
    const store = new MemoryStore();
    const queue = new MemoryQueueClient();
    const { app } = await createAuthApp({ store, queue });

    const createRes = await app.request('http://localhost/api/v1/runs', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        trigger: { type: 'workflow_dispatch' },
        pipelineSpec: {
          name: 'no-art',
          on: { workflow_dispatch: {} },
          jobs: { build: { 'runs-on': 'default', steps: [{ run: 'echo ok' }] } },
        },
      }),
    });
    const { data } = await createRes.json() as { data: { runId: string } };

    const artRes = await app.request(`http://localhost/api/v1/runs/${data.runId}/artifacts`, {
      headers: authHeaders(),
    });
    expect(artRes.status).toBe(200);
    const artBody = await artRes.json() as { ok: boolean; data: { artifacts: unknown[] } };
    expect(artBody.ok).toBe(true);
    expect(artBody.data.artifacts).toEqual([]);
  });

  it('returns 404 for nonexistent run', async () => {
    const store = new MemoryStore();
    const { app } = await createAuthApp({ store });

    const res = await app.request('http://localhost/api/v1/runs/nonexistent/artifacts', {
      headers: authHeaders(),
    });
    expect(res.status).toBe(404);
  });
});

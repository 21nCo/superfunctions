import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MemoryStore,
  MemoryQueueClient,
  MemorySecFnClient,
  DEFAULT_QUEUE_NAME,
  resolveExpressions,
  resolveEnvMap,
  type PipelineSpec,
  type ExpressionContext,
} from '@cifn/control-plane';
import { Runner } from './runner.js';
import { MemoryLogFnClient } from './reporting/logfn-client.js';
import { redactSecrets } from './reporting/redact.js';
import { executeTestFnRun } from './steps/testfn-run.js';
import { executeHostFnDeploy } from './steps/hostfn-deploy.js';
import { executeCheckout } from './steps/checkout.js';

describe('MemorySecFnClient', () => {
  it('stores and retrieves secrets', async () => {
    const secfn = new MemorySecFnClient();
    await secfn.setSecret('MY_KEY', 'secret-value');
    expect(await secfn.getSecret('MY_KEY')).toBe('secret-value');
  });

  it('returns null for unknown key', async () => {
    const secfn = new MemorySecFnClient();
    expect(await secfn.getSecret('UNKNOWN')).toBeNull();
  });

  it('lists keys', async () => {
    const secfn = new MemorySecFnClient();
    await secfn.setSecret('A', '1');
    await secfn.setSecret('B', '2');
    expect(await secfn.listKeys()).toEqual(['A', 'B']);
  });
});

describe('resolveExpressions', () => {
  let secfn: MemorySecFnClient;
  let context: ExpressionContext;

  beforeEach(async () => {
    secfn = new MemorySecFnClient();
    await secfn.setSecret('MY_SECRET', 'redact-me');
    await secfn.setSecret('HOSTFN_SSH_KEY', 'ssh-key-value');
    context = {
      secrets: secfn,
      github: { ref: 'refs/heads/main', repository: 'org/repo' },
    };
  });

  it('resolves ${{ secrets.MY_SECRET }}', async () => {
    const result = await resolveExpressions('value=${{ secrets.MY_SECRET }}', context);
    expect(result.resolved).toBe('value=redact-me');
    expect(result.secretValues).toContain('redact-me');
  });

  it('resolves ${{ github.ref }}', async () => {
    const result = await resolveExpressions('ref=${{ github.ref }}', context);
    expect(result.resolved).toBe('ref=refs/heads/main');
    expect(result.secretValues).toHaveLength(0);
  });

  it('resolves multiple expressions', async () => {
    const result = await resolveExpressions(
      '${{ secrets.MY_SECRET }}-${{ github.ref }}',
      context,
    );
    expect(result.resolved).toBe('redact-me-refs/heads/main');
    expect(result.secretValues).toContain('redact-me');
  });
});

describe('resolveEnvMap', () => {
  it('resolves env map with secrets', async () => {
    const secfn = new MemorySecFnClient();
    await secfn.setSecret('TOKEN', 'abc123');
    const context: ExpressionContext = { secrets: secfn };
    const result = await resolveEnvMap(
      { MY_TOKEN: '${{ secrets.TOKEN }}', PLAIN: 'hello' },
      context,
    );
    expect(result.resolved.MY_TOKEN).toBe('abc123');
    expect(result.resolved.PLAIN).toBe('hello');
    expect(result.secretValues).toContain('abc123');
  });
});

describe('redactSecrets', () => {
  it('redacts each emitted component of a multiline secret', () => {
    expect(redactSecrets(['prefix=alpha-key', 'beta-key suffix'], ['alpha-key\r\nbeta-key']))
      .toEqual(['prefix=***', '*** suffix']);
  });

  it('uses longest literal matches without rewriting inserted markers', () => {
    expect(redactSecrets(['abcde a.b $$$'], ['abc', 'abcde', 'a.b', '$$$', '*']))
      .toEqual(['*** *** ***']);
  });

  it('replaces secret values with ***', () => {
    const result = redactSecrets(
      ['my secret is redact-me and more redact-me here'],
      ['redact-me'],
    );
    expect(result[0]).toBe('my secret is *** and more *** here');
    expect(result[0]).not.toContain('redact-me');
  });

  it('handles multiple secret values', () => {
    const result = redactSecrets(
      ['key1=abc key2=xyz'],
      ['abc', 'xyz'],
    );
    expect(result[0]).toBe('key1=*** key2=***');
  });

  it('returns lines unchanged when no secrets', () => {
    const result = redactSecrets(['no secrets here'], []);
    expect(result[0]).toBe('no secrets here');
  });
});

describe('TV-SEC-003 / TV-PIPE-009 / TV-OBS-002: Secrets never in logs', () => {
  it('secret value is redacted from step output and logs', async () => {
    const store = new MemoryStore();
    const queue = new MemoryQueueClient();
    const logClient = new MemoryLogFnClient();
    const runner = new Runner({ store, queue, logClient });

    const pipeline: PipelineSpec = {
      name: 'secret-test',
      on: { workflow_dispatch: {} },
      jobs: {
        build: {
          'runs-on': 'default',
          steps: [{ run: 'echo $MY_SECRET' }],
        },
      },
    };

    const run = store.createRun({
      pipelineSpec: pipeline,
      trigger: { type: 'workflow_dispatch' },
    });

    runner.registerPipelineSpec(run.id, pipeline);
    runner.registerSecretValues(run.id, ['redact-me']);

    await queue.enqueue(DEFAULT_QUEUE_NAME, {
      runId: run.id,
      jobKey: 'build',
      jobSpec: pipeline.jobs.build,
      env: { MY_SECRET: 'redact-me' },
      secretKeys: ['MY_SECRET'],
    });

    await runner.processAllJobs();

    const updatedRun = store.getRun(run.id)!;
    expect(updatedRun.status).toBe('success');

    const logs = logClient.getAllLines(run.id);
    const allLogText = logs.map(l => l.line).join('\n');
    expect(allLogText).not.toContain('redact-me');
    expect(allLogText).toContain('***');
  });

  it('secret env is available to step but redacted in logs', async () => {
    const store = new MemoryStore();
    const queue = new MemoryQueueClient();
    const logClient = new MemoryLogFnClient();
    const runner = new Runner({ store, queue, logClient });

    const pipeline: PipelineSpec = {
      name: 'secret-env-test',
      on: { workflow_dispatch: {} },
      jobs: {
        build: {
          'runs-on': 'default',
          steps: [
            { run: 'echo "value is $TEST_SECRET"' },
          ],
        },
      },
    };

    const run = store.createRun({
      pipelineSpec: pipeline,
      trigger: { type: 'workflow_dispatch' },
    });

    runner.registerPipelineSpec(run.id, pipeline);
    runner.registerSecretValues(run.id, ['secret123']);

    await queue.enqueue(DEFAULT_QUEUE_NAME, {
      runId: run.id,
      jobKey: 'build',
      jobSpec: pipeline.jobs.build,
      env: { TEST_SECRET: 'secret123' },
      secretKeys: ['TEST_SECRET'],
    });

    await runner.processAllJobs();

    const logs = logClient.getAllLines(run.id);
    const allLogText = logs.map(l => l.line).join('\n');
    expect(allLogText).not.toContain('secret123');
    expect(allLogText).toContain('value is ***');
  });
});

describe('TV-INT-004: testfn/run step', () => {
  it('testfn step succeeds with passing test', async () => {
    const store = new MemoryStore();
    const queue = new MemoryQueueClient();
    const logClient = new MemoryLogFnClient();
    const runner = new Runner({ store, queue, logClient });

    const workspace = mkdtempSync(join(tmpdir(), 'cifn-testfn-'));
    writeFileSync(join(workspace, 'test.sh'), '#!/bin/sh\nexit 0\n');

    const pipeline: PipelineSpec = {
      name: 'testfn-pass',
      on: { workflow_dispatch: {} },
      jobs: {
        test: {
          'runs-on': 'default',
          steps: [
            { run: 'echo "test file created"' },
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
      jobKey: 'test',
      jobSpec: pipeline.jobs.test,
    });

    await runner.processAllJobs();
    expect(store.getRun(run.id)!.status).toBe('success');
  });

  it('executeTestFnRun reports failure for failing command', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'cifn-testfn-fail-'));
    writeFileSync(join(workspace, 'package.json'), '{"scripts":{"test":"exit 1"}}');

    const result = executeTestFnRun({
      workspace,
      env: { PATH: process.env.PATH ?? '' },
    });
    expect(result.success).toBe(false);
    expect(result.exitCode).not.toBe(0);
    expect(result.lines.some(l => l.includes('failed'))).toBe(true);
  }, 30_000);
});

describe('TV-INT-006: hostfn/deploy step', () => {
  it('executeHostFnDeploy constructs correct command', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'cifn-hostfn-'));
    writeFileSync(join(workspace, 'hostfn'), '#!/bin/sh\necho "deploy $@"\n');

    const result = executeHostFnDeploy({
      environment: 'production',
      ci: true,
      workspace,
    });
    expect(result.lines[0]).toContain('hostfn deploy production');
    expect(result.lines[0]).toContain('--ci');
  });

  it('TV-INT-007: hostfn/deploy always includes --ci flag (default runner)', async () => {
    const store = new MemoryStore();
    const queue = new MemoryQueueClient();
    const logClient = new MemoryLogFnClient();
    const runner = new Runner({ store, queue, logClient, runnerType: 'default' });

    const pipeline: PipelineSpec = {
      name: 'hostfn-default-runner',
      on: { workflow_dispatch: {} },
      jobs: {
        deploy: {
          'runs-on': 'default',
          steps: [{ uses: 'hostfn/deploy', with: { environment: 'production' } }],
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
      jobKey: 'deploy',
      jobSpec: pipeline.jobs.deploy,
    });

    await runner.processAllJobs();

    const logs = logClient.getAllLines(run.id).map(entry => entry.line).join('\n');
    expect(logs).toContain('hostfn deploy production');
    expect(logs).toContain('--ci');
    expect(logs).not.toContain('--local');
  });

  it('TV-RUNNER-002: hostfn-runner deploy uses --local --ci (based on runs-on)', async () => {
    const store = new MemoryStore();
    const queue = new MemoryQueueClient();
    const logClient = new MemoryLogFnClient();
    const runner = new Runner({ store, queue, logClient, runnerType: 'hostfn-runner' });

    const pipeline: PipelineSpec = {
      name: 'hostfn-runner-local',
      on: { workflow_dispatch: {} },
      jobs: {
        deploy: {
          'runs-on': 'hostfn-runner',
          steps: [{ uses: 'hostfn/deploy', with: { environment: 'production' } }],
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
      jobKey: 'deploy',
      jobSpec: pipeline.jobs.deploy,
    });

    await runner.processAllJobs();

    const logs = logClient.getAllLines(run.id).map(entry => entry.line).join('\n');
    expect(logs).toContain('hostfn deploy production --local --ci');
  });

  it('TV-RUNNER-002 variant: runs-on determines --local flag (not runner type)', async () => {
    const store = new MemoryStore();
    const queue = new MemoryQueueClient();
    const logClient = new MemoryLogFnClient();
    const runner = new Runner({ store, queue, logClient, labels: ['default', 'hostfn-runner'] });

    const pipelineDefault: PipelineSpec = {
      name: 'test-runs-on-logic',
      on: { workflow_dispatch: {} },
      jobs: {
        deployDefault: {
          'runs-on': 'default',
          steps: [{ uses: 'hostfn/deploy', with: { environment: 'staging' } }],
        },
        deployHostfn: {
          'runs-on': 'hostfn-runner',
          steps: [{ uses: 'hostfn/deploy', with: { environment: 'production' } }],
        },
      },
    };

    const run = store.createRun({
      pipelineSpec: pipelineDefault,
      trigger: { type: 'workflow_dispatch' },
    });
    runner.registerPipelineSpec(run.id, pipelineDefault);

    await queue.enqueue(DEFAULT_QUEUE_NAME, {
      runId: run.id,
      jobKey: 'deployDefault',
      jobSpec: pipelineDefault.jobs.deployDefault,
    });

    await queue.enqueue(DEFAULT_QUEUE_NAME, {
      runId: run.id,
      jobKey: 'deployHostfn',
      jobSpec: pipelineDefault.jobs.deployHostfn,
    });

    await runner.processAllJobs();

    const logs = logClient.getAllLines(run.id).map(entry => entry.line).join('\n');
    expect(logs).toContain('hostfn deploy staging');
    expect(logs).toMatch(/hostfn deploy staging[^-]*--ci/);
    expect(logs).not.toContain('hostfn deploy staging --local');
    expect(logs).toContain('hostfn deploy production --local --ci');
  });

  it('TV-SEC-001: hostfn/deploy secrets are redacted in logs', async () => {
    const store = new MemoryStore();
    const queue = new MemoryQueueClient();
    const logClient = new MemoryLogFnClient();
    const runner = new Runner({ store, queue, logClient });

    const pipeline: PipelineSpec = {
      name: 'hostfn-secret-test',
      on: { workflow_dispatch: {} },
      jobs: {
        deploy: {
          'runs-on': 'default',
          steps: [
            { uses: 'hostfn/deploy', with: { environment: 'production' } },
          ],
        },
      },
    };

    const run = store.createRun({
      pipelineSpec: pipeline,
      trigger: { type: 'workflow_dispatch' },
    });

    runner.registerPipelineSpec(run.id, pipeline);
    runner.registerSecretValues(run.id, ['secret-ssh-key-123', 'deploy-token-xyz']);

    await queue.enqueue(DEFAULT_QUEUE_NAME, {
      runId: run.id,
      jobKey: 'deploy',
      jobSpec: pipeline.jobs.deploy,
      env: {
        HOSTFN_SSH_KEY: 'secret-ssh-key-123',
        DEPLOY_TOKEN: 'deploy-token-xyz',
      },
      secretKeys: ['HOSTFN_SSH_KEY', 'DEPLOY_TOKEN'],
    });

    await runner.processAllJobs();

    const logs = logClient.getAllLines(run.id);
    const allLogText = logs.map(l => l.line).join('\n');
    expect(allLogText).not.toContain('secret-ssh-key-123');
    expect(allLogText).not.toContain('deploy-token-xyz');
    expect(allLogText).toContain('hostfn deploy production --ci');
  });

  it('hostfn/deploy step passes env from secfn to subprocess', async () => {
    const store = new MemoryStore();
    const queue = new MemoryQueueClient();
    const logClient = new MemoryLogFnClient();
    const runner = new Runner({ store, queue, logClient });

    const pipeline: PipelineSpec = {
      name: 'deploy-test',
      on: { workflow_dispatch: {} },
      jobs: {
        deploy: {
          'runs-on': 'default',
          steps: [
            { run: 'echo "HOSTFN_SSH_KEY=$HOSTFN_SSH_KEY"' },
          ],
        },
      },
    };

    const run = store.createRun({
      pipelineSpec: pipeline,
      trigger: { type: 'workflow_dispatch' },
    });

    runner.registerPipelineSpec(run.id, pipeline);
    runner.registerSecretValues(run.id, ['ssh-key-value']);

    await queue.enqueue(DEFAULT_QUEUE_NAME, {
      runId: run.id,
      jobKey: 'deploy',
      jobSpec: pipeline.jobs.deploy,
      env: { HOSTFN_SSH_KEY: 'ssh-key-value' },
      secretKeys: ['HOSTFN_SSH_KEY'],
    });

    await runner.processAllJobs();

    expect(store.getRun(run.id)!.status).toBe('success');

    const logs = logClient.getAllLines(run.id);
    const allLogText = logs.map(l => l.line).join('\n');
    expect(allLogText).not.toContain('ssh-key-value');
    expect(allLogText).toContain('HOSTFN_SSH_KEY=***');
  });
});

describe('SEC-001 / INT-003: Secrets from secfn, not stored in plaintext', () => {
  it('run with env from secretKeys: secret values not in store run data', async () => {
    const store = new MemoryStore();
    const queue = new MemoryQueueClient();
    const logClient = new MemoryLogFnClient();
    const runner = new Runner({ store, queue, logClient });

    const pipeline: PipelineSpec = {
      name: 'secfn-test',
      on: { workflow_dispatch: {} },
      jobs: {
        build: {
          'runs-on': 'default',
          steps: [{ run: 'echo done' }],
        },
      },
    };

    const run = store.createRun({
      pipelineSpec: pipeline,
      trigger: { type: 'workflow_dispatch' },
    });

    runner.registerPipelineSpec(run.id, pipeline);
    runner.registerSecretValues(run.id, ['top-secret-val']);

    await queue.enqueue(DEFAULT_QUEUE_NAME, {
      runId: run.id,
      jobKey: 'build',
      jobSpec: pipeline.jobs.build,
      env: { SECRET_KEY: 'top-secret-val' },
      secretKeys: ['SECRET_KEY'],
    });

    await runner.processAllJobs();

    const storedRun = store.getRun(run.id)!;
    const runJson = JSON.stringify(storedRun);
    expect(runJson).not.toContain('top-secret-val');
  });
});

describe('Runner env passing to run steps', () => {
  it('env variables are available in shell steps', async () => {
    const store = new MemoryStore();
    const queue = new MemoryQueueClient();
    const logClient = new MemoryLogFnClient();
    const runner = new Runner({ store, queue, logClient });

    const pipeline: PipelineSpec = {
      name: 'env-test',
      on: { workflow_dispatch: {} },
      jobs: {
        build: {
          'runs-on': 'default',
          steps: [{ run: 'echo "HELLO=$HELLO_VAR"' }],
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
      env: { HELLO_VAR: 'world' },
    });

    await runner.processAllJobs();

    expect(store.getRun(run.id)!.status).toBe('success');

    const logs = logClient.getAllLines(run.id);
    const allLogText = logs.map(l => l.line).join('\n');
    expect(allLogText).toContain('HELLO=world');
  });
});

describe('TV-RUN-007 / TV-OBS-003: Checkout token redaction', () => {
  it('checkout token is redacted from git output', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'cifn-checkout-'));
    const token = 'ghp_testtoken123';
    
    const result = executeCheckout({
      repo: 'https://github.com/invalid/repo',
      ref: 'main',
      workspace,
      token,
    });
    
    expect(result.success).toBe(false);
    const allLines = result.lines.join('\n');
    expect(allLines).not.toContain(token);
    expect(allLines).not.toContain(`x-access-token:${token}`);
  });

  it('checkout token value not in error message', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'cifn-checkout-fail-'));
    const token = 'ghp_secrettoken456';
    
    const result = executeCheckout({
      repo: 'https://github.com/nonexistent/repo',
      ref: 'nonexistent',
      workspace,
      token,
    });
    
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.error).not.toContain(token);
    
    const allOutput = result.lines.join('\n') + (result.error ?? '');
    expect(allOutput).not.toContain(token);
  });
});

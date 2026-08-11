import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { QueueClient, JobPayload } from '@cifn/control-plane';
import {
  DEFAULT_QUEUE_NAME,
  getReadyJobs,
  evaluateConditionSync,
  interpolate,
  hashFiles,
  type MemoryStore,
  type PipelineSpec,
} from '@cifn/control-plane';
import { executeRunStep } from './executor/run-step.js';
import { executeCheckout } from './steps/checkout.js';
import { executeArtifactUpload } from './steps/artifact-upload.js';
import { executeArtifactDownload } from './steps/artifact-download.js';
import { executeCacheSave } from './steps/cache-save.js';
import { executeCacheRestore } from './steps/cache-restore.js';
import { executeHostFnDeploy } from './steps/hostfn-deploy.js';
import type { LogFnClient } from './reporting/logfn-client.js';
import { redactSecrets } from './reporting/redact.js';
import { DockerExecutor } from './docker-executor.js';

export interface RunnerOptions {
  store: MemoryStore;
  queue: QueueClient;
  logClient: LogFnClient;
  pipelineSpecs?: Map<string, PipelineSpec>;
  queueName?: string;
  cleanWorkspace?: boolean;
  fileFnClient?: {
    upload(namespace: string, key: string, data: Buffer): Promise<string>;
    downloadByKey(namespace: string, key: string): Promise<Buffer | null>;
  };
  artifactStore?: {
    addArtifact(runId: string, artifact: { name: string; fileId: string; url?: string }): void;
  };
  secretValues?: Map<string, string[]>;
  /** Resolve secret by name for interpolation. When not set, ${{ secrets.* }} in run/with/cache key will fail. */
  getSecret?: (runId: string, name: string) => Promise<string | null>;
  labels?: string[];
  runnerType?: 'default' | 'hostfn-runner';
  dockerExecutor?: DockerExecutor;
  defaultDockerImage?: string;
  dockerRunOnLabels?: string[];
  dockerForDefault?: boolean;
}

export class Runner {
  private store: MemoryStore;
  private queue: QueueClient;
  private logClient: LogFnClient;
  private pipelineSpecs: Map<string, PipelineSpec>;
  private queueName: string;
  private cleanWorkspace: boolean;
  private fileFnClient?: RunnerOptions['fileFnClient'];
  private artifactStore?: RunnerOptions['artifactStore'];
  private secretValues: Map<string, string[]>;
  private labels: string[];
  private runnerType: 'default' | 'hostfn-runner';
  private dockerExecutor?: DockerExecutor;
  private defaultDockerImage: string;
  private dockerRunOnLabels: Set<string>;
  private dockerForDefault: boolean;
  private getSecret?: (runId: string, name: string) => Promise<string | null>;

  constructor(options: RunnerOptions) {
    this.store = options.store;
    this.queue = options.queue;
    this.logClient = options.logClient;
    this.pipelineSpecs = options.pipelineSpecs ?? new Map();
    this.queueName = options.queueName ?? DEFAULT_QUEUE_NAME;
    this.cleanWorkspace = options.cleanWorkspace ?? true;
    this.fileFnClient = options.fileFnClient;
    this.artifactStore = options.artifactStore;
    this.secretValues = options.secretValues ?? new Map();
    this.getSecret = options.getSecret;
    this.runnerType = options.runnerType ?? 'default';
    this.labels = options.labels && options.labels.length > 0
      ? [...new Set(options.labels)]
      : [this.runnerType];
    this.dockerExecutor = options.dockerExecutor;
    this.defaultDockerImage = options.defaultDockerImage ?? 'node:20';
    this.dockerRunOnLabels = new Set(options.dockerRunOnLabels ?? ['docker-ubuntu-22']);
    this.dockerForDefault = options.dockerForDefault ?? false;
  }

  registerPipelineSpec(runId: string, spec: PipelineSpec): void {
    this.pipelineSpecs.set(runId, spec);
  }

  registerSecretValues(runId: string, values: string[]): void {
    this.secretValues.set(runId, values);
  }

  async processNextJob(): Promise<boolean> {
    const payload = await this.queue.dequeueMatching(this.queueName, (job) =>
      this.labels.includes(job.jobSpec['runs-on'])
    );
    if (!payload) return false;
    await this.executeJob(payload);
    return true;
  }

  async processAllJobs(): Promise<number> {
    let count = 0;
    while (await this.processNextJob()) {
      count++;
    }
    return count;
  }

  private async executeJob(payload: JobPayload): Promise<void> {
    const { runId, jobKey, jobSpec } = payload;
    let jobEnv: Record<string, string> = { ...payload.env };
    const secretVals = this.secretValues.get(runId) ?? [];
    if (payload.secretKeys && jobEnv) {
      for (const key of payload.secretKeys) {
        const val = jobEnv[key];
        if (val && !secretVals.includes(val)) {
          secretVals.push(val);
        }
      }
    }

    const logLines = (stepKey: string, lines: string[]) => {
      this.logClient.appendLines(runId, jobKey, stepKey, redactSecrets(lines, secretVals));
    };

    const run = this.store.getRun(runId);
    if (!run) return;

    const job = run.jobs.find(j => j.jobKey === jobKey);
    if (!job) return;

    const github = (run.trigger?.payload?.github as Record<string, string> | undefined) ?? {};
    if (!github.ref && payload.pipelineRef?.ref) github.ref = payload.pipelineRef.ref;
    if (!github.repository && payload.pipelineRef?.repo) github.repository = payload.pipelineRef.repo;
    if (!github.event_name && run.trigger?.type) github.event_name = run.trigger.type;

    if (jobSpec.if !== undefined && jobSpec.if !== null) {
      try {
        const runJob = evaluateConditionSync(String(jobSpec.if).trim(), { github, stepOutcomes: [] });
        if (!runJob) {
          job.status = 'skipped';
          job.completedAt = new Date().toISOString();
          logLines('__job__', [`Job "${jobKey}" skipped (if: false)`]);
          this.enqueueDependentJobs(runId, jobKey);
          this.checkRunCompletion(runId);
          return;
        }
      } catch {
        job.status = 'failure';
        job.completedAt = new Date().toISOString();
        logLines('__job__', [`Job "${jobKey}" failed (invalid if expression)`]);
        this.store.updateRunStatus(runId, 'failure');
        return;
      }
    }

    if (run.status === 'queued') {
      this.store.updateRunStatus(runId, 'running');
    }

    job.status = 'running';
    job.startedAt = new Date().toISOString();

    logLines('__job__', [`Job "${jobKey}" started`]);

    const workspace = mkdtempSync(join(tmpdir(), `cifn-${runId}-${jobKey}-`));

    let jobFailed = false;

    const interpolateContext = {
      github,
      getSecret: this.getSecret ? (name: string) => this.getSecret!(runId, name) : undefined,
      workspaceRoot: workspace,
      hashFiles: (glob: string) => Promise.resolve(hashFiles(workspace, glob)),
    };

    if (jobSpec.env) {
      for (const [k, v] of Object.entries(jobSpec.env)) {
        try {
          const { result, secretValues: sv } = await interpolate(String(v), interpolateContext);
          jobEnv[k] = result;
          secretVals.push(...sv);
        } catch {
          jobEnv[k] = String(v);
        }
      }
    }

    try {
      for (let i = 0; i < jobSpec.steps.length; i++) {
        const stepSpec = jobSpec.steps[i];
        const step = job.steps[i];
        if (!step) continue;

        const effectiveIf = ('if' in stepSpec && stepSpec.if != null) ? String(stepSpec.if).trim() : 'success()';
        const stepOutcomes = job.steps.slice(0, i).map(s => s.status);
        try {
          const runStep = evaluateConditionSync(effectiveIf, { github, stepOutcomes });
          if (!runStep) {
            step.status = 'skipped';
            step.completedAt = new Date().toISOString();
            logLines(step.stepKey, [`Step "${step.stepKey}" skipped (if: false)`]);
            continue;
          }
        } catch {
          step.status = 'failure';
          step.completedAt = new Date().toISOString();
          logLines(step.stepKey, [`Step "${step.stepKey}" failed (invalid if expression)`]);
          jobFailed = true;
          continue;
        }

        if ('uses' in stepSpec) {
          if (stepSpec.uses === 'checkout') {
            step.status = 'running';
            step.startedAt = new Date().toISOString();
            logLines(step.stepKey, [
              `Step "${step.stepKey}" started: checkout`,
            ]);

            const repo = (stepSpec.with?.repository as string) ?? payload.pipelineRef?.repo ?? '';
            const ref = (stepSpec.with?.ref as string) ?? payload.pipelineRef?.ref ?? 'main';
            const token = stepSpec.with?.token as string | undefined;

            const checkoutResult = executeCheckout({ repo, ref, workspace, token });
            logLines(step.stepKey, checkoutResult.lines);

            if (checkoutResult.success) {
              step.status = 'success';
              step.completedAt = new Date().toISOString();
              logLines(step.stepKey, [
                `Step "${step.stepKey}" completed successfully`,
              ]);
            } else {
              step.status = 'failure';
              step.completedAt = new Date().toISOString();
              logLines(step.stepKey, [
                `Step "${step.stepKey}" failed: ${checkoutResult.error}`,
              ]);
              jobFailed = true;
            }
            continue;
          }

          if (stepSpec.uses === 'artifact/upload' && this.fileFnClient) {
            step.status = 'running';
            step.startedAt = new Date().toISOString();
            let artName = (stepSpec.with?.name as string) ?? 'default';
            let artPath = (stepSpec.with?.path as string) ?? '.';
            try {
              const nameRes = await interpolate(artName, interpolateContext);
              artName = nameRes.result;
              secretVals.push(...nameRes.secretValues);
              const pathRes = await interpolate(artPath, interpolateContext);
              artPath = pathRes.result;
              secretVals.push(...pathRes.secretValues);
            } catch {
              step.status = 'failure';
              step.completedAt = new Date().toISOString();
              logLines(step.stepKey, [`Step "${step.stepKey}" failed: interpolation error`]);
              jobFailed = true;
              continue;
            }
            logLines(step.stepKey, [
              `Step "${step.stepKey}" started: artifact/upload "${artName}"`,
            ]);

            const uploadResult = await executeArtifactUpload({
              name: artName, path: artPath, workspace, runId, fileFnClient: this.fileFnClient,
            });
            logLines(step.stepKey, uploadResult.lines);

            if (uploadResult.success) {
              if (uploadResult.fileId && this.artifactStore) {
                this.artifactStore.addArtifact(runId, { name: artName, fileId: uploadResult.fileId });
              }
              step.status = 'success';
              step.completedAt = new Date().toISOString();
              logLines(step.stepKey, [
                `Step "${step.stepKey}" completed successfully`,
              ]);
            } else {
              step.status = 'failure';
              step.completedAt = new Date().toISOString();
              logLines(step.stepKey, [
                `Step "${step.stepKey}" failed: ${uploadResult.error}`,
              ]);
              jobFailed = true;
            }
            continue;
          }

          if (stepSpec.uses === 'artifact/download' && this.fileFnClient) {
            step.status = 'running';
            step.startedAt = new Date().toISOString();
            let artName = (stepSpec.with?.name as string) ?? 'default';
            try {
              const nameRes = await interpolate(artName, interpolateContext);
              artName = nameRes.result;
              secretVals.push(...nameRes.secretValues);
            } catch {
              step.status = 'failure';
              step.completedAt = new Date().toISOString();
              logLines(step.stepKey, [`Step "${step.stepKey}" failed: interpolation error`]);
              jobFailed = true;
              continue;
            }
            logLines(step.stepKey, [
              `Step "${step.stepKey}" started: artifact/download "${artName}"`,
            ]);

            const downloadResult = await executeArtifactDownload({
              name: artName, workspace, runId, fileFnClient: this.fileFnClient,
            });
            logLines(step.stepKey, downloadResult.lines);

            if (downloadResult.success) {
              step.status = 'success';
              step.completedAt = new Date().toISOString();
              logLines(step.stepKey, [
                `Step "${step.stepKey}" completed successfully`,
              ]);
            } else {
              step.status = 'failure';
              step.completedAt = new Date().toISOString();
              logLines(step.stepKey, [
                `Step "${step.stepKey}" failed: ${downloadResult.error}`,
              ]);
              jobFailed = true;
            }
            continue;
          }

          if (stepSpec.uses === 'cache/save' && this.fileFnClient) {
            step.status = 'running';
            step.startedAt = new Date().toISOString();
            let cacheKey = (stepSpec.with?.key as string) ?? '';
            try {
              const keyRes = await interpolate(cacheKey, interpolateContext);
              cacheKey = keyRes.result;
              secretVals.push(...keyRes.secretValues);
            } catch {
              step.status = 'failure';
              step.completedAt = new Date().toISOString();
              logLines(step.stepKey, [`Step "${step.stepKey}" failed: interpolation error`]);
              jobFailed = true;
              continue;
            }
            const cachePaths = (stepSpec.with?.paths as string[]) ?? [];
            logLines(step.stepKey, [
              `Step "${step.stepKey}" started: cache/save "${cacheKey}"`,
            ]);

            const saveResult = await executeCacheSave({
              key: cacheKey, paths: cachePaths, workspace, fileFnClient: this.fileFnClient,
            });
            logLines(step.stepKey, saveResult.lines);

            step.status = saveResult.success ? 'success' : 'failure';
            step.completedAt = new Date().toISOString();
            if (!saveResult.success) {
              logLines(step.stepKey, [
                `Step "${step.stepKey}" failed: ${saveResult.error}`,
              ]);
              jobFailed = true;
            } else {
            logLines(step.stepKey, [
              `Step "${step.stepKey}" completed successfully`,
            ]);
            }
            continue;
          }

          if (stepSpec.uses === 'cache/restore' && this.fileFnClient) {
            step.status = 'running';
            step.startedAt = new Date().toISOString();
            let cacheKey = (stepSpec.with?.key as string) ?? '';
            try {
              const keyRes = await interpolate(cacheKey, interpolateContext);
              cacheKey = keyRes.result;
              secretVals.push(...keyRes.secretValues);
            } catch {
              step.status = 'failure';
              step.completedAt = new Date().toISOString();
              logLines(step.stepKey, [`Step "${step.stepKey}" failed: interpolation error`]);
              jobFailed = true;
              continue;
            }
            logLines(step.stepKey, [
              `Step "${step.stepKey}" started: cache/restore "${cacheKey}"`,
            ]);

            const restoreResult = await executeCacheRestore({
              key: cacheKey, workspace, fileFnClient: this.fileFnClient,
            });
            logLines(step.stepKey, restoreResult.lines);

            step.status = 'success';
            step.completedAt = new Date().toISOString();
            logLines(step.stepKey, [
              `Step "${step.stepKey}" completed successfully${restoreResult.hit ? ' (cache hit)' : ' (cache miss)'}`,
            ]);
            continue;
          }

          if (stepSpec.uses === 'testfn/run') {
            step.status = 'running';
            step.startedAt = new Date().toISOString();
            const framework = stepSpec.with?.framework as string | undefined;
            const testPattern = stepSpec.with?.testPattern as string | undefined;
            const reporter = stepSpec.with?.reporter as string | undefined;
            const outputPath = stepSpec.with?.outputPath as string | undefined;
            const parallel = stepSpec.with?.parallel as number | 'auto' | undefined;
            const timeout = stepSpec.with?.timeout as number | undefined;
            const retries = stepSpec.with?.retries as number | undefined;
            logLines(step.stepKey, [
              `Step "${step.stepKey}" started: testfn/run`,
            ]);

            const { executeTestFnRunAsync } = await import('./steps/testfn-run.js');
            const testResult = await executeTestFnRunAsync({
              framework,
              testPattern,
              reporter,
              outputPath,
              workspace,
              env: jobEnv,
              parallel,
              timeout,
              retries,
            });
            logLines(step.stepKey, testResult.lines);

            if (testResult.success) {
              step.status = 'success';
              step.completedAt = new Date().toISOString();
              logLines(step.stepKey, [
                `Step "${step.stepKey}" completed successfully`,
              ]);
            } else {
              step.status = 'failure';
              step.completedAt = new Date().toISOString();
              logLines(step.stepKey, [
                `Step "${step.stepKey}" failed: ${testResult.error}`,
              ]);
              jobFailed = true;
            }
            continue;
          }

          if (stepSpec.uses === 'hostfn/deploy') {
            step.status = 'running';
            step.startedAt = new Date().toISOString();
            const environment = (stepSpec.with?.environment as string) ?? '';
            const ci = (stepSpec.with?.ci as boolean) ?? true;
            const local = typeof stepSpec.with?.local === 'boolean'
              ? (stepSpec.with.local as boolean)
              : jobSpec['runs-on'] === 'hostfn-runner';
            logLines(step.stepKey, [
              `Step "${step.stepKey}" started: hostfn/deploy ${environment}`,
            ]);

            const deployResult = executeHostFnDeploy({
              environment, ci, local, workspace, env: jobEnv,
            });
            logLines(step.stepKey, deployResult.lines);

            if (deployResult.success) {
              step.status = 'success';
              step.completedAt = new Date().toISOString();
              logLines(step.stepKey, [
                `Step "${step.stepKey}" completed successfully`,
              ]);
            } else {
              step.status = 'failure';
              step.completedAt = new Date().toISOString();
              logLines(step.stepKey, [
                `Step "${step.stepKey}" failed: ${deployResult.error}`,
              ]);
              jobFailed = true;
            }
            continue;
          }

          step.status = 'skipped';
          logLines(step.stepKey, [
            `Step "${step.stepKey}" skipped (unsupported uses: ${stepSpec.uses})`,
          ]);
          continue;
        }

        step.status = 'running';
        step.startedAt = new Date().toISOString();

        let runCommand = stepSpec.run;
        try {
          const runRes = await interpolate(stepSpec.run, interpolateContext);
          runCommand = runRes.result;
          secretVals.push(...runRes.secretValues);
        } catch {
          step.status = 'failure';
          step.completedAt = new Date().toISOString();
          logLines(step.stepKey, [`Step "${step.stepKey}" failed: interpolation error`]);
          jobFailed = true;
          continue;
        }

        logLines(step.stepKey, [
          `Step "${step.stepKey}" started: ${runCommand}`,
        ]);

        const result = this.executeRunCommand(runCommand, workspace, jobSpec, jobEnv);

        logLines(step.stepKey, result.lines);

        if (result.exitCode === 0) {
          step.status = 'success';
          step.completedAt = new Date().toISOString();
          logLines(step.stepKey, [
            `Step "${step.stepKey}" completed successfully`,
          ]);
        } else {
          step.status = 'failure';
          step.completedAt = new Date().toISOString();
          logLines(step.stepKey, [
            `Step "${step.stepKey}" failed with exit code ${result.exitCode}`,
          ]);
          jobFailed = true;
        }
      }
    } finally {
      if (this.cleanWorkspace) {
        try {
          rmSync(workspace, { recursive: true, force: true });
        } catch {
          // ignore cleanup errors
        }
      }
    }

    job.completedAt = new Date().toISOString();

    if (jobFailed) {
      job.status = 'failure';
      logLines('__job__', [`Job "${jobKey}" failed`]);
      this.store.updateRunStatus(runId, 'failure');
    } else {
      job.status = 'success';
      logLines('__job__', [`Job "${jobKey}" completed successfully`]);
      await this.enqueueDependentJobs(runId, jobKey);
      this.checkRunCompletion(runId);
    }
  }

  private executeRunCommand(
    command: string,
    workspace: string,
    jobSpec: JobPayload['jobSpec'],
    env?: Record<string, string>,
  ) {
    if (this.shouldUseDocker(jobSpec) && this.dockerExecutor) {
      return this.dockerExecutor.execute({
        image: jobSpec.image ?? this.defaultDockerImage,
        workspace,
        command,
        env,
      });
    }

    return executeRunStep(command, workspace, env);
  }

  private shouldUseDocker(jobSpec: JobPayload['jobSpec']): boolean {
    if (!this.dockerExecutor) return false;
    if (typeof jobSpec.image === 'string' && jobSpec.image.length > 0) return true;
    if (jobSpec['runs-on'] === 'default' && this.dockerForDefault) return true;
    return this.dockerRunOnLabels.has(jobSpec['runs-on']);
  }

  private async enqueueDependentJobs(runId: string, completedJobKey: string): Promise<void> {
    const spec = this.pipelineSpecs.get(runId);
    if (!spec) return;

    const run = this.store.getRun(runId);
    if (!run) return;

    const completedJobs = new Set(
      run.jobs.filter(j => j.status === 'success' || j.status === 'skipped').map(j => j.jobKey)
    );
    const enqueuedJobs = new Set(
      run.jobs.filter(j => j.status !== 'pending').map(j => j.jobKey)
    );

    const readyJobs = getReadyJobs(spec, completedJobs, enqueuedJobs);

    for (const readyJobKey of readyJobs) {
      const jobSpec = spec.jobs[readyJobKey];
      if (jobSpec) {
        await this.queue.enqueue(this.queueName, {
          runId,
          jobKey: readyJobKey,
          jobSpec,
        });
      }
    }
  }

  private checkRunCompletion(runId: string): void {
    const run = this.store.getRun(runId);
    if (!run) return;

    const allDone = run.jobs.every(j =>
      j.status === 'success' || j.status === 'failure' || j.status === 'skipped'
    );

    if (allDone) {
      const anyFailure = run.jobs.some(j => j.status === 'failure');
      this.store.updateRunStatus(runId, anyFailure ? 'failure' : 'success');
    }
  }
}

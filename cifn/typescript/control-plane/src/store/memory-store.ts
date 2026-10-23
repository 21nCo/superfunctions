import { createRunRecord } from './records.js';
import type { ControlPlaneStore } from './store.js';
import { randomUUID } from 'node:crypto';
import type { Run, RunStatus, JobStatus, StepStatus, Job, Step, PipelineSpec, TriggerType } from '../pipeline/types.js';

export interface CreateRunInput {
  pipelineSpec: PipelineSpec;
  pipelineRef?: { repo: string; ref: string; configPath?: string };
  trigger: { type: TriggerType; payload?: Record<string, unknown> };
}

export interface ListRunsOptions {
  limit?: number;
  cursor?: string;
  status?: RunStatus;
}

export interface ListRunsResult {
  runs: Run[];
  nextCursor?: string;
}

export interface Artifact {
  name: string;
  fileId: string;
  url?: string;
}

export interface Runner {
  id: string;
  labels: string[];
  lastSeenAt: string;
  secretHash: string;
}

const TERMINAL_STATUSES: RunStatus[] = ['success', 'failure', 'cancelled'];

export class MemoryStore implements ControlPlaneStore {
  private runs: Map<string, Run> = new Map();
  private runOrder: string[] = [];
  private artifacts: Map<string, Artifact[]> = new Map();
  private runners: Map<string, Runner> = new Map();
  private secretValuesPerRun: Map<string, string[]> = new Map();

  createRun(input: CreateRunInput): Run {
    const run = createRunRecord(input);
    const runId = run.id;
    this.runs.set(runId, run);
    this.runOrder.unshift(runId);
    return run;
  }

  getRun(runId: string): Run | undefined {
    return this.runs.get(runId);
  }

  listRuns(options: ListRunsOptions = {}): ListRunsResult {
    const limit = Math.min(Math.max(options.limit ?? 20, 1), 100);
    let filteredIds = this.runOrder;

    if (options.status) {
      filteredIds = filteredIds.filter(id => {
        const run = this.runs.get(id);
        return run && run.status === options.status;
      });
    }

    let startIndex = 0;
    if (options.cursor) {
      const cursorIndex = filteredIds.indexOf(options.cursor);
      if (cursorIndex === -1) {
        return { runs: [] };
      }
      startIndex = cursorIndex + 1;
    }

    const slice = filteredIds.slice(startIndex, startIndex + limit);
    const runs = slice.map(id => this.runs.get(id)!);
    const hasMore = startIndex + limit < filteredIds.length;

    return {
      runs,
      nextCursor: hasMore ? slice[slice.length - 1] : undefined,
    };
  }

  updateRunStatus(runId: string, status: RunStatus): Run | undefined {
    const run = this.runs.get(runId);
    if (!run) return undefined;
    if (TERMINAL_STATUSES.includes(run.status)) return undefined;
    run.status = status;
    run.updatedAt = new Date().toISOString();
    
    // Notify on status change hook (callback will be set externally)
    if (this.onRunStatusChange) {
      this.onRunStatusChange(run);
    }
    
    return run;
  }

  private onRunStatusChange?: (run: Run) => void;

  setRunStatusChangeCallback(callback: (run: Run) => void) {
    this.onRunStatusChange = callback;
  }

  cancelRun(runId: string): { run?: Run; error?: 'NOT_FOUND' | 'ALREADY_FINISHED' } {
    const run = this.runs.get(runId);
    if (!run) return { error: 'NOT_FOUND' };
    if (TERMINAL_STATUSES.includes(run.status)) return { error: 'ALREADY_FINISHED' };
    run.status = 'cancelled';
    run.updatedAt = new Date().toISOString();
    return { run };
  }

  updateJobStatus(runId: string, jobKey: string, status: JobStatus, startedAt?: string, completedAt?: string): Job | undefined {
    const run = this.runs.get(runId);
    if (!run) return undefined;
    const job = run.jobs.find(j => j.jobKey === jobKey);
    if (!job) return undefined;
    job.status = status;
    if (startedAt) job.startedAt = startedAt;
    if (completedAt) job.completedAt = completedAt;
    run.updatedAt = new Date().toISOString();
    return job;
  }

  updateStepStatus(runId: string, jobKey: string, stepKey: string, status: StepStatus, startedAt?: string, completedAt?: string): Step | undefined {
    const run = this.runs.get(runId);
    if (!run) return undefined;
    const job = run.jobs.find(j => j.jobKey === jobKey);
    if (!job) return undefined;
    const step = job.steps.find(s => s.stepKey === stepKey);
    if (!step) return undefined;
    step.status = status;
    if (startedAt) step.startedAt = startedAt;
    if (completedAt) step.completedAt = completedAt;
    run.updatedAt = new Date().toISOString();
    return step;
  }

  addArtifact(runId: string, artifact: Artifact): void {
    const list = this.artifacts.get(runId) ?? [];
    list.push(artifact);
    this.artifacts.set(runId, list);
  }

  getArtifacts(runId: string): Artifact[] {
    return this.artifacts.get(runId) ?? [];
  }

  createRunner(labels: string[] = [], secretHash: string): Runner {
    const runnerId = randomUUID();
    const runner: Runner = {
      id: runnerId,
      labels,
      lastSeenAt: new Date().toISOString(),
      secretHash,
    };
    this.runners.set(runnerId, runner);
    return runner;
  }

  getRunner(runnerId: string): Runner | undefined {
    return this.runners.get(runnerId);
  }

  updateRunnerLastSeen(runnerId: string): void {
    const runner = this.runners.get(runnerId);
    if (runner) {
      runner.lastSeenAt = new Date().toISOString();
    }
  }

  registerJobSecretValues(runId: string, jobKey: string, secretValues: string[]): void {
    const existing = this.secretValuesPerRun.get(runId) ?? [];
    this.secretValuesPerRun.set(runId, [...existing, ...secretValues]);
  }

  getSecretValues(runId: string): string[] {
    return this.secretValuesPerRun.get(runId) ?? [];
  }
}

import type { Run, RunStatus, Job, JobStatus, Step, StepStatus } from '../pipeline/types.js';
import type { Artifact, Runner, CreateRunInput, ListRunsOptions, ListRunsResult } from './memory-store.js';

/** Memory implementations may be synchronous; durable implementations commit before resolving. */
export type StoreResult<T> = T | Promise<T>;
export interface ControlPlaneStore {
  createRun(input: CreateRunInput): StoreResult<Run>;
  getRun(runId: string): StoreResult<Run | undefined>;
  listRuns(options?: ListRunsOptions): StoreResult<ListRunsResult>;
  updateRunStatus(runId: string, status: RunStatus): StoreResult<Run | undefined>;
  setRunStatusChangeCallback(callback: (run: Run) => void): void;
  cancelRun(runId: string): StoreResult<{ run?: Run; error?: 'NOT_FOUND' | 'ALREADY_FINISHED' }>;
  updateJobStatus(runId: string, jobKey: string, status: JobStatus, startedAt?: string, completedAt?: string): StoreResult<Job | undefined>;
  updateStepStatus(runId: string, jobKey: string, stepKey: string, status: StepStatus, startedAt?: string, completedAt?: string): StoreResult<Step | undefined>;
  addArtifact(runId: string, artifact: Artifact): StoreResult<void>;
  getArtifacts(runId: string): StoreResult<Artifact[]>;
  createRunner(labels: string[], secretHash: string): StoreResult<Runner>;
  getRunner(runnerId: string): StoreResult<Runner | undefined>;
  updateRunnerLastSeen(runnerId: string): StoreResult<void>;
  registerJobSecretValues(runId: string, jobKey: string, secretValues: string[]): StoreResult<void>;
  getSecretValues(runId: string): StoreResult<string[]>;
}

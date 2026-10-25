export type TriggerType = 'push' | 'pull_request' | 'schedule' | 'workflow_dispatch';

export interface PushTrigger {
  branches?: string[];
}

export interface PullRequestTrigger {
  branches?: string[];
}

export interface ScheduleTrigger {
  cron: string;
}

export type WorkflowDispatchTrigger = Record<string, never>;

export interface OnTriggers {
  push?: PushTrigger;
  pull_request?: PullRequestTrigger;
  /** Canonical form: array of schedule entries. Parser normalizes object form to single-element array. */
  schedule?: ScheduleTrigger[];
  workflow_dispatch?: WorkflowDispatchTrigger;
}

export type StepUsesType =
  | 'checkout'
  | 'cache/restore'
  | 'cache/save'
  | 'artifact/upload'
  | 'artifact/download'
  | 'testfn/run'
  | 'hostfn/deploy';

export interface RunStep {
  run: string;
  if?: string;
}

export interface UsesStep {
  uses: StepUsesType;
  with?: Record<string, unknown>;
  if?: string;
}

export type StepSpec = RunStep | UsesStep;

export interface JobSpec {
  'runs-on': string;
  image?: string;
  needs?: string[];
  if?: string;
  env?: Record<string, string>;
  steps: StepSpec[];
}

export interface PipelineSpec {
  name?: string;
  on: OnTriggers;
  env?: Record<string, string>;
  jobs: Record<string, JobSpec>;
}

export type RunStatus = 'queued' | 'running' | 'success' | 'failure' | 'cancelled';
export type JobStatus = 'pending' | 'running' | 'success' | 'failure' | 'skipped';
export type StepStatus = 'pending' | 'running' | 'success' | 'failure' | 'skipped';

export interface Step {
  id: string;
  jobId: string;
  stepKey: string;
  status: StepStatus;
  logRef?: string;
  startedAt?: string;
  completedAt?: string;
}

export interface Job {
  id: string;
  runId: string;
  jobKey: string;
  status: JobStatus;
  steps: Step[];
  startedAt?: string;
  completedAt?: string;
}

export interface Run {
  id: string;
  pipelineRef: { repo: string; ref: string; configPath?: string };
  trigger: { type: TriggerType; payload?: Record<string, unknown> };
  status: RunStatus;
  createdAt: string;
  updatedAt: string;
  jobs: Job[];
}

export interface ValidationSuccess {
  ok: true;
  spec: PipelineSpec;
}

export interface ValidationError {
  ok: false;
  code: 'PIPELINE_INVALID';
  message: string;
  details?: Record<string, unknown>;
}

export type ValidationResult = ValidationSuccess | ValidationError;

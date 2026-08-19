import type { AdminOperationContext } from "@superfunctions/admin";

export type CiFnRunStatus =
  | "queued"
  | "running"
  | "success"
  | "failure"
  | "cancelled";

export type CiFnJobStatus =
  | "pending"
  | "running"
  | "success"
  | "failure"
  | "skipped";

export type CiFnStepStatus = CiFnJobStatus;

export interface CiFnPipelineRef {
  repo: string;
  ref: string;
  configPath?: string;
}

export interface CiFnStepView {
  id: string;
  stepKey: string;
  status: CiFnStepStatus;
  startedAt?: string;
  completedAt?: string;
}

export interface CiFnJobView {
  id: string;
  runId: string;
  jobKey: string;
  status: CiFnJobStatus;
  steps: CiFnStepView[];
  startedAt?: string;
  completedAt?: string;
}

export interface CiFnRunView {
  runId: string;
  pipelineRef: CiFnPipelineRef;
  trigger: {
    type: "push" | "pull_request" | "schedule" | "workflow_dispatch";
    payload?: Record<string, unknown>;
  };
  status: CiFnRunStatus;
  createdAt: string;
  updatedAt: string;
  jobs: CiFnJobView[];
}

export interface CiFnLogLineView {
  id: string;
  runId: string;
  jobKey: string;
  line: string;
  timestamp: string;
  stepKey: string;
}

export interface CiFnArtifactView {
  id: string;
  runId: string;
  name: string;
  fileId: string;
  url?: string;
  signedExternal?: boolean;
}

export interface CiFnListRunsInput {
  cursor?: string;
  limit?: number;
  filter?: { status?: CiFnRunStatus };
}

export interface CiFnListRunsOutput {
  items: CiFnRunView[];
  nextCursor: string | null;
}

export interface CiFnGetRunInput {
  id: string;
}

export interface CiFnGetRunOutput {
  item: CiFnRunView;
}

export interface CiFnListJobsInput {
  filter: { runId: string };
}

export interface CiFnListJobsOutput {
  items: CiFnJobView[];
  nextCursor: null;
}

export interface CiFnGetJobInput {
  id: string;
}

export interface CiFnGetJobOutput {
  item: CiFnJobView;
}

export interface CiFnListLogsInput {
  filter: { runId: string; jobKey: string };
  cursor?: string;
  limit?: number;
  tail?: number;
}

export interface CiFnListLogsOutput {
  items: CiFnLogLineView[];
  nextCursor: string | null;
  capabilities: { follow: true; download: false };
  followIntervalMs: number;
}

export interface CiFnListArtifactsInput {
  filter: { runId: string };
}

export interface CiFnListArtifactsOutput {
  items: CiFnArtifactView[];
  nextCursor: null;
}

export interface CiFnTriggerRunInput {
  trigger?: {
    type: "push" | "pull_request" | "schedule" | "workflow_dispatch";
    payload?: Record<string, unknown>;
  };
  pipelineRef?: CiFnPipelineRef;
  pipelineSpec?: Record<string, unknown>;
}

export interface CiFnTriggerRunOutput {
  accepted: true;
  runId: string;
  status: CiFnRunStatus;
  createdAt: string;
  operationReference: string;
}

export interface CiFnRunTargetInput {
  id: string;
  reason?: string;
}

export interface CiFnRunMutationOutput {
  accepted: true;
  runId: string;
  status: CiFnRunStatus;
  operationReference: string;
}

export interface CiFnRetryRunOutput extends CiFnTriggerRunOutput {
  retriedRunId: string;
}

export interface CiFnDownloadArtifactInput {
  id: string;
  runId: string;
}

export interface CiFnDownloadArtifactOutput {
  accepted: true;
  artifactId: string;
  downloadUrl: string;
  signedExternal: boolean;
  operationReference: string;
}

/**
 * Function-owned boundary implemented by CiFn, not by the console shell. Every
 * method receives the authorized administration context so a connector can
 * route to the correct isolated control-plane installation.
 */
export interface CiFnAdminService {
  listRuns(input: CiFnListRunsInput, context: AdminOperationContext): Promise<CiFnListRunsOutput>;
  getRun(input: CiFnGetRunInput, context: AdminOperationContext): Promise<CiFnGetRunOutput>;
  listJobs(input: CiFnListJobsInput, context: AdminOperationContext): Promise<CiFnListJobsOutput>;
  getJob(input: CiFnGetJobInput, context: AdminOperationContext): Promise<CiFnGetJobOutput>;
  listLogs(input: CiFnListLogsInput, context: AdminOperationContext): Promise<CiFnListLogsOutput>;
  listArtifacts(input: CiFnListArtifactsInput, context: AdminOperationContext): Promise<CiFnListArtifactsOutput>;
  triggerRun(input: CiFnTriggerRunInput, context: AdminOperationContext): Promise<CiFnTriggerRunOutput>;
  retryRun(input: CiFnRunTargetInput, context: AdminOperationContext): Promise<CiFnRetryRunOutput>;
  cancelRun(input: CiFnRunTargetInput, context: AdminOperationContext): Promise<CiFnRunMutationOutput>;
  downloadArtifact(input: CiFnDownloadArtifactInput, context: AdminOperationContext): Promise<CiFnDownloadArtifactOutput>;
}

import type {
  AdminClient,
  AdminClientRequestOptions,
  AdminOperationResult,
} from "@superfunctions/admin";
import { ciFnAdminCapability } from "./capability.js";
import type {
  CiFnDownloadArtifactInput,
  CiFnDownloadArtifactOutput,
  CiFnGetJobInput,
  CiFnGetJobOutput,
  CiFnGetRunInput,
  CiFnGetRunOutput,
  CiFnListArtifactsInput,
  CiFnListArtifactsOutput,
  CiFnListJobsInput,
  CiFnListJobsOutput,
  CiFnListLogsInput,
  CiFnListLogsOutput,
  CiFnListRunsInput,
  CiFnListRunsOutput,
  CiFnRetryRunOutput,
  CiFnRunMutationOutput,
  CiFnRunTargetInput,
  CiFnTriggerRunInput,
  CiFnTriggerRunOutput,
} from "./types.js";

export interface CiFnAdminClient {
  readonly manifest: typeof ciFnAdminCapability;
  listRuns(input?: CiFnListRunsInput, options?: AdminClientRequestOptions): Promise<AdminOperationResult<CiFnListRunsOutput>>;
  getRun(input: CiFnGetRunInput, options?: AdminClientRequestOptions): Promise<AdminOperationResult<CiFnGetRunOutput>>;
  listJobs(input: CiFnListJobsInput, options?: AdminClientRequestOptions): Promise<AdminOperationResult<CiFnListJobsOutput>>;
  getJob(input: CiFnGetJobInput, options?: AdminClientRequestOptions): Promise<AdminOperationResult<CiFnGetJobOutput>>;
  listLogs(input: CiFnListLogsInput, options?: AdminClientRequestOptions): Promise<AdminOperationResult<CiFnListLogsOutput>>;
  listArtifacts(input: CiFnListArtifactsInput, options?: AdminClientRequestOptions): Promise<AdminOperationResult<CiFnListArtifactsOutput>>;
  triggerRun(input: CiFnTriggerRunInput, options?: AdminClientRequestOptions): Promise<AdminOperationResult<CiFnTriggerRunOutput>>;
  retryRun(input: CiFnRunTargetInput, options?: AdminClientRequestOptions): Promise<AdminOperationResult<CiFnRetryRunOutput>>;
  cancelRun(input: CiFnRunTargetInput, options?: AdminClientRequestOptions): Promise<AdminOperationResult<CiFnRunMutationOutput>>;
  downloadArtifact(input: CiFnDownloadArtifactInput, options?: AdminClientRequestOptions): Promise<AdminOperationResult<CiFnDownloadArtifactOutput>>;
}

export function createCiFnAdminClient(adminClient: AdminClient): CiFnAdminClient {
  const invoke = <T>(operationId: string, input: unknown, options?: AdminClientRequestOptions) =>
    adminClient.invokeOperation<T>(operationId, input, options);
  return {
    manifest: ciFnAdminCapability,
    listRuns: (input = {}, options) => invoke("cifn.runs.list", input, options),
    getRun: (input, options) => invoke("cifn.runs.get", input, options),
    listJobs: (input, options) => invoke("cifn.jobs.list", input, options),
    getJob: (input, options) => invoke("cifn.jobs.get", input, options),
    listLogs: (input, options) => invoke("cifn.logs.list", input, options),
    listArtifacts: (input, options) => invoke("cifn.artifacts.list", input, options),
    triggerRun: (input, options) => invoke("cifn.runs.trigger-run", input, options),
    retryRun: (input, options) => invoke("cifn.runs.retry-run", input, options),
    cancelRun: (input, options) => invoke("cifn.runs.cancel-run", input, options),
    downloadArtifact: (input, options) => invoke("cifn.artifacts.download-artifact", input, options),
  };
}

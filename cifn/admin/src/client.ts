import {
  createCapabilityAdminClient,
  type CapabilityAdminClient,
  AdminClient,
  AdminClientRequestOptions,
  AdminOperationResult,
} from "@superfunctions/admin";
import { ciFnAdminCapability, type CiFnAdminOperationId } from "./capability.js";
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

export interface CiFnAdminClient extends CapabilityAdminClient<typeof ciFnAdminCapability> {
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
  const capability = createCapabilityAdminClient(ciFnAdminCapability, adminClient);
  const invoke = <T>(operationId: CiFnAdminOperationId, input: object, options?: AdminClientRequestOptions) =>
    adminClient.invokeOperation<T>(operationId, input, options);
  return Object.assign(capability, {
    listRuns: (input: CiFnListRunsInput = {}, options?: AdminClientRequestOptions) => invoke<CiFnListRunsOutput>("cifn.runs.list", input, options),
    getRun: (input: CiFnGetRunInput, options?: AdminClientRequestOptions) => invoke<CiFnGetRunOutput>("cifn.runs.get", input, options),
    listJobs: (input: CiFnListJobsInput, options?: AdminClientRequestOptions) => invoke<CiFnListJobsOutput>("cifn.jobs.list", input, options),
    getJob: (input: CiFnGetJobInput, options?: AdminClientRequestOptions) => invoke<CiFnGetJobOutput>("cifn.jobs.get", input, options),
    listLogs: (input: CiFnListLogsInput, options?: AdminClientRequestOptions) => invoke<CiFnListLogsOutput>("cifn.logs.list", input, options),
    listArtifacts: (input: CiFnListArtifactsInput, options?: AdminClientRequestOptions) => invoke<CiFnListArtifactsOutput>("cifn.artifacts.list", input, options),
    triggerRun: (input: CiFnTriggerRunInput, options?: AdminClientRequestOptions) => invoke<CiFnTriggerRunOutput>("cifn.runs.trigger-run", input, options),
    retryRun: (input: CiFnRunTargetInput, options?: AdminClientRequestOptions) => invoke<CiFnRetryRunOutput>("cifn.runs.retry-run", input, options),
    cancelRun: (input: CiFnRunTargetInput, options?: AdminClientRequestOptions) => invoke<CiFnRunMutationOutput>("cifn.runs.cancel-run", input, options),
    downloadArtifact: (input: CiFnDownloadArtifactInput, options?: AdminClientRequestOptions) => invoke<CiFnDownloadArtifactOutput>("cifn.artifacts.download-artifact", input, options),
  });
}

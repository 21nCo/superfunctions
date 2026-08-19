import {
  createAdminCapabilityAdapter as createKernelAdminCapabilityAdapter,
  type AdminCapabilityAdapter,
} from "@superfunctions/admin";
import { ciFnAdminCapability } from "./capability.js";
import type {
  CiFnAdminService,
  CiFnDownloadArtifactInput,
  CiFnGetJobInput,
  CiFnGetRunInput,
  CiFnListArtifactsInput,
  CiFnListJobsInput,
  CiFnListLogsInput,
  CiFnListRunsInput,
  CiFnRunTargetInput,
  CiFnTriggerRunInput,
} from "./types.js";

export function createCiFnAdminAdapter(
  service: CiFnAdminService,
): AdminCapabilityAdapter<typeof ciFnAdminCapability> {
  return createKernelAdminCapabilityAdapter(ciFnAdminCapability, {
    "cifn.runs.list": ({ input, context }) => service.listRuns(input as CiFnListRunsInput, context),
    "cifn.runs.get": ({ input, context }) => service.getRun(input as CiFnGetRunInput, context),
    "cifn.jobs.list": ({ input, context }) => service.listJobs(input as CiFnListJobsInput, context),
    "cifn.jobs.get": ({ input, context }) => service.getJob(input as CiFnGetJobInput, context),
    "cifn.logs.list": ({ input, context }) => service.listLogs(input as CiFnListLogsInput, context),
    "cifn.artifacts.list": ({ input, context }) => service.listArtifacts(input as CiFnListArtifactsInput, context),
    "cifn.runs.trigger-run": ({ input, context }) => service.triggerRun(input as CiFnTriggerRunInput, context),
    "cifn.runs.retry-run": ({ input, context }) => service.retryRun(input as CiFnRunTargetInput, context),
    "cifn.runs.cancel-run": ({ input, context }) => service.cancelRun(input as CiFnRunTargetInput, context),
    "cifn.artifacts.download-artifact": ({ input, context }) => service.downloadArtifact(input as CiFnDownloadArtifactInput, context),
  });
}

export const createAdminAdapter = createCiFnAdminAdapter;

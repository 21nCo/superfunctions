import {
  createCapabilityAdminClient,
  type AdminClient,
  type AdminClientRequestOptions,
} from "@superfunctions/admin";
import { probeFnAdminCapability } from "./capability.js";
import type {
  ProbeFnCaptureCheckpointInput,
  ProbeFnCaptureDeltaBaselineInput,
  ProbeFnDiffEventDeltaInput,
  ProbeFnExportReportInput,
  ProbeFnGetCheckpointPathsInput,
  ProbeFnGetRunPathsInput,
  ProbeFnGetSessionInput,
  ProbeFnInitializeSessionInput,
  ProbeFnMarkSessionRunningInput,
  ProbeFnSessionTargetInput,
} from "./types.js";

/** Function-scoped TypeScript client with named methods for every supported ProbeFn operation. */
export function createProbeFnAdminClient(adminClient: AdminClient) {
  const client = createCapabilityAdminClient(probeFnAdminCapability, adminClient);
  return Object.assign(client, {
    sessions: {
      get: (input: ProbeFnGetSessionInput, options?: AdminClientRequestOptions) =>
        client.invoke("probefn.sessions.get", input, options),
      initialize: (input: ProbeFnInitializeSessionInput, options?: AdminClientRequestOptions) =>
        client.invoke("probefn.sessions.initialize", input, options),
      markRunning: (input: ProbeFnMarkSessionRunningInput, options?: AdminClientRequestOptions) =>
        client.invoke("probefn.sessions.mark-running", input, options),
      markCompleted: (input: ProbeFnSessionTargetInput, options?: AdminClientRequestOptions) =>
        client.invoke("probefn.sessions.mark-completed", input, options),
      markFailed: (input: ProbeFnSessionTargetInput, options?: AdminClientRequestOptions) =>
        client.invoke("probefn.sessions.mark-failed", input, options),
    },
    eventDeltas: {
      captureBaseline: (input: ProbeFnCaptureDeltaBaselineInput, options?: AdminClientRequestOptions) =>
        client.invoke("probefn.event-deltas.capture-baseline", input, options),
      diff: (input: ProbeFnDiffEventDeltaInput, options?: AdminClientRequestOptions) =>
        client.invoke("probefn.event-deltas.diff", input, options),
    },
    checkpoints: {
      capture: (input: ProbeFnCaptureCheckpointInput, options?: AdminClientRequestOptions) =>
        client.invoke("probefn.checkpoints.capture", input, options),
    },
    reports: {
      export: (input: ProbeFnExportReportInput, options?: AdminClientRequestOptions) =>
        client.invoke("probefn.reports.export", input, options),
    },
    storage: {
      getRunPaths: (input: ProbeFnGetRunPathsInput, options?: AdminClientRequestOptions) =>
        client.invoke("probefn.storage.get-run-paths", input, options),
      getCheckpointPaths: (input: ProbeFnGetCheckpointPathsInput, options?: AdminClientRequestOptions) =>
        client.invoke("probefn.storage.get-checkpoint-paths", input, options),
    },
  });
}

import {
  createAdminCapabilityAdapter as createKernelAdminCapabilityAdapter,
  type AdminCapabilityAdapter,
  type AdminOperationContext,
  type AdminOperationRequest,
} from "@superfunctions/admin";
import { probeFnAdminCapability } from "./capability.js";
import type { ProbeFnAdminService } from "./types.js";

function bind<TInput, TOutput>(
  handler: (input: TInput, context: AdminOperationContext) => Promise<TOutput>,
) {
  return ({ input, context }: AdminOperationRequest) => handler(input as TInput, context);
}

/** Maps each truthful manifest operation to one explicit ProbeFn domain method. */
export function createProbeFnAdminAdapter(
  service: ProbeFnAdminService,
): AdminCapabilityAdapter<typeof probeFnAdminCapability> {
  return createKernelAdminCapabilityAdapter(probeFnAdminCapability, {
    "probefn.sessions.get": bind(service.getSession),
    "probefn.sessions.initialize": bind(service.initializeSession),
    "probefn.sessions.mark-running": bind(service.markSessionRunning),
    "probefn.sessions.mark-completed": bind(service.markSessionCompleted),
    "probefn.sessions.mark-failed": bind(service.markSessionFailed),
    "probefn.event-deltas.capture-baseline": bind(service.captureDeltaBaseline),
    "probefn.event-deltas.diff": bind(service.diffEventDelta),
    "probefn.checkpoints.capture": bind(service.captureCheckpoint),
    "probefn.reports.export": bind(service.exportReport),
    "probefn.storage.get-run-paths": bind(service.getRunPaths),
    "probefn.storage.get-checkpoint-paths": bind(service.getCheckpointPaths),
  });
}

export const createAdminAdapter = createProbeFnAdminAdapter;

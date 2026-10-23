import {
  createAdminCapabilityAdapter as createKernelAdminCapabilityAdapter,
  type AdminCapabilityAdapter,
  type AdminOperationContext,
  type AdminOperationRequest,
} from "@superfunctions/admin";
import { testFnAdminCapability } from "./capability.js";
import type { TestFnAdminService } from "./types.js";

function bind<TInput, TOutput>(
  service: TestFnAdminService,
  handler: (input: TInput, context: AdminOperationContext) => Promise<TOutput>,
) {
  return ({ input, context }: AdminOperationRequest) =>
    handler.call(service, input as TInput, context);
}

/** Maps every manifest operation to one explicit typed TestFn domain method. */
export function createTestFnAdminAdapter(
  service: TestFnAdminService,
): AdminCapabilityAdapter<typeof testFnAdminCapability> {
  return createKernelAdminCapabilityAdapter(testFnAdminCapability, {
    "testfn.runs.list": bind(service, service.listRuns),
    "testfn.runs.get": bind(service, service.getRun),
    "testfn.runs.start": bind(service, service.startRun),
    "testfn.runs.cleanup": bind(service, service.cleanupRuns),
    "testfn.artifacts.get": bind(service, service.getArtifact),
    "testfn.analytics.metrics": bind(service, service.getMetrics),
    "testfn.analytics.flakiness": bind(service, service.getFlakiness),
    "testfn.analytics.trends": bind(service, service.getTrends),
    "testfn.analytics.regressions": bind(service, service.getRegressions),
    "testfn.visual-diffs.get": bind(service, service.getVisualDiff),
    "testfn.visual-diffs.compare": bind(service, service.compareScreenshot),
    "testfn.visual-baselines.update": bind(service, service.updateBaseline),
  });
}

export const createAdminAdapter = createTestFnAdminAdapter;

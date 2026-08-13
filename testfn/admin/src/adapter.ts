import {
  createAdminCapabilityAdapter as createKernelAdminCapabilityAdapter,
  type AdminCapabilityAdapter,
  type AdminOperationContext,
  type AdminOperationRequest,
} from "@superfunctions/admin";
import { testFnAdminCapability } from "./capability.js";
import type { TestFnAdminService } from "./types.js";

function bind<TInput, TOutput>(
  handler: (input: TInput, context: AdminOperationContext) => Promise<TOutput>,
) {
  return ({ input, context }: AdminOperationRequest) => handler(input as TInput, context);
}

/** Maps every manifest operation to one explicit typed TestFn domain method. */
export function createTestFnAdminAdapter(
  service: TestFnAdminService,
): AdminCapabilityAdapter<typeof testFnAdminCapability> {
  return createKernelAdminCapabilityAdapter(testFnAdminCapability, {
    "testfn.runs.list": bind(service.listRuns),
    "testfn.runs.get": bind(service.getRun),
    "testfn.runs.start": bind(service.startRun),
    "testfn.runs.cleanup": bind(service.cleanupRuns),
    "testfn.artifacts.get": bind(service.getArtifact),
    "testfn.analytics.metrics": bind(service.getMetrics),
    "testfn.analytics.flakiness": bind(service.getFlakiness),
    "testfn.analytics.trends": bind(service.getTrends),
    "testfn.analytics.regressions": bind(service.getRegressions),
    "testfn.visual-diffs.get": bind(service.getVisualDiff),
    "testfn.visual-diffs.compare": bind(service.compareScreenshot),
    "testfn.visual-baselines.update": bind(service.updateBaseline),
  });
}

export const createAdminAdapter = createTestFnAdminAdapter;

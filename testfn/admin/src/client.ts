import {
  createCapabilityAdminClient,
  type AdminClient,
  type AdminClientRequestOptions,
} from "@superfunctions/admin";
import { testFnAdminCapability } from "./capability.js";
import type {
  TestFnCleanupRunsInput,
  TestFnFlakinessInput,
  TestFnIdInput,
  TestFnListRunsInput,
  TestFnRegressionsInput,
  TestFnScreenshotInput,
  TestFnTrendsInput,
  TestFnUpdateBaselineInput,
} from "./types.js";

/** Function-scoped SDK with named methods for every truthful TestFn operation. */
export function createTestFnAdminClient(adminClient: AdminClient) {
  const client = createCapabilityAdminClient(testFnAdminCapability, adminClient);
  return Object.assign(client, {
    runs: {
      list: (input: TestFnListRunsInput = {}, options?: AdminClientRequestOptions) => client.invoke("testfn.runs.list", input, options),
      get: (input: TestFnIdInput, options?: AdminClientRequestOptions) => client.invoke("testfn.runs.get", input, options),
      start: (options?: AdminClientRequestOptions) => client.invoke("testfn.runs.start", {}, options),
      cleanup: (input: TestFnCleanupRunsInput, options?: AdminClientRequestOptions) => client.invoke("testfn.runs.cleanup", input, options),
    },
    artifacts: {
      get: (input: TestFnIdInput, options?: AdminClientRequestOptions) => client.invoke("testfn.artifacts.get", input, options),
    },
    analytics: {
      metrics: (input: TestFnIdInput, options?: AdminClientRequestOptions) => client.invoke("testfn.analytics.metrics", input, options),
      flakiness: (input: TestFnFlakinessInput, options?: AdminClientRequestOptions) => client.invoke("testfn.analytics.flakiness", input, options),
      trends: (input: TestFnTrendsInput, options?: AdminClientRequestOptions) => client.invoke("testfn.analytics.trends", input, options),
      regressions: (input: TestFnRegressionsInput, options?: AdminClientRequestOptions) => client.invoke("testfn.analytics.regressions", input, options),
    },
    visual: {
      getDiff: (input: TestFnIdInput, options?: AdminClientRequestOptions) => client.invoke("testfn.visual-diffs.get", input, options),
      compare: (input: TestFnScreenshotInput, options?: AdminClientRequestOptions) => client.invoke("testfn.visual-diffs.compare", input, options),
      updateBaseline: (input: TestFnUpdateBaselineInput, options?: AdminClientRequestOptions) => client.invoke("testfn.visual-baselines.update", input, options),
    },
  });
}

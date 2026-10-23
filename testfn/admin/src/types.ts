import type {
  ComparisonResult,
  EnvironmentInfo,
  FlakyAnalysis,
  Regression,
  RunMetrics,
  TestRunner,
  TestRunSummary,
  TestStorage,
  TrendData,
  VisualTester,
} from "@testfn/core";
import type { AdminOperationContext } from "@superfunctions/admin";

export interface TestFnListRunsInput {
  limit?: number;
}

export interface TestFnIdInput {
  id: string;
}

export interface TestFnFlakinessInput extends TestFnIdInput {
  windowSize?: number;
}

export interface TestFnTrendsInput extends TestFnIdInput {
  days?: number;
}

export interface TestFnRegressionsInput {
  baselineRunId: string;
  currentRunId: string;
}

export interface TestFnStartRunInput {}

export interface TestFnCleanupRunsInput {
  id: "expired";
  reason: string;
}

export interface TestFnScreenshotInput {
  id: string;
  screenshotBase64: string;
}

export interface TestFnUpdateBaselineInput extends TestFnScreenshotInput {
  reason: string;
}

export interface TestFnAdminResult {
  id: string;
  status: "passed" | "failed" | "skipped" | "timeout";
  duration: number;
  hasError: boolean;
  artifactTypes: string[];
}

export interface TestFnAdminRun {
  id: string;
  timestamp: number;
  summary: TestRunSummary;
  results: TestFnAdminResult[];
  environment?: EnvironmentInfo;
  branch?: string;
  commit?: string;
}

export interface TestFnListRunsOutput {
  items: TestFnAdminRun[];
  nextCursor: null;
}

export interface TestFnRunOutput {
  item: TestFnAdminRun;
}

export interface TestFnArtifactOutput {
  item: {
    id: string;
    type: string;
    available: true;
  };
}

export interface TestFnMetricsOutput {
  item: RunMetrics & { id: string };
}

export interface TestFnFlakinessOutput {
  item: FlakyAnalysis & { id: string };
}

export interface TestFnTrendsOutput {
  item: TrendData & { id: string };
}

export interface TestFnRegressionsOutput {
  items: Regression[];
}

export interface TestFnVisualDiffOutput {
  item: {
    id: string;
    available: boolean;
    sizeBytes: number;
  };
}

export interface TestFnComparisonOutput {
  item: Omit<ComparisonResult, "diffImage"> & { id: string };
}

export interface TestFnAcceptedOutput {
  accepted: true;
}

export interface TestFnAdminService {
  listRuns(input: TestFnListRunsInput, context: AdminOperationContext): Promise<TestFnListRunsOutput>;
  getRun(input: TestFnIdInput, context: AdminOperationContext): Promise<TestFnRunOutput>;
  startRun(input: TestFnStartRunInput, context: AdminOperationContext): Promise<TestFnRunOutput>;
  cleanupRuns(input: TestFnCleanupRunsInput, context: AdminOperationContext): Promise<TestFnAcceptedOutput>;
  getArtifact(input: TestFnIdInput, context: AdminOperationContext): Promise<TestFnArtifactOutput>;
  getMetrics(input: TestFnIdInput, context: AdminOperationContext): Promise<TestFnMetricsOutput>;
  getFlakiness(input: TestFnFlakinessInput, context: AdminOperationContext): Promise<TestFnFlakinessOutput>;
  getTrends(input: TestFnTrendsInput, context: AdminOperationContext): Promise<TestFnTrendsOutput>;
  getRegressions(input: TestFnRegressionsInput, context: AdminOperationContext): Promise<TestFnRegressionsOutput>;
  getVisualDiff(input: TestFnIdInput, context: AdminOperationContext): Promise<TestFnVisualDiffOutput>;
  compareScreenshot(input: TestFnScreenshotInput, context: AdminOperationContext): Promise<TestFnComparisonOutput>;
  updateBaseline(input: TestFnUpdateBaselineInput, context: AdminOperationContext): Promise<TestFnAcceptedOutput>;
}

/** One coherent set of TestFn objects, already isolated to exactly one admin scope. */
export interface TestFnDomainAdminBinding {
  runner: TestRunner;
  storage: TestStorage;
  visual: VisualTester;
  environment: EnvironmentInfo;
}

export interface TestFnDomainAdminServiceOptions {
  /** Resolve configured domain objects for the complete active scope. Objects cannot be reused across scopes. */
  resolve(context: AdminOperationContext): TestFnDomainAdminBinding | Promise<TestFnDomainAdminBinding>;
}

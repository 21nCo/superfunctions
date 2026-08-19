import type {
  CheckpointCaptureSource,
  CreatedCheckpoint,
  EventDeltaBaseline,
  EventDeltaSummary,
  SessionState,
} from "@probefn/core";
import type {
  BrowserEngine,
  DeterministicSettings,
  SessionMode,
} from "@probefn/contracts";
import type {
  CheckpointPaths,
  RunPaths,
  StorageCaps,
} from "@probefn/storage";
import type { AdminOperationContext } from "@superfunctions/admin";

export interface ProbeFnAdminScope {
  installationId: string;
  workspaceId: string;
  projectId: string;
  environmentId: string;
  namespace?: string;
  region?: string;
}

export interface ProbeFnGetSessionInput {
  id: string;
}

export interface ProbeFnInitializeSessionInput {
  sessionId: string;
  runId: string;
  mode: SessionMode;
  browser: BrowserEngine;
  deterministic: DeterministicSettings;
  startedAt: string;
  resolvedUrl?: string;
}

export interface ProbeFnMarkSessionRunningInput {
  id: string;
  resolvedUrl?: string;
}

export interface ProbeFnSessionTargetInput {
  id: string;
}

export interface ProbeFnSessionOutput {
  item: SessionState;
}

export interface ProbeFnCaptureDeltaBaselineInput {
  sessionId: string;
}

export interface ProbeFnCaptureDeltaBaselineOutput {
  sessionId: string;
  baseline: EventDeltaBaseline;
}

export interface ProbeFnDiffEventDeltaInput {
  before: EventDeltaBaseline;
  after: EventDeltaBaseline;
}

export interface ProbeFnDiffEventDeltaOutput {
  delta: EventDeltaSummary;
}

export interface ProbeFnCaptureCheckpointInput {
  sessionId: string;
  name: string;
  before: EventDeltaBaseline;
  includeStyles?: boolean;
  includeTrace?: boolean;
  unstable?: boolean;
}

export interface ProbeFnCaptureCheckpointOutput {
  accepted: true;
  item: CreatedCheckpoint;
}

export interface ProbeFnExportReportInput {
  sessionId: string;
  format: "json" | "markdown";
}

export interface ProbeFnExportReportOutput {
  accepted: true;
  sessionId: string;
  format: "json" | "markdown";
  reportPath: string;
  tracePath: string | null;
  redactedValueCount: number;
  warnings: string[];
  includes: string[];
}

export interface ProbeFnGetRunPathsInput {
  runId: string;
}

export interface ProbeFnGetRunPathsOutput {
  item: RunPaths;
}

export interface ProbeFnGetCheckpointPathsInput {
  runId: string;
  name: string;
}

export interface ProbeFnGetCheckpointPathsOutput {
  item: CheckpointPaths;
}

export interface ProbeFnCheckpointSourceRequest {
  input: ProbeFnCaptureCheckpointInput;
  session: SessionState;
  context: AdminOperationContext;
}

export interface ProbeFnAdminBindingConfig {
  /** Exact environment that owns this repository/artifact store pair. */
  scope: ProbeFnAdminScope;
  /** Absolute repository root for this one configured environment. */
  repoRoot: string;
  /** Repository-relative artifact root; defaults to `.artifacts`. */
  artifactRoot?: string;
  storageCaps?: Partial<StorageCaps>;
  /** Resolves the already-authorized live capture source for this environment. */
  checkpointSource(
    request: ProbeFnCheckpointSourceRequest,
  ): CheckpointCaptureSource | Promise<CheckpointCaptureSource>;
}

export interface ProbeFnDomainAdminServiceOptions {
  /** Static, exact scope bindings. Wildcards and implicit fallback are not supported. */
  bindings: readonly ProbeFnAdminBindingConfig[];
}

export interface ProbeFnAdminService {
  getSession(input: ProbeFnGetSessionInput, context: AdminOperationContext): Promise<ProbeFnSessionOutput>;
  initializeSession(input: ProbeFnInitializeSessionInput, context: AdminOperationContext): Promise<ProbeFnSessionOutput>;
  markSessionRunning(input: ProbeFnMarkSessionRunningInput, context: AdminOperationContext): Promise<ProbeFnSessionOutput>;
  markSessionCompleted(input: ProbeFnSessionTargetInput, context: AdminOperationContext): Promise<ProbeFnSessionOutput>;
  markSessionFailed(input: ProbeFnSessionTargetInput, context: AdminOperationContext): Promise<ProbeFnSessionOutput>;
  captureDeltaBaseline(input: ProbeFnCaptureDeltaBaselineInput, context: AdminOperationContext): Promise<ProbeFnCaptureDeltaBaselineOutput>;
  diffEventDelta(input: ProbeFnDiffEventDeltaInput, context: AdminOperationContext): Promise<ProbeFnDiffEventDeltaOutput>;
  captureCheckpoint(input: ProbeFnCaptureCheckpointInput, context: AdminOperationContext): Promise<ProbeFnCaptureCheckpointOutput>;
  exportReport(input: ProbeFnExportReportInput, context: AdminOperationContext): Promise<ProbeFnExportReportOutput>;
  getRunPaths(input: ProbeFnGetRunPathsInput, context: AdminOperationContext): Promise<ProbeFnGetRunPathsOutput>;
  getCheckpointPaths(input: ProbeFnGetCheckpointPathsInput, context: AdminOperationContext): Promise<ProbeFnGetCheckpointPathsOutput>;
}

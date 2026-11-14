export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type RetrievalStatus = "available" | "truncated" | "permission_denied" | "deleted" | "unsupported" | "failed";
export type RequirementStatus = "implemented" | "partial" | "missing" | "unverified" | "not_applicable";
export type ExecutionStatus = "queued" | "running" | "completed" | "failed" | "canceled" | "superseded";
export type CoverageStatus = "complete" | "incomplete";
export type Verdict = "ready" | "changes_requested" | "needs_verification";
export type FindingLifecycle = "new" | "still_valid" | "resolved" | "superseded" | "needs_revalidation";
export type FindingSeverity = "critical" | "high" | "medium" | "low" | "info";

export interface SourceReference {
  sourceId: string;
  anchor: string;
  excerpt?: string;
}

export interface ContextSource {
  id: string;
  type: "issue" | "comment" | "document" | "repository_markdown" | "other";
  canonicalUrl?: string;
  workspace?: string;
  retrievedAt: string;
  providerVersion?: string;
  updatedAt?: string;
  digest: string;
  status: RetrievalStatus;
  content?: string;
  parentId?: string;
  error?: string;
}

export interface ContextManifest {
  version: 1;
  sources: ContextSource[];
  selection: { candidates: string[]; selected: string[]; rule: string };
  limits: { maxSources: number; maxBytes: number; maxDepth: number };
  incompleteReasons: string[];
  digest: string;
}

export interface CodeAnchor {
  commit: string;
  path: string;
  startLine?: number;
  endLine?: number;
  symbol?: string;
}

export interface Evidence {
  id: string;
  kind: "source" | "code" | "diff" | "test" | "artifact";
  description: string;
  source?: SourceReference;
  code?: CodeAnchor;
  receiptId?: string;
  artifactDigest?: string;
  sourceExclusionReason?: string;
}

export interface Requirement {
  id: string;
  statement: string;
  sources: SourceReference[];
  category: "behavior" | "architecture" | "compatibility" | "test" | "migration" | "documentation" | "non_goal" | "other";
  scope: string;
  classification: "mandatory" | "advisory";
  dependencies: string[];
  ambiguity?: string;
  extraction: { harness: string; promptDigest: string };
}

export interface Assessment {
  requirementId: string;
  status: RequirementStatus;
  evidenceIds: string[];
  reasoning: string;
  gaps: string[];
  confidence: number;
  waiverReference?: SourceReference;
}

export interface Finding {
  fingerprint: string;
  severity: FindingSeverity;
  category: string;
  title: string;
  trigger: string;
  impact: string;
  direction: string;
  anchor?: CodeAnchor;
  evidenceIds: string[];
  basis: "reproduced" | "inferred";
  requirementIds: string[];
  lifecycle: FindingLifecycle;
}

export interface TestReceipt {
  id: string;
  command: string[];
  cwd: string;
  commit: string;
  startedAt: string;
  finishedAt: string;
  runtimeMs: number;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  canceled: boolean;
  stdoutArtifact?: string;
  stderrArtifact?: string;
  stdoutDigest: string;
  stderrDigest: string;
  limitations: string[];
}

export interface ChangeSnapshot {
  repositoryId: string;
  host: string;
  pullRequest?: number;
  targetBranch: string;
  baseCommit: string;
  headCommit: string;
  mergeBaseCommit: string;
  diffDigest: string;
  changedPaths: string[];
  capturedAt: string;
}

/** One zero-context unified-diff hunk header, as emitted by `git diff -U0`. */
export interface ChangeHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
}

export interface ChangeHunkFile {
  /** Head-side path; the removed path for deletions. */
  path: string;
  /** Base-side path of a rename. */
  previousPath?: string;
  /** Binary files have no hunks and are uninspectable for line-level evidence. */
  status: "added" | "modified" | "deleted" | "renamed" | "binary";
  hunks: ChangeHunk[];
}

/** Hunk-level model of `git diff --find-renames -U0 <baseCommit> <headCommit>`; files are sorted by path. */
export interface ChangeHunks {
  version: 1;
  /** The commit the diff starts from: the merge base for the full change, or `since` for a delta. */
  baseCommit: string;
  headCommit: string;
  files: ChangeHunkFile[];
}

/** Outcome of capturing change hunks; diffs over the byte limit are not parsed. */
export type ChangeHunksCapture =
  | { status: "parsed"; hunks: ChangeHunks }
  | { status: "too_large"; limitBytes: number };

/** Content-addressed `change-hunks` artifacts for the reviewed change and, for incremental runs, the delta. */
export interface ChangeDetail {
  hunksArtifact: string;
  hunksDigest: string;
  since?: string;
  deltaHunksArtifact?: string;
  deltaHunksDigest?: string;
  /** Changed paths of `since..head`; each must be inspected or explicitly uninspected. */
  deltaPaths?: string[];
}

export interface RunConfigurationProvenance {
  schemaVersion: 1;
  policyDigest: string;
  promptDigest: string;
  harness: { id: string; version: string };
  inference: { provider: string; model: string; auth: string };
  execution: { adapter: string; timeoutMs: number; maxOutputBytes: number };
  contextAdapters: string[];
  reviewCategories?: Requirement["category"][];
  profile: string;
}

export interface ReviewReport {
  schemaVersion: 1;
  runId: string;
  attemptId: string;
  createdAt: string;
  change: ChangeSnapshot;
  contextManifestDigest: string;
  contextManifestArtifact: string;
  configuration: RunConfigurationProvenance;
  execution: ExecutionStatus;
  coverage: CoverageStatus;
  coverageReasons: string[];
  verdict?: Verdict;
  requirements: Requirement[];
  assessments: Assessment[];
  evidence: Evidence[];
  findings: Finding[];
  tests: TestReceipt[];
  inspectedPaths: string[];
  uninspected: Array<{ scope: string; reason: string }>;
  normalizedEventArtifact?: string;
  redactedTranscriptArtifact?: string;
  limitations: string[];
  changeDetail?: ChangeDetail;
}

export interface ReviewPolicy {
  version: 1;
  mode: "advisory" | "gate";
  requiredCategories: Requirement["category"][];
  blockingSeverities: FindingSeverity[];
  allowRepositoryTightening: boolean;
  sourceAuthority: { acceptedTypes: ContextSource["type"][]; commentsMayClarify: boolean; waiverAuthorities: string[] };
  limits: {
    contextMaxSources: number;
    contextMaxBytes: number;
    contextMaxDepth: number;
    harnessTimeoutMs: number;
    testTimeoutMs: number;
    maxOutputBytes: number;
    maxFindings: number;
  };
  retention: { reportDays: number; transcriptDays: number; testLogDays: number };
}

export interface ReviewFnConfig {
  version: 1;
  retainTranscript?: boolean;
  profile: string;
  harness: { adapter: string; version: string; executable?: string };
  inference: { provider: string; model: string; auth: string; credentialEnv?: string };
  context: Array<{ adapter: string; account?: string; expectedWorkspace?: string; issue?: string; paths?: string[] }>;
  review: { categories: Requirement["category"][]; evidenceRequired: boolean };
  execution: { adapter: string; tests: string[][]; timeoutMs: number; maxOutputBytes: number };
  output: { destinations: Array<"local" | "github">; mode: "advisory" | "gate" };
  retention: ReviewPolicy["retention"];
  fallback: Array<{ harness: string; provider: string; model: string; auth: string }>;
}

export interface HarnessCapabilities {
  id: string;
  version: string;
  providers: string[];
  authModes: string[];
  structuredOutput: boolean;
  observableEvents: boolean;
  usageMetrics: boolean;
  cancellation: boolean;
  toolControls: boolean;
  sandboxModes: string[];
}

export interface PreflightDiagnostic {
  code: string;
  level: "error" | "warning" | "info";
  message: string;
}

export interface PreflightResult {
  ok: boolean;
  resolved?: { provider: string; model: string; auth: string; harnessVersion: string };
  diagnostics: PreflightDiagnostic[];
}

export interface NormalizedRunEvent {
  sequence: number;
  at: string;
  type: "started" | "message" | "tool_started" | "tool_finished" | "usage" | "warning" | "error" | "completed" | "canceled";
  data: Record<string, JsonValue>;
}

export interface HarnessInput {
  runId: string;
  workspace: string;
  change: ChangeSnapshot;
  context: ContextManifest;
  policy: ReviewPolicy;
  configuration: ReviewFnConfig;
  testReceipts: TestReceipt[];
  prompt: string;
  /**
   * Structured-output JSON Schema for this run, such as the panel's `lensOutputSchema`. Absent means the 0.1
   * `harnessOutputSchema`. Outputs without `requirements` or `assessments` normalize them to empty arrays.
   */
  outputSchema?: Readonly<Record<string, unknown>>;
  signal?: AbortSignal;
}

export interface HarnessOutput {
  terminal: "completed" | "failed" | "canceled" | "quota_exhausted" | "timed_out" | "malformed";
  requirements: Requirement[];
  assessments: Assessment[];
  evidence: Evidence[];
  findings: Finding[];
  inspectedPaths: string[];
  uninspected: Array<{ scope: string; reason: string }>;
  events: NormalizedRunEvent[];
  transcript?: string;
  error?: string;
}

export interface ContextRequest {
  sourceAuthority?: ReviewPolicy["sourceAuthority"];
  root: string;
  issue?: string;
  account?: string;
  expectedWorkspace?: string;
  paths?: string[];
  limits: ContextManifest["limits"];
  signal?: AbortSignal;
}

export interface ContextAdapter {
  readonly id: string;
  preflight(request: ContextRequest): Promise<PreflightResult>;
  fetch(request: ContextRequest): Promise<Omit<ContextManifest, "digest">>;
}

export interface SourceControlAdapter {
  readonly id: string;
  capture(root: string, base: string, head: string, pullRequest?: number): Promise<ChangeSnapshot>;
  currentHead(root: string, pullRequest?: number): Promise<string>;
  verifyAnchor(root: string, anchor: CodeAnchor): Promise<boolean>;
  pathExists?(root: string, commit: string, path: string): Promise<boolean>;
  /** Capture `ChangeHunks` for `from..to` (full commit IDs) without parsing diffs over `maxBytes`. */
  changeHunks?(root: string, from: string, to: string, maxBytes: number, signal?: AbortSignal): Promise<ChangeHunksCapture>;
  /** Whether commit `ancestor` is an ancestor of, or equal to, commit `descendant`; false when either is not a commit. */
  isAncestor?(root: string, ancestor: string, descendant: string): Promise<boolean>;
}

export interface HarnessAdapter {
  readonly capabilities: HarnessCapabilities;
  preflight(config: ReviewFnConfig, signal?: AbortSignal): Promise<PreflightResult>;
  run(input: HarnessInput): Promise<HarnessOutput>;
}

export interface ExecutionAdapter {
  readonly id: string;
  preflight(root: string): Promise<PreflightResult>;
  run(root: string, headCommit: string, commands: string[][], policy: ReviewPolicy, signal?: AbortSignal): Promise<TestReceipt[]>;
}

export interface ArtifactStore {
  put(kind: string, content: string | Uint8Array, retentionDays: number): Promise<{ digest: string; id: string }>;
  get(id: string): Promise<Uint8Array | undefined>;
  deleteExpired(now?: Date): Promise<{ deleted: string[]; errors: string[] }>;
}

export interface PublishRequest {
  report: ReviewReport;
  rendered: string;
  expectedHead: string;
  profile: string;
}

export interface PublishResult {
  status: "published" | "updated" | "unchanged" | "stale" | "failed";
  reference?: string;
  error?: string;
}

export interface ReportPublisher {
  readonly id: string;
  preflight(): Promise<PreflightResult>;
  publish(request: PublishRequest): Promise<PublishResult>;
}

export interface ReviewRunRequest {
  root: string;
  base: string;
  head: string;
  pullRequest?: number;
  config: ReviewFnConfig;
  policy: ReviewPolicy;
  issue?: string;
  attemptId?: string;
  /** Previously reviewed head (full 40- or 64-hex commit) to scope an incremental review to `since..head`. */
  since?: string;
  signal?: AbortSignal;
}

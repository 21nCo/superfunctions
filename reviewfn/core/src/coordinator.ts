import { createAttemptId, digestJson } from "./canonical.js";
import { CHANGE_HUNKS_ARTIFACT_KIND, binaryChangePaths, changeHunkPaths, isCommitId, serializeChangeHunks, sinceRangeError } from "./change.js";
import { ReviewFnError } from "./errors.js";
import { findingFingerprint } from "./identity.js";
import { buildReviewPrompt, REVIEW_PROMPT_VERSION } from "./prompt.js";
import { collectSecrets, redactText, redactJson } from "./redaction.js";
import { combineContextManifests } from "./repository-context.js";
import { renderMarkdownReport } from "./render.js";
import type {
  ArtifactStore,
  ChangeDetail,
  ChangeHunks,
  ChangeSnapshot,
  ContextAdapter,
  ContextManifest,
  ContextSource,
  ExecutionAdapter,
  HarnessAdapter,
  HarnessOutput,
  PreflightDiagnostic,
  PublishResult,
  ReportPublisher,
  ReviewFnConfig,
  ReviewPolicy,
  ReviewReport,
  ReviewRunRequest,
  SourceControlAdapter,
  TestReceipt,
} from "./types.js";
import { validateHarnessPayload } from "./schema.js";
import { deriveVerdict, preflightPublishers, validateReport } from "./validator.js";

export interface CoordinatorDependencies {
  sourceControl: SourceControlAdapter;
  contexts: ContextAdapter[];
  harness: HarnessAdapter;
  execution: ExecutionAdapter;
  artifacts: ArtifactStore;
  publishers?: ReportPublisher[];
  now?: () => Date;
}

/** The adapters the single-harness review and the panel share for capture, context, execution and artifacts. */
export type SharedRunDependencies = Pick<CoordinatorDependencies, "sourceControl" | "contexts" | "execution" | "artifacts" | "now">;

export interface ReviewRunResult {
  report: ReviewReport;
  rendered: string;
  publications: PublishResult[];
  validation: { warnings: string[] };
}

/** Change detail captured once per run, with the parsed hunks the panel uses to scope its slots. */
export interface CapturedChangeDetail {
  detail?: ChangeDetail;
  /** Parsed hunks of `mergeBase..head`, present exactly when `detail` is. */
  hunks?: ChangeHunks;
  /** Parsed hunks of `since..head` for an incremental run, present exactly when `detail.since` is. */
  delta?: ChangeHunks;
  coverageReasons: string[];
  limitations: string[];
}

/** Inputs captured once per run: the change, its detail, the frozen context and the trusted test receipts. */
export interface PreparedReview {
  retention: ReviewPolicy["retention"];
  change: ChangeSnapshot;
  changeDetail: CapturedChangeDetail;
  context: ContextManifest;
  contextArtifact: { id: string; digest: string };
  tests: TestReceipt[];
  executionErrors: string[];
  executionPolicy: ReviewPolicy;
}

function failedContext(adapter: ContextAdapter, error: unknown, limits: ContextManifest["limits"], now: Date): Omit<ContextManifest, "digest"> {
  const message = error instanceof Error ? error.message : String(error);
  const source: ContextSource = { id: `${adapter.id}:failure`, type: "other", retrievedAt: now.toISOString(), digest: digestJson({ adapter: adapter.id, message }), status: "failed", error: message };
  return { version: 1, sources: [source], selection: { candidates: [], selected: [], rule: `${adapter.id} failed` }, limits, incompleteReasons: [`${adapter.id}: ${message}`] };
}

function terminalExecution(output: HarnessOutput): ReviewReport["execution"] {
  if (output.terminal === "completed") return "completed";
  if (output.terminal === "canceled") return "canceled";
  return "failed";
}

export function contextLimits(policy: ReviewPolicy): ContextManifest["limits"] {
  return { maxSources: policy.limits.contextMaxSources, maxBytes: policy.limits.contextMaxBytes, maxDepth: policy.limits.contextMaxDepth };
}

/** Retention is the stricter of the configuration and the trusted policy. */
export function effectiveRetention(config: ReviewFnConfig, policy: ReviewPolicy): ReviewPolicy["retention"] {
  return { reportDays: Math.min(config.retention.reportDays, policy.retention.reportDays), transcriptDays: Math.min(config.retention.transcriptDays, policy.retention.transcriptDays), testLogDays: Math.min(config.retention.testLogDays, policy.retention.testLogDays) };
}

/** Pull-request review with Codex requires action-proxy authentication. */
export function harnessAuthDiagnostics(request: Pick<ReviewRunRequest, "pullRequest">, harnessId: string, auth: string): PreflightDiagnostic[] {
  return request.pullRequest !== undefined && harnessId === "codex" && auth !== "action-proxy" ? [{ code: "REVIEWFN_PR_AUTH_REQUIRED", level: "error", message: "Pull-request review with Codex requires action-proxy authentication." }] : [];
}

/** Prefix a component's diagnostics with its ID and add a generic error when it refused without one. */
export function componentDiagnostics(componentId: string, result: { ok: boolean; diagnostics: PreflightDiagnostic[] }, refusal: string): PreflightDiagnostic[] {
  const diagnostics = result.diagnostics.map((diagnostic) => ({ ...diagnostic, message: `${componentId}: ${diagnostic.message}` }));
  if (!result.ok && !result.diagnostics.some(item => item.level === "error")) diagnostics.push({ code: "REVIEWFN_PREFLIGHT_FAILED", level: "error", message: refusal });
  return diagnostics;
}

export async function preflightContexts(dependencies: Pick<SharedRunDependencies, "contexts">, request: ReviewRunRequest): Promise<PreflightDiagnostic[]> {
  const diagnostics: PreflightDiagnostic[] = [];
  const contextById = new Map(dependencies.contexts.map((adapter) => [adapter.id, adapter]));
  for (const item of request.config.context) {
    const adapter = contextById.get(item.adapter);
    if (!adapter) { diagnostics.push({ code: "REVIEWFN_CONTEXT_ADAPTER_MISSING", level: "error", message: `Context adapter ${item.adapter} is not installed.` }); continue; }
    const result = await adapter.preflight({ root: request.root, issue: item.issue ?? request.issue, account: item.account, expectedWorkspace: item.expectedWorkspace, paths: item.paths, sourceAuthority: request.policy.sourceAuthority, limits: contextLimits(request.policy), signal: request.signal });
    if (!result.ok && !result.diagnostics.some(item => item.level === "error")) diagnostics.push({ code: "REVIEWFN_PREFLIGHT_FAILED", level: "error", message: `${adapter.id} preflight refused execution.` });
    diagnostics.push(...result.diagnostics.map((diagnostic) => ({ ...diagnostic, message: `${adapter.id}: ${diagnostic.message}` })));
  }
  return diagnostics;
}

export async function preflightExecution(dependencies: Pick<SharedRunDependencies, "execution">, request: ReviewRunRequest): Promise<PreflightDiagnostic[]> {
  return componentDiagnostics(dependencies.execution.id, await dependencies.execution.preflight(request.root), "Execution preflight refused execution.");
}

/** `since` must be a full commit ID, and source control must capture hunks and check ancestry. */
export function preflightSince(dependencies: Pick<SharedRunDependencies, "sourceControl">, request: ReviewRunRequest): PreflightDiagnostic[] {
  const diagnostics: PreflightDiagnostic[] = [];
  if (request.since === undefined) return diagnostics;
  if (!isCommitId(request.since)) diagnostics.push({ code: "REVIEWFN_SINCE_INVALID", level: "error", message: "since must be a full 40- or 64-hex commit ID." });
  if (!dependencies.sourceControl.changeHunks || !dependencies.sourceControl.isAncestor) diagnostics.push({ code: "REVIEWFN_SINCE_UNSUPPORTED", level: "error", message: `${dependencies.sourceControl.id} cannot capture change hunks or check ancestry, so an incremental review is not possible.` });
  return diagnostics;
}

export function fallbackDiagnostics(config: ReviewFnConfig): PreflightDiagnostic[] {
  return config.fallback.length ? [{ code: "REVIEWFN_FALLBACK_EXPLICIT", level: "info", message: "Fallbacks are declared but are never selected silently; an operator must rerun with the chosen compatible configuration." }] : [];
}

/**
 * Capture the change, its hunk-level detail, the frozen context and the trusted test receipts once for a run.
 * The single-harness review and the panel both prepare through this function.
 */
export async function prepareReview(dependencies: SharedRunDependencies, request: ReviewRunRequest): Promise<PreparedReview> {
  const retention = effectiveRetention(request.config, request.policy);
  const now = dependencies.now ?? (() => new Date());
  const change = await dependencies.sourceControl.capture(request.root, request.base, request.head, request.pullRequest);
  const changeDetail = await captureChangeDetail(dependencies, request, change, retention.reportDays);
  const limits = contextLimits(request.policy);
  const contextById = new Map(dependencies.contexts.map((adapter) => [adapter.id, adapter]));
  const manifests: Array<Omit<ContextManifest, "digest">> = [];
  for (const item of request.config.context) {
    const adapter = contextById.get(item.adapter) as ContextAdapter;
    try {
      manifests.push(await adapter.fetch({ root: request.root, issue: item.issue ?? request.issue, account: item.account, expectedWorkspace: item.expectedWorkspace, paths: item.paths, sourceAuthority: request.policy.sourceAuthority, limits, signal: request.signal }));
    } catch (error) {
      manifests.push(failedContext(adapter, error, limits, now()));
    }
  }
  const context = combineContextManifests(manifests, limits);
  const contextArtifact = await dependencies.artifacts.put("context-manifest", JSON.stringify(context, null, 2), retention.reportDays);

  const executionPolicy = { ...request.policy, retention, limits: { ...request.policy.limits, testTimeoutMs: Math.min(request.policy.limits.testTimeoutMs, request.config.execution.timeoutMs), maxOutputBytes: Math.min(request.policy.limits.maxOutputBytes, request.config.execution.maxOutputBytes) } };
  let tests: TestReceipt[] = [];
  const executionErrors: string[] = [];
  try { tests = await dependencies.execution.run(request.root, change.headCommit, request.config.execution.tests, executionPolicy, request.signal); }
  catch (error) { executionErrors.push(`Test execution failed: ${error instanceof Error ? error.message : String(error)}`); }
  return { retention, change, changeDetail, context, contextArtifact, tests, executionErrors, executionPolicy };
}

/** Content identity of a single-harness review: the same inputs give the same run ID across attempts. */
export function reviewRunId(prepared: Pick<PreparedReview, "change" | "context" | "tests">, request: Pick<ReviewRunRequest, "policy" | "config" | "since">, harnessVersion: string): string {
  const { capturedAt: _capturedAt, ...identityChange } = prepared.change;
  return digestJson({ change: identityChange, contextDigest: prepared.context.digest, policy: request.policy, config: request.config, harnessVersion, tests: prepared.tests.map(({ startedAt, finishedAt, runtimeMs, ...receipt }) => receipt), promptVersion: REVIEW_PROMPT_VERSION, ...(request.since === undefined ? {} : { since: request.since }) });
}

/** Values to redact from harness output: credential-like environment values plus the named credential variables. */
export function harnessSecrets(credentialEnvs: readonly (string | undefined)[], environment: NodeJS.ProcessEnv = process.env): string[] {
  return [...collectSecrets(environment), ...credentialEnvs.flatMap(name => name ? [environment[name] ?? ""] : [])];
}

const PAYLOAD_KEYS = ["requirements", "assessments", "evidence", "findings", "inspectedPaths", "uninspected"] as const;

/**
 * Validate, redact and fingerprint raw harness output. Invalid structured output becomes `malformed` with no findings;
 * an aborted run is `canceled`. Fingerprints come from the unredacted findings so redaction cannot merge or split them.
 */
export function normalizeHarnessOutput(raw: HarnessOutput, options: { secrets: readonly string[]; aborted: boolean; payloadErrors?: (payload: Record<string, unknown>) => string[] }): HarnessOutput {
  const payloadErrors = options.payloadErrors ?? validateHarnessPayload;
  let output = raw;
  const payload = (value: HarnessOutput) => Object.fromEntries(PAYLOAD_KEYS.map(key => [key, value?.[key]]));
  const rawErrors = payloadErrors(payload(output));
  const rawFingerprints = rawErrors.length ? [] : output.findings.map(findingFingerprint);
  if (output) output = redactJson(output, options.secrets);
  const errors = [...new Set([...rawErrors, ...payloadErrors(payload(output))])];
  if (errors.length) output = { terminal: "malformed", requirements: [], assessments: [], evidence: [], findings: [], inspectedPaths: [], uninspected: [{ scope: "structured output", reason: errors.join("; ") }], events: output?.events ?? [] };
  if (options.aborted) output.terminal = "canceled";
  output.findings = output.findings.map((finding, index) => ({ ...finding, fingerprint: rawFingerprints[index] }));
  return output;
}

/** What produced a single-harness report: its harness, the configuration and policy it ran under, and its prompt. */
export interface ReviewReportInput {
  request: ReviewRunRequest;
  prepared: PreparedReview;
  /** Output from `normalizeHarnessOutput`. */
  output: HarnessOutput;
  harness: { id: string; version: string };
  promptDigest: string;
  runId: string;
  attemptId: string;
  secrets: readonly string[];
  diagnostics: PreflightDiagnostic[];
}

/**
 * Build, validate and store a 0.1 review report from normalized harness output. A report that fails validation is
 * stored with incomplete coverage and its verdict re-derived, never discarded.
 */
export async function assembleReviewReport(dependencies: SharedRunDependencies, input: ReviewReportInput): Promise<{ report: ReviewReport; validation: { warnings: string[] } }> {
  const { request, prepared, output, secrets } = input;
  const { change, changeDetail, context, retention, tests, executionErrors, executionPolicy } = prepared;
  const now = dependencies.now ?? (() => new Date());
  output.requirements = output.requirements.map(requirement => ({ ...requirement, extraction: { harness: input.harness.id, promptDigest: input.promptDigest } }));
  const sourceIds = new Set(context.sources.map((source) => source.id));
  const unknownSources = [
    ...output.requirements.flatMap((requirement) => requirement.sources.map((source) => source.sourceId)),
    ...output.evidence.flatMap((evidence) => evidence.source ? [evidence.source.sourceId] : []),
  ].filter((sourceId) => !sourceIds.has(sourceId));
  if (unknownSources.length) output.uninspected.push({ scope: "context references", reason: `Unknown sources: ${[...new Set(unknownSources)].join(", ")}` });

  const eventArtifact = await dependencies.artifacts.put("normalized-events", JSON.stringify(redactJson(output.events, secrets), null, 2), retention.reportDays);
  const transcriptArtifact = request.config.retainTranscript && output.transcript ? await dependencies.artifacts.put("redacted-transcript", redactText(output.transcript, secrets), retention.transcriptDays) : undefined;
  const coverageReasons = [
    ...changeDetail.coverageReasons,
    ...context.incompleteReasons,
    ...executionErrors,
    ...(output.terminal === "completed" ? [] : [`Harness terminal outcome: ${output.terminal}${output.error ? ` (${output.error})` : ""}.`]),
    ...output.uninspected.map((item) => `Uninspected ${item.scope}: ${item.reason}`),
    ...tests.filter((receipt) => receipt.exitCode !== 0 || receipt.timedOut || receipt.canceled).map((receipt) => `Test ${receipt.id} did not pass (exit ${String(receipt.exitCode)}).`),
  ];
  const report: ReviewReport = {
    schemaVersion: 1,
    runId: input.runId,
    attemptId: input.attemptId,
    createdAt: now().toISOString(),
    change,
    contextManifestDigest: context.digest,
    contextManifestArtifact: prepared.contextArtifact.id,
    configuration: {
      schemaVersion: 1,
      policyDigest: digestJson(request.policy),
      promptDigest: input.promptDigest,
      harness: { id: input.harness.id, version: input.harness.version },
      inference: { provider: request.config.inference.provider, model: request.config.inference.model, auth: request.config.inference.auth },
      execution: { adapter: dependencies.execution.id, timeoutMs: executionPolicy.limits.testTimeoutMs, maxOutputBytes: executionPolicy.limits.maxOutputBytes },
      contextAdapters: request.config.context.map((item) => item.adapter),
      reviewCategories: [...request.config.review.categories],
      profile: request.config.profile,
    },
    execution: terminalExecution(output),
    coverage: coverageReasons.length ? "incomplete" : "complete",
    coverageReasons,
    requirements: output.requirements,
    assessments: output.assessments,
    evidence: output.evidence,
    findings: output.findings,
    tests,
    inspectedPaths: output.inspectedPaths,
    uninspected: output.uninspected,
    normalizedEventArtifact: eventArtifact.id,
    redactedTranscriptArtifact: transcriptArtifact?.id,
    limitations: [...input.diagnostics.filter((diagnostic) => diagnostic.level === "warning").map((diagnostic) => diagnostic.message), ...changeDetail.limitations],
  };
  if (changeDetail.detail) report.changeDetail = changeDetail.detail;
  report.verdict = deriveVerdict(report, request.policy);
  const validation = await validateReport(report, request.policy, dependencies.sourceControl, request.root, context, dependencies.artifacts);
  if (!validation.valid) {
    report.coverage = "incomplete";
    report.coverageReasons.push(...validation.errors);
    report.verdict = deriveVerdict(report, request.policy);
  }
  await dependencies.artifacts.put("review-report", JSON.stringify(report, null, 2), retention.reportDays);
  return { report, validation: { warnings: validation.warnings } };
}

export class ReviewCoordinator {
  public constructor(private readonly dependencies: CoordinatorDependencies) {}

  public async preflight(request: ReviewRunRequest): Promise<PreflightDiagnostic[]> {
    const harnessId = this.dependencies.harness.capabilities.id;
    const diagnostics: PreflightDiagnostic[] = [...harnessAuthDiagnostics(request, harnessId, request.config.inference.auth)];
    diagnostics.push(...await preflightContexts(this.dependencies, request));
    diagnostics.push(...componentDiagnostics(harnessId, await this.dependencies.harness.preflight(request.config, request.signal), "Harness preflight refused execution."));
    diagnostics.push(...await preflightExecution(this.dependencies, request));
    for (const message of await preflightPublishers(this.dependencies.publishers ?? [])) diagnostics.push({ code: "REVIEWFN_PUBLISHER_PREFLIGHT", level: "error", message });
    diagnostics.push(...preflightSince(this.dependencies, request));
    diagnostics.push(...fallbackDiagnostics(request.config));
    return diagnostics;
  }

  public async run(request: ReviewRunRequest): Promise<ReviewRunResult> {
    if (request.signal?.aborted) throw new ReviewFnError("REVIEWFN_CANCELED", "Review canceled before preflight.");
    const diagnostics = await this.preflight(request);
    const preflightErrors = diagnostics.filter((diagnostic) => diagnostic.level === "error");
    if (preflightErrors.length) throw new ReviewFnError("REVIEWFN_PREFLIGHT_FAILED", "Review preflight failed.", { diagnostics: preflightErrors });
    const prepared = await prepareReview(this.dependencies, request);
    const { change, context, tests } = prepared;
    const harness = this.dependencies.harness;
    const prompt = buildReviewPrompt({ change, context, config: request.config, policy: request.policy, tests });
    const runId = reviewRunId(prepared, request, harness.capabilities.version);
    const attemptId = request.attemptId ?? createAttemptId();
    let output: HarnessOutput;
    try {
      if (request.signal?.aborted) throw new Error("Review canceled before inference.");
      output = await harness.run({ runId, workspace: request.root, change, context, policy: request.policy, configuration: request.config, testReceipts: tests, prompt: prompt.prompt, signal: request.signal });
    } catch (error) {
      output = { terminal: request.signal?.aborted ? "canceled" : "failed", requirements: [], assessments: [], evidence: [], findings: [], inspectedPaths: [], uninspected: [{ scope: "review", reason: error instanceof Error ? error.message : String(error) }], events: [], error: error instanceof Error ? error.message : String(error) };
    }
    const secrets = harnessSecrets([request.config.inference.credentialEnv]);
    output = normalizeHarnessOutput(output, { secrets, aborted: request.signal?.aborted ?? false });
    const { report, validation } = await assembleReviewReport(this.dependencies, { request, prepared, output, harness: { id: harness.capabilities.id, version: harness.capabilities.version }, promptDigest: prompt.digest, runId, attemptId, secrets, diagnostics });
    const rendered = renderMarkdownReport(report);
    const publications: PublishResult[] = [];
    if (!request.signal?.aborted && report.execution === "completed" && (this.dependencies.publishers?.length ?? 0) > 0) {
      const currentHead = await this.dependencies.sourceControl.currentHead(request.root, request.pullRequest);
      if (currentHead !== change.headCommit) publications.push({ status: "stale", error: `Current head ${currentHead} differs from reviewed head ${change.headCommit}.` });
      else for (const publisher of this.dependencies.publishers ?? []) {
        if (request.signal?.aborted) break;
        try { publications.push(await publisher.publish({ report, rendered, expectedHead: change.headCommit, profile: request.config.profile })); }
        catch (error) { publications.push({ status: "failed", error: error instanceof Error ? error.message : String(error) }); }
      }
    }
    return { report, rendered, publications, validation };
  }
}

/**
 * Verify the incremental range and store hunk-level detail. An invalid `since` fails the run before any
 * context, test or harness work; a diff that cannot be parsed makes coverage incomplete, never a silent full review.
 */
export async function captureChangeDetail(dependencies: Pick<SharedRunDependencies, "sourceControl" | "artifacts">, request: ReviewRunRequest, change: ChangeSnapshot, retentionDays: number): Promise<CapturedChangeDetail> {
  const source = dependencies.sourceControl;
  const { since, root } = request;
  const coverageReasons: string[] = [];
  if (since !== undefined) {
    const isAncestor = source.isAncestor?.bind(source);
    const reason = isAncestor ? await sinceRangeError(since, change.mergeBaseCommit, change.headCommit, (ancestor, descendant) => isAncestor(root, ancestor, descendant)) : `${source.id} cannot check ancestry.`;
    if (reason) throw new ReviewFnError("REVIEWFN_SINCE_NOT_ANCESTOR", `Incremental review range is invalid: ${reason}`, { since, headCommit: change.headCommit, mergeBaseCommit: change.mergeBaseCommit });
  }
  const changeHunks = source.changeHunks?.bind(source);
  if (!changeHunks) return { coverageReasons, limitations: [] };
  const maxBytes = request.policy.limits.maxOutputBytes;
  const capture = async (label: string, from: string): Promise<ChangeHunks | undefined> => {
    const range = `${from}..${change.headCommit}`;
    try {
      const captured = await changeHunks(root, from, change.headCommit, maxBytes, request.signal);
      if (captured.status === "too_large") { coverageReasons.push(`${label} diff ${range} exceeds maxOutputBytes (${captured.limitBytes}) as raw or decoded UTF-8 bytes; its hunks were not parsed.`); return undefined; }
      if (captured.hunks.baseCommit !== from || captured.hunks.headCommit !== change.headCommit) { coverageReasons.push(`${label} hunks do not cover ${range}.`); return undefined; }
      return captured.hunks;
    } catch (error) {
      if (error instanceof ReviewFnError && error.code === "REVIEWFN_DIFF_UNSUPPORTED") { coverageReasons.push(`${label} diff ${range} could not be parsed: ${error.message}`); return undefined; }
      if (request.signal?.aborted) throw new ReviewFnError("REVIEWFN_CANCELED", "Review canceled while capturing change hunks.");
      throw error;
    }
  };
  const hunks = await capture("Change", change.mergeBaseCommit);
  const delta = since === undefined ? undefined : await capture("Incremental", since);
  if (!hunks || (since !== undefined && !delta)) {
    if (since !== undefined) coverageReasons.push(`Incremental review since ${since} has no recorded change detail.`);
    return { coverageReasons, limitations: [] };
  }
  // The artifact store may refuse large documents (FileArtifactStore caps artifact size); that leaves the
  // change detail unrecorded and coverage incomplete instead of failing a run that the diff alone allowed.
  let detail: ChangeDetail;
  try {
    const stored = await dependencies.artifacts.put(CHANGE_HUNKS_ARTIFACT_KIND, serializeChangeHunks(hunks), retentionDays);
    detail = { hunksArtifact: stored.id, hunksDigest: stored.digest };
    if (since !== undefined && delta) {
      const storedDelta = await dependencies.artifacts.put(CHANGE_HUNKS_ARTIFACT_KIND, serializeChangeHunks(delta), retentionDays);
      Object.assign(detail, { since, deltaHunksArtifact: storedDelta.id, deltaHunksDigest: storedDelta.digest, deltaPaths: changeHunkPaths(delta) });
    }
  } catch (error) {
    coverageReasons.push(`Change hunks could not be stored: ${error instanceof Error ? error.message : String(error)}`);
    if (since !== undefined) coverageReasons.push(`Incremental review since ${since} has no recorded change detail.`);
    return { coverageReasons, limitations: [] };
  }
  const limitations = [...new Set([...binaryChangePaths(hunks), ...(delta ? binaryChangePaths(delta) : [])])].map(path => `Binary file ${path} has no hunks; it is uninspectable for line-level evidence.`);
  return { detail, hunks, ...(since !== undefined && delta ? { delta } : {}), coverageReasons, limitations };
}

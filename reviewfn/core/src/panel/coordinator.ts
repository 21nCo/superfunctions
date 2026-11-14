import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createAttemptId, digestJson, stableStringify } from "../canonical.js";
import {
  assembleReviewReport, componentDiagnostics, fallbackDiagnostics, harnessAuthDiagnostics, harnessSecrets, normalizeHarnessOutput,
  preflightContexts, preflightExecution, preflightSince, prepareReview, type PreparedReview, type SharedRunDependencies,
} from "../coordinator.js";
import { ReviewFnError } from "../errors.js";
import { redactJson, redactText } from "../redaction.js";
import type { Evidence, Finding, HarnessCapabilities, HarnessInput, HarnessOutput, PreflightDiagnostic, PreflightResult, ReviewFnConfig, ReviewPolicy, ReviewReport, ReviewRunRequest } from "../types.js";
import { defaultLensRegistry, type LensRegistry } from "./lenses.js";
import { effectiveMaxConcurrentSlots } from "./policy.js";
import { buildSlotPrompt, PANEL_PROMPT_VERSION, type PriorStageFinding, type SlotScope } from "./prompt.js";
import { lensOutputSchema, validateLensPayload } from "./schema.js";
import type { PanelFinding, PanelFindingSeverity, PanelPolicy, PanelReport, PanelReportValidationResult, PanelSlot, SlotIdentity, SlotRun, SlotRunTerminal, SlotVoidReason } from "./types.js";
import { credentialFingerprint, derivePanelVerdict, panelPolicyDigest, panelStructureIssues, slotIdentityKey, validatePanelPolicy, validatePanelReport } from "./validate.js";
import { GitSlotWorkspaceProvider, removeTree, type GitSlotWorkspaceOptions, type SlotWorkspace, type SlotWorkspaceProvider, type WorkspaceCheck } from "./workspace.js";

/** Coverage reason code when a stage has fewer completed runs with distinct identities than its quorum. */
export const PANEL_QUORUM_UNMET = "REVIEWFN_PANEL_QUORUM_UNMET";
export const PANEL_SLOT_OUTPUT_ARTIFACT_KIND = "panel-slot-output";
export const PANEL_REPORT_ARTIFACT_KIND = "panel-report";
const DEFAULT_ABORT_GRACE_MS = 10_000;
const DEFAULT_COMPARISON_TIMEOUT_MS = 60_000;
const CANCELED_REASON = "The panel run was canceled.";
/** The terminal outcomes a harness may report; `void` and `collapsed` are decided by the panel, never by a harness. */
const HARNESS_TERMINALS: ReadonlySet<string> = new Set<HarnessOutput["terminal"]>(["completed", "failed", "canceled", "quota_exhausted", "timed_out", "malformed"]);
const MAX_LISTED_PATHS = 20;
/** The harness version recorded when neither preflight nor the adapter reported one; it never matches a pin. */
const UNOBSERVED_VERSION = "unobserved";

/** A harness run for one panel slot: the 0.1 input plus the slot it serves. */
export interface SlotHarnessInput extends HarnessInput {
  slot: PanelSlot;
}

/** What the harness observed about its own run. Values the harness did not observe stay absent and are never estimated. */
export interface SlotObservation {
  harnessVersion?: string;
  /** The model the provider actually served. */
  model?: string;
  /** Provider account identity; only its fingerprint is recorded. */
  accountIdentity?: string;
  /** Tools the harness used that its tool policy forbids. */
  disallowedTools?: string[];
  usage?: { inputTokens?: number; outputTokens?: number; costUsd?: number };
}

export interface SlotHarnessOutput extends HarnessOutput {
  observed?: SlotObservation;
}

/** A 0.1 harness adapter is a panel harness: `slot` and `observed` are optional extensions. */
export interface PanelHarnessAdapter {
  readonly capabilities: HarnessCapabilities;
  preflight(config: ReviewFnConfig, signal?: AbortSignal): Promise<PreflightResult>;
  run(input: SlotHarnessInput): Promise<SlotHarnessOutput>;
}

export interface PanelCoordinatorDependencies extends SharedRunDependencies {
  /** Installed harnesses, selected by `capabilities.id` equal to a slot's `harness.adapter`. */
  harnesses: PanelHarnessAdapter[];
  lenses?: LensRegistry;
  /** Owned checkouts per slot; Git checkouts from the run's object store by default. */
  workspaces?: (options: GitSlotWorkspaceOptions) => SlotWorkspaceProvider;
  /** Directory the run creates its checkout directory in; the system temporary directory by default. */
  workspaceRoot?: string;
  /**
   * How long an aborted checkout creation, harness or comparison may take to stop before it is abandoned; 10 seconds by
   * default, capped at a tenth of the stage budget.
   */
  abortGraceMs?: number;
  /**
   * How long comparing a slot's checkout with head may take once the slot has finished; 60 seconds by default, capped
   * at a quarter of the stage budget. Each slot's harness timeout leaves this bound and three abort graces (harness,
   * comparison, cleanup) before the stage deadline, so a slot that finishes in time always gets the whole bound and the
   * stage still ends by its deadline. A comparison that does not finish in time makes the slot `timed_out`.
   */
  comparisonTimeoutMs?: number;
  /** Source of credential values for fingerprints and redaction; `process.env` by default. */
  environment?: NodeJS.ProcessEnv;
  /**
   * The 0.1 adapter contract version (`config.harness.version`) to configure each harness with, by adapter ID, for a slot
   * whose adapter differs from the run configuration's. Required for such a slot: an adapter's `capabilities.version` is
   * never used, because adapters such as Codex overwrite it with the executable's version during preflight. A slot's
   * `harness.version` is the harness-reported version and is never sent here.
   */
  harnessContractVersions?: Record<string, string>;
}

export interface PanelRunRequest extends ReviewRunRequest {
  /** The panel policy, already loaded with `loadPanelPolicy` (trusted copy, tightened by the repository copy). */
  panelPolicy: PanelPolicy;
}

export interface SlotOutcome {
  slotId: string;
  stage: 1 | 2;
  terminal: SlotRunTerminal;
  /** Why the run ended as it did; empty for a clean completed or collapsed run. */
  reasons: string[];
  /** Findings this slot contributed to the panel report (after excluding invalid ones). */
  admittedFindings: number;
}

export interface PanelQuorumStatus {
  stage: 1 | 2;
  required: number;
  /** Completed runs with distinct identities; collapsed duplicates are not counted. */
  completed: number;
  met: boolean;
}

export interface PanelRunResult {
  report: PanelReport;
  reportArtifact: string;
  slots: SlotOutcome[];
  quorum: PanelQuorumStatus[];
  validation: PanelReportValidationResult;
  /**
   * Artifacts stored by a conclusion that a cancellation interrupted, which this report supersedes. Present only on a
   * canceled run's result.
   */
  supersededArtifacts?: string[];
}

interface SlotRecord {
  slot: PanelSlot & { stage: 1 | 2 };
  run: SlotRun;
  output: SlotHarnessOutput;
  reasons: string[];
  /** Empty when the slot ended before its prompt was built. */
  promptDigest: string;
  transcriptArtifact?: string;
}

/** A stage's time bounds: the abort grace, the comparison bound, and the time reserved before the deadline. */
interface StageTimings {
  graceMs: number;
  comparisonMs: number;
  reserveMs: number;
}

interface RunContext {
  request: PanelRunRequest;
  prepared: PreparedReview;
  runId: string;
  secrets: string[];
  resolved: Map<string, PreflightResult["resolved"]>;
  provider: SlotWorkspaceProvider;
  runSignal: AbortSignal;
  /** Checkouts or slot outputs the run could not remove or store; each makes coverage incomplete. */
  cleanupErrors: string[];
  /** Checkout removals (and abandoned creations) still running, by what they remove; the run waits for them before its report. */
  pendingCleanups: Map<Promise<void>, string>;
  /** The deadline of the last stage started; outstanding cleanup is awaited until then. */
  lastDeadline: number;
  graceMs: number;
}

const SEVERITY_RANK: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
const COUNTING = new Set<SlotRunTerminal>(["completed", "collapsed"]);

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function emptyOutput(terminal: HarnessOutput["terminal"], error: string): SlotHarnessOutput {
  return { terminal, requirements: [], assessments: [], evidence: [], findings: [], inspectedPaths: [], uninspected: [{ scope: "review", reason: error }], events: [], error };
}

/**
 * The configuration a slot runs under: the run's configuration with the slot's harness and inference. The harness keeps
 * the 0.1 adapter contract version: the run configuration's for the same adapter, otherwise `contractVersion`, which is
 * then required. The slot's `harness.version` is what the harness must report, which is compared with the observed
 * version, not configured.
 */
export function slotConfiguration(config: ReviewFnConfig, slot: PanelSlot, contractVersion?: string): ReviewFnConfig {
  const same = config.harness.adapter === slot.harness.adapter;
  if (!same && !nonblank(contractVersion)) throw new ReviewFnError("REVIEWFN_CONFIG_INVALID", `Slot ${slot.id} uses harness ${slot.harness.adapter}, whose adapter contract version is not configured.`);
  const version = same ? config.harness.version : contractVersion!;
  return { ...config, harness: { adapter: slot.harness.adapter, version, ...(same && config.harness.executable ? { executable: config.harness.executable } : {}) }, inference: { ...slot.inference } };
}

/**
 * A signal that aborts when `parent` aborts or, with `timeoutMs`, when the timeout elapses (calling `onTimeout` first).
 * Unlike `AbortSignal.any`, whose result its sources hold only weakly, this signal is reachable from the parent's listener
 * and the timer, so it still aborts when nothing else references it, as when a harness or a comparison never settles.
 * `clearTimer` stops the timeout only; the parent listener stays, so cancellation still reaches an abandoned harness.
 */
function linkedSignal(parent: AbortSignal, timeoutMs?: number, onTimeout?: () => void): { signal: AbortSignal; clearTimer: () => void } {
  const controller = new AbortController();
  if (parent.aborted) controller.abort(parent.reason);
  else parent.addEventListener("abort", () => controller.abort(parent.reason), { once: true });
  const timer = timeoutMs === undefined ? undefined : setTimeout(() => { onTimeout?.(); controller.abort(new DOMException("The operation timed out.", "TimeoutError")); }, timeoutMs);
  return { signal: controller.signal, clearTimer: () => { if (timer) clearTimeout(timer); } };
}

/** Settle `promise`, or give up `graceMs` after `signal` aborts; a late result or rejection is ignored. */
function settle<T>(promise: Promise<T>, signal: AbortSignal, graceMs: number): Promise<{ value?: T; error?: unknown; abandoned: boolean }> {
  return new Promise(resolve => {
    let done = false;
    let grace: ReturnType<typeof setTimeout> | undefined;
    const finish = (result: { value?: T; error?: unknown; abandoned: boolean }) => {
      if (done) return;
      done = true;
      if (grace) clearTimeout(grace);
      signal.removeEventListener("abort", onAbort);
      resolve(result);
    };
    const onAbort = () => { grace = setTimeout(() => finish({ abandoned: true }), graceMs); };
    if (signal.aborted) onAbort(); else signal.addEventListener("abort", onAbort, { once: true });
    promise.then(value => finish({ value, abandoned: false }), error => finish({ error, abandoned: false }));
  });
}

/**
 * Own `work` (removing `label`) until it settles: the run awaits it before building its report, within its cleanup bound,
 * and records a failure, or work still running then, as a cleanup error naming `label`.
 */
function trackCleanup(context: RunContext, label: string, work: () => Promise<unknown>): void {
  const entry: Promise<void> = Promise.resolve().then(work).then(() => undefined, error => { context.cleanupErrors.push(`${label} was not removed: ${message(error)}`); })
    .finally(() => { context.pendingCleanups.delete(entry); });
  context.pendingCleanups.set(entry, label);
}

const PAYLOAD_FIELDS = ["requirements", "assessments", "evidence", "findings", "inspectedPaths", "uninspected"] as const;

/** UTF-8 bytes of the structured payload a harness returned; 0 when it cannot be serialized (payload validation fails it). */
function structuredPayloadBytes(raw: unknown): number {
  if (!raw || typeof raw !== "object") return 0;
  try { return Buffer.byteLength(JSON.stringify(Object.fromEntries(PAYLOAD_FIELDS.map(key => [key, (raw as Record<string, unknown>)[key]]))) ?? ""); }
  catch { return 0; }
}

/** `text` cut to at most `maxBytes` UTF-8 bytes without splitting a character. */
function truncateUtf8(text: string, maxBytes: number): string {
  let cut = Buffer.from(text, "utf8").subarray(0, maxBytes).toString("utf8");
  while (Buffer.byteLength(cut) > maxBytes || cut.endsWith("\uFFFD")) cut = cut.slice(0, -1);
  return cut;
}

/**
 * Enforce the output limit on the transcript and on the serialized events, each on its own, as a harness enforces it
 * on its output streams. A channel over the limit is reported (the caller makes the run `timed_out`), and only its first
 * `maxBytes` (whole events, in order) are kept, so what is stored stays bounded.
 */
function boundTelemetry(output: SlotHarnessOutput, maxBytes: number): string[] {
  const overruns: string[] = [];
  if (typeof output.transcript === "string") {
    const bytes = Buffer.byteLength(output.transcript);
    if (bytes > maxBytes) { output.transcript = truncateUtf8(output.transcript, maxBytes); overruns.push(`The slot transcript (${bytes} bytes) exceeded its ${maxBytes}-byte limit; only its first ${maxBytes} bytes were kept.`); }
  }
  if (Array.isArray(output.events)) {
    // Measured as JSON.stringify(events) serializes them: brackets plus a comma between (not after) events.
    let used = 2;
    let kept = 0;
    for (const event of output.events) {
      let size: number;
      try { size = Buffer.byteLength(JSON.stringify(event) ?? "null") + (kept > 0 ? 1 : 0); } catch { break; }
      if (used + size > maxBytes) break;
      used += size;
      kept += 1;
    }
    if (kept < output.events.length) { overruns.push(`The slot's ${output.events.length} events exceeded its ${maxBytes}-byte limit; only the first ${kept} were kept.`); output.events = output.events.slice(0, kept); }
  } else output.events = [];
  return overruns;
}

function observedUsage(usage: SlotObservation["usage"]): SlotRun["usage"] | undefined {
  if (!usage || typeof usage !== "object") return undefined;
  const result: NonNullable<SlotRun["usage"]> = {};
  for (const key of ["inputTokens", "outputTokens"] as const) if (Number.isInteger(usage[key]) && (usage[key] as number) >= 0) result[key] = usage[key];
  if (typeof usage.costUsd === "number" && Number.isFinite(usage.costUsd) && usage.costUsd >= 0) result.costUsd = usage.costUsd;
  return Object.keys(result).length ? result : undefined;
}

function nonblank(value: unknown): value is string {
  return typeof value === "string" && /\S/.test(value);
}

/**
 * Runs a review panel: one trusted preflight, one change capture, one context fetch and one test execution, then the
 * stage-1 slots and always the stage-2 slots, each in its own checkout, then one validated and stored panel report.
 */
export class PanelCoordinator {
  private readonly lenses: LensRegistry;
  private readonly contractVersions: Map<string, string>;

  public constructor(private readonly dependencies: PanelCoordinatorDependencies) {
    this.lenses = dependencies.lenses ?? defaultLensRegistry();
    // Only an explicit, immutable source: capabilities.version may be overwritten by any preflight of the adapter.
    this.contractVersions = new Map(Object.entries(dependencies.harnessContractVersions ?? {}));
  }

  private slotConfig(config: ReviewFnConfig, slot: PanelSlot): ReviewFnConfig {
    return slotConfiguration(config, slot, this.contractVersions.get(slot.harness.adapter));
  }

  public async preflight(request: PanelRunRequest): Promise<PreflightDiagnostic[]> {
    return (await this.preflightRun(request)).diagnostics;
  }

  public async run(request: PanelRunRequest): Promise<PanelRunResult> {
    if (request.signal?.aborted) throw new ReviewFnError("REVIEWFN_CANCELED", "Panel review canceled before preflight.");
    const { diagnostics, resolved } = await this.preflightRun(request);
    const errors = diagnostics.filter(diagnostic => diagnostic.level === "error");
    if (errors.length) throw new ReviewFnError("REVIEWFN_PREFLIGHT_FAILED", "Panel preflight failed.", { diagnostics: errors });
    const policy = request.panelPolicy;
    const prepared = await prepareReview(this.dependencies, request);
    const policyDigest = panelPolicyDigest(policy);
    const { capturedAt: _capturedAt, ...identityChange } = prepared.change;
    // The run identity binds everything that shapes a slot's prompt and harness configuration, including each slot's
    // lens (ID, version and instructions) and the adapter contract version it is configured with.
    const slotInputs = policy.slots.filter(slot => slot.stage !== "verifier").map(slot => {
      const lens = this.lenses.get(slot.lens)!;
      return { slotId: slot.id, lens: { id: lens.id, version: lens.version, instructionsDigest: digestJson(lens.instructions) }, harnessContractVersion: this.slotConfig(request.config, slot).harness.version };
    });
    const runId = digestJson({ kind: "reviewfn-panel", change: identityChange, contextDigest: prepared.context.digest, policy: request.policy, config: request.config, panelPolicyDigest: policyDigest, slots: slotInputs, tests: prepared.tests.map(({ startedAt, finishedAt, runtimeMs, ...receipt }) => receipt), promptVersion: PANEL_PROMPT_VERSION, ...(request.since === undefined ? {} : { since: request.since }) });
    const environment = this.dependencies.environment ?? process.env;
    const secrets = harnessSecrets([request.config.inference.credentialEnv, ...policy.slots.map(slot => slot.inference.credentialEnv)], environment);
    const runController = new AbortController();
    const forwardAbort = () => runController.abort();
    // Cancellation stays connected until run() returns: an abort at any point before then is reflected in the result.
    request.signal?.addEventListener("abort", forwardAbort, { once: true });
    if (request.signal?.aborted) runController.abort();
    try {
      let records: SlotRecord[];
      let owned: RunContext | undefined;
      const parent = await mkdtemp(path.join(this.dependencies.workspaceRoot ?? tmpdir(), "reviewfn-panel-"));
      try {
        // The checkout directory is owned from here: a provider that fails to initialize still leaves nothing behind.
        const provider = (this.dependencies.workspaces ?? (options => new GitSlotWorkspaceProvider(options)))({ objectStore: request.root, headCommit: prepared.change.headCommit, referenceCommits: [prepared.change.mergeBaseCommit, prepared.change.baseCommit, ...(request.since === undefined ? [] : [request.since])], parent });
        const context: RunContext = owned = { request, prepared, runId, secrets, resolved, provider, runSignal: runController.signal, cleanupErrors: [], pendingCleanups: new Map(), lastDeadline: Date.now(), graceMs: this.stageTimings(request.policy.limits.harnessTimeoutMs).graceMs };
        const stageOne = await this.runStage(1, context, undefined);
        // Stage 2 always runs, whatever stage 1 found, and is told what stage 1 reported.
        const stageTwo = await this.runStage(2, context, await this.priorFindings(stageOne, context, policyDigest));
        records = [...stageOne, ...stageTwo];
      } finally {
        if (owned) await this.releaseCheckouts(owned, parent);
        else await removeTree(parent).catch(() => undefined);
      }
      const context = owned;
      const conclude = (canceled: boolean, supersedes: string[]) => this.conclude({ context, stageRecords: records, diagnostics, policyDigest, canceled, supersedes });
      // A cancellation observed before the report is stored restarts the conclusion in canceled mode, so nothing built
      // after it records a completed result, and the canceled-mode report names every artifact the first pass stored.
      const first = context.runSignal.aborted ? undefined : await conclude(false, []);
      if (first?.result && !context.runSignal.aborted) return first.result;
      const superseding = (await conclude(true, first?.stored ?? [])).result!;
      if (!first?.result) return superseding;
      // Canceled while the report was stored: a superseding report records the cancellation, and the run rejects.
      throw new ReviewFnError("REVIEWFN_CANCELED", "The panel run was canceled while its report was stored; a superseding report records the cancellation.", { reportArtifact: superseding.reportArtifact, supersededReportArtifact: first.result.reportArtifact, supersededArtifacts: superseding.supersededArtifacts ?? [] });
    } finally {
      request.signal?.removeEventListener("abort", forwardAbort);
    }
  }

  private async preflightRun(request: PanelRunRequest): Promise<{ diagnostics: PreflightDiagnostic[]; resolved: Map<string, PreflightResult["resolved"]> }> {
    const diagnostics: PreflightDiagnostic[] = [];
    const resolved = new Map<string, PreflightResult["resolved"]>();
    const validation = validatePanelPolicy(request.panelPolicy);
    if (!validation.valid) {
      diagnostics.push(...validation.issues.map(issue => ({ code: issue.code, level: "error" as const, message: `panel policy ${issue.path || "/"}: ${issue.message}` })));
      return { diagnostics, resolved };
    }
    const harnesses = new Map(this.dependencies.harnesses.map(harness => [harness.capabilities.id, harness]));
    const reviewSlots = request.panelPolicy.slots.filter(slot => slot.stage !== "verifier");
    for (const slot of reviewSlots) {
      if (!this.lenses.has(slot.lens)) diagnostics.push({ code: "REVIEWFN_PANEL_LENS_UNKNOWN", level: "error", message: `Slot ${slot.id} uses lens ${slot.lens}, which is not registered.` });
      if (!harnesses.has(slot.harness.adapter)) diagnostics.push({ code: "REVIEWFN_PANEL_HARNESS_MISSING", level: "error", message: `Slot ${slot.id} uses harness ${slot.harness.adapter}, which is not installed.` });
      else if (slot.harness.adapter !== request.config.harness.adapter && !nonblank(this.contractVersions.get(slot.harness.adapter))) diagnostics.push({ code: "REVIEWFN_PANEL_HARNESS_CONTRACT_UNKNOWN", level: "error", message: `Slot ${slot.id} uses harness ${slot.harness.adapter}, which differs from the configured harness; set its adapter contract version in harnessContractVersions.` });
      diagnostics.push(...harnessAuthDiagnostics(request, slot.harness.adapter, slot.inference.auth).map(item => ({ ...item, message: `Slot ${slot.id}: ${item.message}` })));
    }
    const verifiers = request.panelPolicy.slots.filter(slot => slot.stage === "verifier");
    if (verifiers.length) diagnostics.push({ code: "REVIEWFN_PANEL_VERIFIER_DEFERRED", level: "warning", message: `Verifier slots ${verifiers.map(slot => slot.id).join(", ")} are not run by this release; panel findings are reported unverified.` });
    if (request.panelPolicy.incremental === "delta" && request.since === undefined) diagnostics.push({ code: "REVIEWFN_PANEL_DELTA_WITHOUT_SINCE", level: "info", message: "The panel policy is incremental, but no since commit was given; every slot reviews the full change." });
    diagnostics.push(...await preflightContexts(this.dependencies, request));
    // One harness preflight per distinct slot configuration.
    const results = new Map<string, Promise<PreflightResult>>();
    for (const slot of reviewSlots) {
      const harness = harnesses.get(slot.harness.adapter);
      if (!harness || (slot.harness.adapter !== request.config.harness.adapter && !nonblank(this.contractVersions.get(slot.harness.adapter)))) continue;
      const config = this.slotConfig(request.config, slot);
      const key = stableStringify({ adapter: slot.harness.adapter, harness: config.harness, inference: config.inference });
      let pending = results.get(key);
      const first = !pending;
      if (!pending) { pending = harness.preflight(config, request.signal).catch(error => ({ ok: false, diagnostics: [{ code: "REVIEWFN_PREFLIGHT_FAILED", level: "error" as const, message: message(error) }] })); results.set(key, pending); }
      const result = await pending;
      resolved.set(slot.id, result.resolved);
      if (first) diagnostics.push(...componentDiagnostics(`${slot.harness.adapter} (slot ${slot.id})`, result, `Harness preflight for slot ${slot.id} refused execution.`));
    }
    diagnostics.push(...await preflightExecution(this.dependencies, request));
    diagnostics.push(...preflightSince(this.dependencies, request));
    diagnostics.push(...fallbackDiagnostics(request.config));
    return { diagnostics, resolved };
  }

  /**
   * The abort grace and comparison bound for a stage of `budgetMs`, each capped at a share of the budget so the reserve
   * never takes the whole stage, and the reserve each slot's harness timeout leaves before the stage deadline: the
   * harness's abort grace, the comparison with its grace, and one grace for removing checkouts.
   */
  private stageTimings(budgetMs: number): StageTimings {
    const graceMs = Math.max(0, Math.min(this.dependencies.abortGraceMs ?? DEFAULT_ABORT_GRACE_MS, Math.floor(budgetMs / 10)));
    const comparisonMs = Math.max(1, Math.min(this.dependencies.comparisonTimeoutMs ?? DEFAULT_COMPARISON_TIMEOUT_MS, Math.floor(budgetMs / 4)));
    return { graceMs, comparisonMs, reserveMs: comparisonMs + 3 * graceMs };
  }

  /**
   * Wait for every checkout removal and abandoned creation the run owns, then remove the run's checkout directory, until
   * the last stage deadline (one abort grace after a cancellation). Whatever has not finished by then is recorded as a
   * cleanup error naming it, so the report never claims a clean run while a checkout may remain.
   */
  private async releaseCheckouts(context: RunContext, parent: string): Promise<void> {
    const bound = linkedSignal(context.runSignal, Math.max(0, context.lastDeadline - context.graceMs - Date.now()));
    const work = Promise.allSettled([...context.pendingCleanups.keys()]).then(() => removeTree(parent));
    const settled = await settle(work, bound.signal, context.graceMs);
    bound.clearTimer();
    if (settled.error !== undefined) context.cleanupErrors.push(`The run's checkout directory was not removed: ${message(settled.error)}`);
    if (!settled.abandoned) return;
    for (const label of context.pendingCleanups.values()) context.cleanupErrors.push(`${label} was not removed: its removal did not finish by the end of the run.`);
    // Removal stays owned: it is still attempted, and the report records that it was not confirmed.
    removeTree(parent).catch(() => undefined);
    context.cleanupErrors.push(`The run's checkout directory ${parent} was not confirmed removed by the end of the run.`);
  }

  /**
   * Run one stage's slots in policy order, at most `maxConcurrentSlots` at once, within the stage's wall-time budget: a
   * slot's harness, abort grace and checkout comparison all end by the stage deadline.
   */
  private async runStage(stage: 1 | 2, context: RunContext, prior: PriorStageFinding[] | undefined): Promise<SlotRecord[]> {
    const slots = context.request.panelPolicy.slots.filter((slot): slot is PanelSlot & { stage: 1 | 2 } => slot.stage === stage);
    const deadline = Date.now() + context.request.policy.limits.harnessTimeoutMs;
    context.lastDeadline = deadline;
    const timings = this.stageTimings(context.request.policy.limits.harnessTimeoutMs);
    const queue = [...slots];
    const records = new Map<string, SlotRecord>();
    const worker = async () => {
      for (let slot = queue.shift(); slot; slot = queue.shift()) records.set(slot.id, await this.runSlot(slot, context, deadline, timings, prior));
    };
    await Promise.all(Array.from({ length: Math.min(effectiveMaxConcurrentSlots(context.request.panelPolicy), slots.length) }, worker));
    return slots.map(slot => records.get(slot.id)!);
  }

  private configuredIdentity(slot: PanelSlot, context: RunContext): SlotIdentity {
    const harness = this.dependencies.harnesses.find(item => item.capabilities.id === slot.harness.adapter);
    const resolved = context.resolved.get(slot.id);
    const credential = slot.inference.credentialEnv ? (this.dependencies.environment ?? process.env)[slot.inference.credentialEnv] : undefined;
    return {
      harnessAdapter: slot.harness.adapter,
      // The slot's pin is never recorded as a version: it is what the reported version is checked against.
      harnessVersion: nonblank(resolved?.harnessVersion) ? resolved.harnessVersion : nonblank(harness?.capabilities.version) ? harness.capabilities.version : UNOBSERVED_VERSION,
      provider: slot.inference.provider,
      model: nonblank(resolved?.model) ? resolved.model : slot.inference.model,
      auth: slot.inference.auth,
      ...(credential ? { credentialFingerprint: credentialFingerprint(credential) } : {}),
    };
  }

  /** Run one slot to a terminal outcome. Never throws; its checkout is removed whatever happened. */
  private async runSlot(slot: PanelSlot & { stage: 1 | 2 }, context: RunContext, deadline: number, timings: StageTimings, prior: PriorStageFinding[] | undefined): Promise<SlotRecord> {
    const now = this.dependencies.now ?? (() => new Date());
    const { request, prepared } = context;
    const startedAt = now().toISOString();
    const baseIdentity = this.configuredIdentity(slot, context);
    const requirements = request.panelPolicy.requirementsSlot === slot.id;
    // Every terminal path ends here, so the one void precedence applies to all of them: a resolved or served model other
    // than the configured one voids the run, even one that ended before the harness ran (identity from preflight).
    const finish = (terminal: SlotRunTerminal, reasons: string[], output: SlotHarnessOutput, extra: Partial<SlotRun> = {}, promptDigest = "", transcriptArtifact?: string): SlotRecord => {
      const identity = extra.identity ?? baseIdentity;
      const voidReasons = [...(extra.voidReasons ?? [])];
      const allReasons = [...reasons];
      if (slot.inference.model !== "configured" && identity.model !== slot.inference.model && !voidReasons.includes("model_mismatch")) {
        voidReasons.unshift("model_mismatch");
        allReasons.push(`Preflight resolved model ${identity.model}, not the configured ${slot.inference.model}.`);
      }
      // Every run that does not count says why.
      if (!voidReasons.length && !COUNTING.has(terminal) && !allReasons.length) allReasons.push(`The harness reported ${terminal} without a reason.`);
      // A clock that steps back never records a run finishing before it started.
      const finished = now().toISOString();
      const finishedAt = Date.parse(finished) < Date.parse(startedAt) ? startedAt : finished;
      return {
        slot, output: redactJson(output, context.secrets), reasons: allReasons.map(reason => redactText(reason, context.secrets)), promptDigest, ...(transcriptArtifact ? { transcriptArtifact } : {}),
        run: { slotId: slot.id, ...extra, identity, terminal: voidReasons.length ? "void" : terminal, voidReasons, startedAt, finishedAt },
      };
    };
    if (context.runSignal.aborted) return finish("canceled", ["The panel run was canceled before the slot started."], emptyOutput("canceled", "The panel run was canceled before the slot started."));
    const stageBudget = `Stage ${slot.stage} exhausted its ${request.policy.limits.harnessTimeoutMs} ms budget`;
    // The harness must stop early enough to leave the abort grace, the comparison and its grace before the deadline.
    const harnessDeadline = deadline - timings.reserveMs;
    if (harnessDeadline - Date.now() <= 0) return finish("timed_out", [`${stageBudget} before the slot started.`], emptyOutput("timed_out", "Stage budget exhausted."));
    const maxOutputBytes = Math.min(slot.budget.maxOutputBytes, request.policy.limits.maxOutputBytes);
    let workspace: SlotWorkspace | undefined;
    let clearHarnessTimer: (() => void) | undefined;
    try {
      // Creating the checkout is bounded by the stage deadline, like the harness: a provider that does not stop is
      // abandoned after the abort grace, and a checkout it creates later is still removed by the run. The slot's own
      // timeout starts once its checkout exists.
      let creationTimedOut = false;
      const creation = linkedSignal(context.runSignal, Math.max(1, harnessDeadline - Date.now()), () => { creationTimedOut = true; });
      const creating = Promise.resolve().then(() => context.provider.create(slot.id, creation.signal));
      const created = await settle(creating, creation.signal, timings.graceMs);
      creation.clearTimer();
      if (created.abandoned) trackCleanup(context, `Slot ${slot.id} checkout (its creation was abandoned)`, () => creating.then(late => late.remove(), () => undefined));
      if (created.abandoned || created.error !== undefined) {
        const terminal = context.runSignal.aborted ? "canceled" : creationTimedOut ? "timed_out" : "failed";
        const reason = terminal === "canceled" ? "The panel run was canceled while the slot checkout was created." : terminal === "timed_out" ? `${stageBudget} while the slot checkout was created.` : `The slot checkout could not be created: ${message(created.error)}`;
        return finish(terminal, [reason], emptyOutput(terminal, reason));
      }
      workspace = created.value!;
      // No harness starts after the run was canceled, even when the checkout was created in the meantime.
      if (context.runSignal.aborted) return finish("canceled", ["The panel run was canceled before the slot's harness started."], emptyOutput("canceled", "The panel run was canceled before the slot's harness started."));
      const slotLimit = Math.min(slot.budget.timeoutMs, request.policy.limits.harnessTimeoutMs);
      if (harnessDeadline - Date.now() <= 0) {
        const reason = `${stageBudget} before the slot's harness could start.`;
        return finish("timed_out", [reason], emptyOutput("timed_out", reason));
      }
      const timeoutMs = Math.max(1, Math.min(slotLimit, harnessDeadline - Date.now()));
      let timedOut = false;
      const harnessSignal = linkedSignal(context.runSignal, timeoutMs, () => { timedOut = true; });
      clearHarnessTimer = harnessSignal.clearTimer;
      const signal = harnessSignal.signal;
      const lens = this.lenses.get(slot.lens)!;
      const config = this.slotConfig(request.config, slot);
      // The requirements slot reviews the full change, but its report must account for every delta path, so it is shown the delta too.
      const delta = request.since !== undefined && prepared.changeDetail.delta ? { delta: prepared.changeDetail.delta, since: request.since } : {};
      const scope: SlotScope = requirements ? { mode: "full", hunks: prepared.changeDetail.hunks, ...delta }
        : request.panelPolicy.incremental === "full" || request.since === undefined ? { mode: "full", hunks: prepared.changeDetail.hunks }
          : { mode: "delta", hunks: prepared.changeDetail.hunks, ...delta };
      const prompt = buildSlotPrompt({ slot, lens, change: prepared.change, context: prepared.context, config, policy: request.policy, tests: prepared.tests, scope, priorFindings: prior, requirements });
      const slotPolicy = { ...request.policy, limits: { ...request.policy.limits, harnessTimeoutMs: timeoutMs, maxOutputBytes } };
      const harness = this.dependencies.harnesses.find(item => item.capabilities.id === slot.harness.adapter)!;
      const input: SlotHarnessInput = { runId: context.runId, workspace: workspace.path, change: prepared.change, context: prepared.context, policy: slotPolicy, configuration: config, testReceipts: prepared.tests, prompt: prompt.prompt, ...(requirements ? {} : { outputSchema: lensOutputSchema }), signal, slot };
      const settled = await settle(Promise.resolve().then(() => harness.run(input)), signal, timings.graceMs);
      harnessSignal.clearTimer();
      const reasons: string[] = [];
      let raw: SlotHarnessOutput;
      if (settled.abandoned) raw = emptyOutput(timedOut ? "timed_out" : "canceled", "The harness did not stop after it was aborted; the slot was abandoned.");
      else if (settled.error !== undefined) raw = emptyOutput(timedOut ? "timed_out" : context.runSignal.aborted ? "canceled" : "failed", message(settled.error));
      else raw = settled.value as SlotHarnessOutput;
      const observed: SlotObservation = raw && typeof raw === "object" && raw.observed && typeof raw.observed === "object" ? raw.observed : {};
      const payloadBytes = structuredPayloadBytes(raw);
      let output: SlotHarnessOutput = normalizeHarnessOutput(raw, { secrets: context.secrets, aborted: context.runSignal.aborted, payloadErrors: requirements ? undefined : payload => validateLensPayload({ findings: payload.findings, evidence: payload.evidence, inspectedPaths: payload.inspectedPaths, uninspected: payload.uninspected }) });
      // Only a harness terminal is taken from the harness; anything else (missing, unknown, or the panel's own `void` and
      // `collapsed`) makes the run malformed, with no findings, so it neither counts nor skips the panel's checks.
      if (!HARNESS_TERMINALS.has(output.terminal)) {
        const reported: unknown = raw && typeof raw === "object" ? (raw as { terminal?: unknown }).terminal : undefined;
        const shown = typeof reported === "string" ? JSON.stringify(redactText(reported.slice(0, 64), context.secrets)) : reported === undefined ? "none" : `a ${typeof reported}`;
        output = { terminal: "malformed", requirements: [], assessments: [], evidence: [], findings: [], inspectedPaths: [], uninspected: [{ scope: "terminal outcome", reason: `The harness reported terminal ${shown}, which is not a harness terminal outcome.` }], events: Array.isArray(output.events) ? output.events : [] };
      }
      if (!requirements) output = { ...output, requirements: [], assessments: [] };
      // The output limit applies to each channel on its own (structured payload, transcript, events), as a harness
      // enforces it on its streams: any channel over it exceeds the slot budget. What is stored stays within the limit.
      const overruns = [
        ...(payloadBytes > maxOutputBytes ? [`The slot's structured output (${payloadBytes} bytes) exceeded its ${maxOutputBytes}-byte limit.`] : []),
        ...boundTelemetry(output, maxOutputBytes),
      ];
      if (timedOut && !context.runSignal.aborted) { output.terminal = "timed_out"; reasons.push(timeoutMs < slotLimit ? `${stageBudget} while the slot ran.` : `The slot exceeded its ${timeoutMs} ms timeout.`); }
      else if (overruns.length && output.terminal !== "canceled") output.terminal = "timed_out";
      reasons.push(...overruns);
      if (output.terminal !== "completed" && output.error) reasons.push(redactText(output.error, context.secrets));
      if (output.terminal === "malformed") reasons.push(...output.uninspected.map(item => `${item.scope}: ${item.reason}`));
      // The comparison has its whole bound, reserved before the stage deadline, and stops on run cancellation. Only an
      // observed difference voids the slot; a comparison that did not finish leaves it timed out (or canceled), never counted.
      const comparisonMs = timings.comparisonMs;
      const comparison = linkedSignal(context.runSignal, comparisonMs);
      const check = await this.compare(workspace, comparison.signal, timings.graceMs);
      comparison.clearTimer();
      let uncompared: { terminal: "canceled" | "timed_out" | "failed"; reason: string } | undefined;
      if (check.incomplete) {
        // A comparison the run could not finish (stopped, or past a limit of the run's own) never voids the slot.
        uncompared = context.runSignal.aborted
          ? { terminal: "canceled", reason: "The panel run was canceled before the checkout was compared with head." }
          : comparison.signal.aborted
            ? { terminal: "timed_out", reason: `The checkout comparison did not finish within its ${comparisonMs} ms bound, so the checkout was not shown to be unchanged.` }
            : { terminal: "failed", reason: `The checkout was not compared with head: ${check.reason ?? "the comparison did not complete"}` };
      }
      const identity: SlotIdentity = {
        ...baseIdentity,
        ...(nonblank(observed.harnessVersion) ? { harnessVersion: redactText(observed.harnessVersion, context.secrets) } : {}),
        ...(nonblank(observed.model) ? { model: redactText(observed.model, context.secrets) } : {}),
      };
      if (!identity.credentialFingerprint && nonblank(observed.accountIdentity)) identity.credentialFingerprint = credentialFingerprint(observed.accountIdentity);
      const voidReasons: SlotVoidReason[] = [];
      if (slot.inference.model !== "configured" && identity.model !== slot.inference.model) { voidReasons.push("model_mismatch"); reasons.push(`The harness served model ${identity.model}, not the configured ${slot.inference.model}.`); }
      if (!check.unchanged && !check.incomplete) { voidReasons.push("workspace_mutated"); reasons.push(check.reason ?? "The slot changed its checkout."); }
      const disallowed = Array.isArray(observed.disallowedTools) ? observed.disallowedTools.filter(nonblank).map(tool => redactText(tool, context.secrets)) : [];
      if (disallowed.length) { voidReasons.push("disallowed_tool_use"); reasons.push(`The harness used disallowed tools: ${disallowed.join(", ")}.`); }
      let terminal: SlotRunTerminal = output.terminal;
      if (voidReasons.length) terminal = "void";
      else if (uncompared) { terminal = uncompared.terminal; reasons.push(uncompared.reason); }
      else if (terminal === "completed" && identity.harnessVersion !== slot.harness.version) {
        terminal = "failed";
        reasons.push(identity.harnessVersion === UNOBSERVED_VERSION ? `No harness version was observed, so the pinned ${slot.harness.version} was not confirmed.` : `The harness reported version ${identity.harnessVersion}, not the pinned ${slot.harness.version}.`);
      }
      const usage = observedUsage(observed.usage);
      let transcript: string | undefined;
      if (request.config.retainTranscript && output.transcript) {
        try { transcript = (await this.dependencies.artifacts.put("redacted-transcript", redactText(output.transcript, context.secrets), prepared.retention.transcriptDays)).id; }
        catch (error) { reasons.push(`The slot transcript could not be stored: ${message(error)}`); }
      }
      return finish(terminal, reasons, output, { identity, voidReasons, ...(usage ? { usage } : {}) }, prompt.digest, transcript);
    } catch (error) {
      const terminal = context.runSignal.aborted ? "canceled" : "failed";
      const reason = `The slot failed unexpectedly: ${message(error)}`;
      return finish(terminal, [reason], emptyOutput(terminal, reason));
    } finally {
      clearHarnessTimer?.();
      // Removal is owned by the run, not awaited here: it neither holds the slot's place nor uses the stage's time.
      const owned = workspace;
      if (owned) trackCleanup(context, `Slot ${slot.id} checkout ${owned.path}`, () => owned.remove());
    }
  }

  /**
   * Compare a finished slot's checkout with head within `signal`. A comparison that stops on the signal, that has not
   * returned before the signal aborted, or does not stop within the abort grace after it, is incomplete; only a comparison
   * that completed within its bound can report unchanged or a difference.
   */
  private async compare(workspace: SlotWorkspace, signal: AbortSignal, graceMs: number): Promise<WorkspaceCheck> {
    const settled = await settle(Promise.resolve().then(() => workspace.verify(signal)), signal, graceMs);
    const stopped: WorkspaceCheck = { unchanged: false, incomplete: true, reason: "The comparison was stopped before it finished." };
    // A result that arrives after the signal aborted (during the grace) came from a comparison past its bound: incomplete.
    if (settled.abandoned || signal.aborted) return stopped;
    if (settled.error !== undefined) return { unchanged: false, reason: `The checkout could not be compared with head: ${message(settled.error)}` };
    const check = settled.value;
    if (!check || typeof check !== "object") return { unchanged: false, reason: "The checkout comparison returned no result." };
    if (check.unchanged === true) return { unchanged: true };
    if (check.incomplete === true) return { unchanged: false, incomplete: true, ...(typeof check.reason === "string" ? { reason: check.reason } : {}) };
    return { unchanged: false, ...(typeof check.reason === "string" ? { reason: check.reason } : {}) };
  }

  /**
   * Turn the stage results into one stored panel report. Works on copies of `stageRecords`, so it can run again, and
   * returns every artifact it stored. Not in canceled mode, it stops without a result, storing nothing further, once it
   * observes a cancellation. In canceled mode the report records the cancellation and names the artifacts it supersedes
   * (`supersedes`), and a completed requirements slot is canceled: its requirements report would otherwise record a
   * completed execution after the run was canceled.
   */
  private async conclude(input: { context: RunContext; stageRecords: SlotRecord[]; diagnostics: PreflightDiagnostic[]; policyDigest: string; canceled: boolean; supersedes: string[] }): Promise<{ result?: PanelRunResult; stored: string[] }> {
    const { context, canceled } = input;
    const records = input.stageRecords.map(record => ({ ...record, run: structuredClone(record.run), reasons: [...record.reasons] }));
    const cleanupErrors = [...context.cleanupErrors];
    const stored: string[] = [];
    const interrupted = () => !canceled && context.runSignal.aborted;
    if (canceled) {
      const requirements = records.find(record => record.slot.id === context.request.panelPolicy.requirementsSlot);
      if (requirements?.run.terminal === "completed") {
        requirements.run.terminal = "canceled";
        requirements.reasons.push("The panel run was canceled before the requirements report was recorded, so the requirements slot's result was not accepted.");
      }
    }
    const quorum = collapseAndCount(records, context.request.panelPolicy);
    // Every slot's outcome is stored once its final terminal (after collapse) is known, whatever ended it.
    await this.storeSlotOutputs(records, context, cleanupErrors, stored, canceled);
    if (interrupted()) return { stored };
    // Outside canceled mode the requirements report stores nothing once the run is canceled.
    const requirementsReport = await this.requirementsReport(records, context, input.diagnostics, canceled ? undefined : context.runSignal);
    stored.push(...requirementsReport.stored);
    if (interrupted()) return { stored };
    // Artifacts are content-addressed: one this pass stored again is current, not superseded.
    const supersedes = input.supersedes.filter(id => !stored.includes(id));
    const result = await this.assemble({ context, records, quorum, requirementsReport, policyDigest: input.policyDigest, cleanupErrors, canceled, supersedes });
    if (result) {
      stored.push(result.reportArtifact);
      if (supersedes.length) result.supersededArtifacts = supersedes;
    }
    return { ...(result ? { result } : {}), stored };
  }

  /** Store each slot's outcome (terminal, reasons, identity and output) and bind it to its run by digest. */
  private async storeSlotOutputs(records: SlotRecord[], context: RunContext, cleanupErrors: string[], stored: string[], canceled: boolean): Promise<void> {
    for (const record of records) {
      // Outside canceled mode nothing more is stored once the run is canceled; the canceled-mode pass stores them all.
      if (!canceled && context.runSignal.aborted) return;
      const lens = this.lenses.get(record.slot.lens);
      const { output, run } = record;
      const document = {
        slotId: record.slot.id, stage: record.slot.stage, lens: lens ? { id: lens.id, version: lens.version } : { id: record.slot.lens },
        ...(record.promptDigest ? { promptDigest: record.promptDigest } : {}),
        terminal: run.terminal, voidReasons: run.voidReasons, reasons: record.reasons, identity: run.identity, startedAt: run.startedAt, finishedAt: run.finishedAt,
        ...(record.transcriptArtifact ? { redactedTranscriptArtifact: record.transcriptArtifact } : {}),
        output: { findings: output.findings, evidence: output.evidence, inspectedPaths: output.inspectedPaths, uninspected: output.uninspected, requirements: output.requirements, assessments: output.assessments, events: output.events },
      };
      try {
        const artifact = await this.dependencies.artifacts.put(PANEL_SLOT_OUTPUT_ARTIFACT_KIND, JSON.stringify(redactJson(document, context.secrets), null, 2), context.prepared.retention.reportDays);
        stored.push(artifact.id);
        run.outputArtifact = artifact.id;
        run.outputDigest = artifact.digest;
      } catch (error) {
        const reason = `The output of slot ${record.slot.id} could not be stored: ${redactText(message(error), context.secrets)}`;
        record.reasons.push(reason);
        cleanupErrors.push(reason);
      }
    }
  }

  /** The requirements slot's 0.1 report, built through the shared 0.1 report path from the slot's final outcome. */
  private async requirementsReport(records: SlotRecord[], context: RunContext, diagnostics: PreflightDiagnostic[], signal: AbortSignal | undefined): Promise<{ report?: ReviewReport; reasons: string[]; stored: string[] }> {
    const slotId = context.request.panelPolicy.requirementsSlot;
    const record = records.find(item => item.slot.id === slotId);
    if (!record) return { reasons: [], stored: [] };
    const output = structuredClone(record.output) as HarnessOutput;
    // A run that does not count (void, canceled, or a harness version other than the pinned one) never yields a completed report.
    if (!COUNTING.has(record.run.terminal)) {
      if (output.terminal === "completed") output.terminal = record.run.terminal === "canceled" ? "canceled" : "failed";
      output.error = `Requirements slot ${record.slot.id} is ${record.run.terminal}: ${record.reasons.join(" ")}`;
    }
    const config = this.slotConfig(context.request.config, record.slot);
    const request = { ...context.request, config };
    try {
      const { report, reportArtifact } = await assembleReviewReport(this.dependencies, {
        request, prepared: context.prepared, output, secrets: context.secrets, diagnostics, ...(signal ? { signal } : {}),
        harness: { id: record.slot.harness.adapter, version: record.run.identity.harnessVersion },
        // Its run identity is the panel run's (which binds the slot's lens and contract version) plus the slot, the
        // version it ran under and the panel prompt it was actually given, not the 0.1 prompt.
        promptDigest: record.promptDigest, runId: digestJson({ kind: "reviewfn-panel-requirements", panelRunId: context.runId, slotId: record.slot.id, harnessVersion: record.run.identity.harnessVersion, promptDigest: record.promptDigest }), attemptId: context.request.attemptId ?? createAttemptId(),
      });
      return { report, reasons: [], stored: [report.normalizedEventArtifact, report.redactedTranscriptArtifact, reportArtifact].filter((id): id is string => typeof id === "string") };
    } catch (error) {
      const partial = error instanceof ReviewFnError && Array.isArray(error.details?.storedArtifacts) ? error.details.storedArtifacts.filter((id): id is string => typeof id === "string") : [];
      return { reasons: [`The requirements report could not be built: ${message(error)}`], stored: partial };
    }
  }

  /** A panel report with the run's slots and runs and no findings yet, for validating candidate findings against. */
  private baseReport(context: RunContext, records: SlotRecord[], policyDigest: string, requirementsReport?: ReviewReport): PanelReport {
    const { request, prepared } = context;
    const now = this.dependencies.now ?? (() => new Date());
    return {
      schemaVersion: 1, kind: "reviewfn-panel", runId: context.runId, createdAt: now().toISOString(), change: prepared.change,
      ...(prepared.changeDetail.detail ? { changeDetail: prepared.changeDetail.detail } : {}),
      contextManifestDigest: prepared.context.digest, panelPolicyDigest: policyDigest, slots: structuredClone(request.panelPolicy.slots), slotRuns: records.map(record => record.run),
      ...(requirementsReport ? { requirementsReport } : {}),
      gateReceipts: prepared.tests, evidence: [], findings: [], clusters: [], coverage: "complete", coverageReasons: [],
    };
  }

  private validationOptions(context: RunContext): Parameters<typeof validatePanelReport>[2] {
    return { sourceControl: this.dependencies.sourceControl, root: context.request.root, context: context.prepared.context, artifacts: this.dependencies.artifacts, panelPolicy: context.request.panelPolicy };
  }

  /**
   * Stage-1 findings for stage 2: the findings of completed and collapsed stage-1 slots that the panel report would
   * admit, merged by fingerprint. The runs are collapsed as for the report, on copies. Requirement links are not passed
   * on, so they are not checked here.
   */
  private async priorFindings(stageRecords: SlotRecord[], context: RunContext, policyDigest: string): Promise<PriorStageFinding[]> {
    const records = stageRecords.map(record => ({ ...record, run: structuredClone(record.run) }));
    collapseAndCount(records, context.request.panelPolicy);
    const base = this.baseReport(context, records, policyDigest);
    const merged = new Map<string, PriorStageFinding>();
    for (const record of records) {
      if (!COUNTING.has(record.run.terminal)) continue;
      const candidates = slotCandidates(record);
      candidates.findings = candidates.findings.map(finding => ({ ...finding, requirementIds: [] }));
      const excluded = await invalidCandidates(base, records.indexOf(record), candidates, context.request, this.validationOptions(context));
      candidates.findings.forEach((finding, index) => {
        if (excluded.has(index)) return;
        const existing = merged.get(finding.fingerprint);
        if (existing) { if (!existing.origins.includes(record.slot.id)) existing.origins.push(record.slot.id); return; }
        merged.set(finding.fingerprint, { fingerprint: finding.fingerprint, severity: finding.severity, category: finding.category, title: finding.title, trigger: finding.trigger, ...(finding.anchor ? { anchor: finding.anchor } : {}), origins: [record.slot.id] });
      });
    }
    return [...merged.values()];
  }

  private async assemble(input: { context: RunContext; records: SlotRecord[]; quorum: PanelQuorumStatus[]; requirementsReport: { report?: ReviewReport; reasons: string[] }; policyDigest: string; cleanupErrors: string[]; canceled: boolean; supersedes: string[] }): Promise<PanelRunResult | undefined> {
    const { context, records, quorum } = input;
    const { request, prepared } = context;
    const now = this.dependencies.now ?? (() => new Date());
    const coverageReasons = [
      ...prepared.changeDetail.coverageReasons,
      ...prepared.context.incompleteReasons,
      ...prepared.executionErrors,
      ...prepared.tests.filter(receipt => receipt.exitCode !== 0 || receipt.timedOut || receipt.canceled).map(receipt => `Test ${receipt.id} did not pass (exit ${String(receipt.exitCode)}).`),
      ...(input.canceled || context.runSignal.aborted ? [CANCELED_REASON] : []),
      ...(input.supersedes.length ? [`This report supersedes artifact(s) ${input.supersedes.join(", ")}, stored before the cancellation was observed.`] : []),
      ...quorum.filter(item => !item.met).map(item => `${PANEL_QUORUM_UNMET}: stage ${item.stage} has ${item.completed} completed slot run(s) with distinct identities; its quorum is ${item.required}.`),
      ...input.requirementsReport.reasons,
    ];
    const base = this.baseReport(context, records, input.policyDigest, input.requirementsReport.report);
    const options = this.validationOptions(context);
    const union = new Map<string, PanelFinding>();
    const evidence = new Map<string, Evidence>();
    const contributing = records.filter(record => COUNTING.has(record.run.terminal));
    for (const record of contributing) {
      const candidates = slotCandidates(record);
      const excluded = await invalidCandidates(base, records.indexOf(record), candidates, request, options);
      for (const [index, reason] of excluded) coverageReasons.push(`Slot ${record.slot.id} finding "${candidates.findings[index].title}" was excluded: ${reason}`);
      candidates.findings.forEach((finding, index) => {
        if (excluded.has(index)) return;
        for (const id of finding.evidenceIds) {
          const item = candidates.evidence.get(id);
          if (item) evidence.set(id, item);
        }
        const existing = union.get(finding.fingerprint);
        if (!existing) { union.set(finding.fingerprint, finding); return; }
        // Union, not vote: agreement is recorded in origins and never filters. The fingerprint covers requirementIds, so
        // merged findings always link the same requirements.
        if (!existing.origins.some(origin => origin.slotId === record.slot.id)) existing.origins.push(...finding.origins);
        existing.evidenceIds = [...new Set([...existing.evidenceIds, ...finding.evidenceIds])];
        if (SEVERITY_RANK[finding.severity] < SEVERITY_RANK[existing.severity]) existing.severity = finding.severity;
        if (finding.basis === "reproduced") existing.basis = "reproduced";
      });
    }
    const contributors = Math.max(1, contributing.length);
    let findings = [...union.values()].map(finding => ({ ...finding, confidence: Math.min(1, finding.origins.length / contributors) }));
    const limit = request.policy.limits.maxFindings;
    if (findings.length > limit) {
      const kept = new Set([...findings].sort((left, right) => SEVERITY_RANK[left.severity] - SEVERITY_RANK[right.severity]).slice(0, limit));
      const dropped = findings.filter(finding => !kept.has(finding));
      coverageReasons.push(`The slots reported ${findings.length} valid findings, more than maxFindings (${limit}); ${dropped.length} lower-severity finding(s) were not recorded.`);
      findings = findings.filter(finding => kept.has(finding));
    }
    // A slot's admitted findings are those the report records, after the maxFindings bound.
    const admitted = new Map<string, number>();
    for (const finding of findings) for (const origin of finding.origins) admitted.set(origin.slotId, (admitted.get(origin.slotId) ?? 0) + 1);
    const cited = new Set(findings.flatMap(finding => finding.evidenceIds));
    // Delta mode makes the delta the primary scope; otherwise every changed path must be inspected by a slot that succeeded.
    const scopePaths = request.panelPolicy.incremental === "delta" && request.since !== undefined && prepared.changeDetail.detail?.deltaPaths ? prepared.changeDetail.detail.deltaPaths : prepared.change.changedPaths;
    const inspected = new Set(contributing.flatMap(record => record.output.inspectedPaths));
    const uninspected = scopePaths.filter(item => !inspected.has(item));
    if (!contributing.length) coverageReasons.push("No slot completed, so nothing in the change was reviewed.");
    for (const record of contributing) coverageReasons.push(...record.output.uninspected.map(item => `Slot ${record.slot.id} did not inspect ${item.scope}: ${item.reason}`));
    if (uninspected.length) coverageReasons.push(`No completed slot inspected ${uninspected.slice(0, MAX_LISTED_PATHS).join(", ")}${uninspected.length > MAX_LISTED_PATHS ? ` and ${uninspected.length - MAX_LISTED_PATHS} more path(s)` : ""}.`);
    coverageReasons.push(...input.cleanupErrors);
    const report: PanelReport = { ...base, evidence: [...evidence.values()].filter(item => cited.has(item.id)), findings, coverage: "complete", coverageReasons: [] };
    // Cleanup and requirements-report errors carry raw error messages: redact every reason before it is returned or stored.
    const validation = await settleReport(report, coverageReasons.map(reason => redactText(reason, context.secrets)), request.policy, options);
    // Cancellation is observed until the report is stored: one during validation restarts in canceled mode.
    if (!input.canceled && context.runSignal.aborted) return undefined;
    const stored = await this.dependencies.artifacts.put(PANEL_REPORT_ARTIFACT_KIND, JSON.stringify(report, null, 2), prepared.retention.reportDays);
    const slots = records.map(record => ({ slotId: record.slot.id, stage: record.slot.stage, terminal: record.run.terminal, reasons: record.reasons, admittedFindings: admitted.get(record.slot.id) ?? 0 }));
    return { report, reportArtifact: stored.id, slots, quorum, validation };
  }
}


/**
 * Collapse duplicate identities within each stage and count quorum. The first completed run of an identity in policy
 * order counts; a later completed run of that identity is collapsed. Other terminals neither count nor collapse.
 */
function collapseAndCount(records: SlotRecord[], policy: PanelPolicy): PanelQuorumStatus[] {
  return ([1, 2] as const).map(stage => {
    const counted = new Set<string>();
    for (const record of records.filter(item => item.slot.stage === stage)) {
      if (record.run.terminal !== "completed") continue;
      const key = slotIdentityKey(record.run.identity);
      if (counted.has(key)) record.run.terminal = "collapsed";
      else counted.add(key);
    }
    const required = stage === 1 ? policy.quorum.stage1 : policy.quorum.stage2;
    return { stage, required, completed: counted.size, met: counted.size >= required };
  });
}

/** A slot's findings as single-origin panel findings, with evidence IDs namespaced by slot so slots never collide. */
function slotCandidates(record: SlotRecord): { findings: PanelFinding[]; evidence: Map<string, Evidence> } {
  const namespaced = (id: string) => `${record.slot.id}/${id}`;
  const evidence = new Map(record.output.evidence.map(item => [namespaced(item.id), { ...item, id: namespaced(item.id) }]));
  // `info` findings of the requirements slot stay in its requirements report; a panel finding is never info.
  const findings = record.output.findings.filter((finding): finding is Finding & { severity: PanelFindingSeverity } => finding.severity !== "info").map(finding => ({
    fingerprint: finding.fingerprint, severity: finding.severity, category: finding.category, title: finding.title, trigger: finding.trigger, impact: finding.impact, direction: finding.direction,
    ...(finding.anchor ? { anchor: finding.anchor } : {}),
    evidenceIds: finding.evidenceIds.map(namespaced), basis: finding.basis, requirementIds: finding.requirementIds, lifecycle: finding.lifecycle,
    origins: [{ slotId: record.slot.id, lens: record.slot.lens }], confidence: 0, ruleIds: [], disposition: "reported" as const,
  }));
  return { findings, evidence };
}

/**
 * Set the report's coverage from `reasons`, derive its verdict and validate it. A report that fails validation keeps
 * its issues as coverage reasons, with coverage incomplete and the verdict re-derived.
 */
async function settleReport(report: PanelReport, reasons: string[], policy: ReviewPolicy, options: Parameters<typeof validatePanelReport>[2]): Promise<PanelReportValidationResult> {
  report.coverageReasons = [...new Set(reasons)];
  report.coverage = report.coverageReasons.length ? "incomplete" : "complete";
  const derive = () => {
    const verdict = derivePanelVerdict(report, policy);
    if (verdict === undefined) delete report.verdict; else report.verdict = verdict;
  };
  derive();
  let validation = await validatePanelReport(report, policy, options);
  if (!validation.valid) {
    report.coverage = "incomplete";
    report.coverageReasons = [...new Set([...report.coverageReasons, ...validation.issues.map(issue => `${issue.code} ${issue.path || "/"}: ${issue.message}`)])];
    derive();
    validation = await validatePanelReport(report, policy, options);
  }
  return validation;
}

/**
 * Indexes of a slot's findings that the panel contract rejects, each with its reasons. The slot's findings are validated
 * alone against the run's report so one slot's invalid finding never removes another slot's valid one. An issue in a
 * slot run belongs to that slot only: one in the slot's own run (`ownRun`, its index in `base.slotRuns`) excludes all of
 * its findings, and one in another slot's run is that run's problem, reported by the final validation. A structural
 * issue stops the validator before its semantic checks, so the remaining findings are validated again without the
 * excluded ones; while the report fails any other structural check, no finding of the slot can be shown valid.
 */
async function invalidCandidates(base: PanelReport, ownRun: number, candidates: { findings: PanelFinding[]; evidence: Map<string, Evidence> }, request: PanelRunRequest, options: Parameters<typeof validatePanelReport>[2]): Promise<Map<number, string>> {
  const excluded = new Map<number, string>();
  const add = (index: number, reason: string) => excluded.set(index, excluded.has(index) ? `${excluded.get(index)}; ${reason}` : reason);
  for (;;) {
    const remaining = candidates.findings.flatMap((finding, index) => excluded.has(index) ? [] : [{ finding, index }]);
    if (!remaining.length) return excluded;
    const cited = new Set(remaining.flatMap(item => item.finding.evidenceIds));
    const evidence = [...candidates.evidence.values()].filter(item => cited.has(item.id));
    const provisional: PanelReport = { ...base, evidence, findings: remaining.map(item => item.finding), coverage: "incomplete", coverageReasons: ["Provisional per-slot validation."] };
    const verdict = derivePanelVerdict(provisional, request.policy);
    if (verdict === undefined) delete provisional.verdict; else provisional.verdict = verdict;
    const validation = await validatePanelReport(provisional, request.policy, options);
    // Structural issues are reported alone, without the semantic checks of any finding.
    const structural = panelStructureIssues("panelReport", provisional).length > 0;
    const before = excluded.size;
    let unattributed: string | undefined;
    let ownRunIssue: string | undefined;
    for (const issue of validation.issues) {
      const runMatch = /^\/slotRuns\/(\d+)(?:\/|$)/.exec(issue.path);
      if (runMatch && Number(runMatch[1]) === ownRun) { ownRunIssue ??= `${issue.path}: ${issue.message}`; continue; }
      if (runMatch && !structural) continue;
      const findingMatch = /^\/findings\/(\d+)(?:\/|$)/.exec(issue.path);
      const target = findingMatch ? remaining[Number(findingMatch[1])] : undefined;
      if (target) { add(target.index, issue.message); continue; }
      const evidenceMatch = /^\/evidence\/(\d+)(?:\/|$)/.exec(issue.path);
      if (evidenceMatch) {
        const id = evidence[Number(evidenceMatch[1])]?.id;
        for (const item of remaining) if (id !== undefined && item.finding.evidenceIds.includes(id)) add(item.index, issue.message);
        continue;
      }
      if (issue.code === "REVIEWFN_PANEL_SCHEMA") unattributed ??= `${issue.path || "/"}: ${issue.message}`;
    }
    if (ownRunIssue) {
      for (const item of remaining) add(item.index, `the slot's own run is invalid (${ownRunIssue})`);
      return excluded;
    }
    if (excluded.size > before) continue;
    if (unattributed) for (const item of remaining) add(item.index, `the slot's findings could not be validated (${unattributed})`);
    return excluded;
  }
}

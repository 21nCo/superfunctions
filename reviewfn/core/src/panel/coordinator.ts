import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createAttemptId, digestJson, stableStringify } from "../canonical.js";
import {
  assembleReviewReport, componentDiagnostics, fallbackDiagnostics, harnessAuthDiagnostics, harnessSecrets, normalizeHarnessOutput,
  preflightContexts, preflightExecution, preflightSince, prepareReview, reviewRunId, type PreparedReview, type SharedRunDependencies,
} from "../coordinator.js";
import { ReviewFnError } from "../errors.js";
import { redactText } from "../redaction.js";
import type { Evidence, Finding, HarnessCapabilities, HarnessInput, HarnessOutput, PreflightDiagnostic, PreflightResult, ReviewFnConfig, ReviewReport, ReviewRunRequest } from "../types.js";
import { defaultLensRegistry, type LensRegistry } from "./lenses.js";
import { effectiveMaxConcurrentSlots } from "./policy.js";
import { buildSlotPrompt, PANEL_PROMPT_VERSION, type PriorStageFinding, type SlotScope } from "./prompt.js";
import { lensOutputSchema, validateLensPayload } from "./schema.js";
import type { PanelFinding, PanelFindingSeverity, PanelPolicy, PanelReport, PanelReportValidationResult, PanelSlot, SlotIdentity, SlotRun, SlotRunTerminal, SlotVoidReason } from "./types.js";
import { credentialFingerprint, derivePanelVerdict, panelPolicyDigest, slotIdentityKey, validatePanelPolicy, validatePanelReport } from "./validate.js";
import { GitSlotWorkspaceProvider, removeTree, type GitSlotWorkspaceOptions, type SlotWorkspace, type SlotWorkspaceProvider } from "./workspace.js";

/** Coverage reason code when a stage has fewer completed runs with distinct identities than its quorum. */
export const PANEL_QUORUM_UNMET = "REVIEWFN_PANEL_QUORUM_UNMET";
export const PANEL_SLOT_OUTPUT_ARTIFACT_KIND = "panel-slot-output";
export const PANEL_REPORT_ARTIFACT_KIND = "panel-report";
const DEFAULT_ABORT_GRACE_MS = 10_000;
const MAX_LISTED_PATHS = 20;

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
  /** How long an aborted harness may take to stop before its slot is abandoned and its checkout removed. */
  abortGraceMs?: number;
  /** Source of credential values for fingerprints and redaction; `process.env` by default. */
  environment?: NodeJS.ProcessEnv;
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
}

interface SlotRecord {
  slot: PanelSlot & { stage: 1 | 2 };
  run: SlotRun;
  output: SlotHarnessOutput;
  reasons: string[];
  promptDigest: string;
}

interface RunContext {
  request: PanelRunRequest;
  prepared: PreparedReview;
  runId: string;
  secrets: string[];
  resolved: Map<string, PreflightResult["resolved"]>;
  provider: SlotWorkspaceProvider;
  runSignal: AbortSignal;
  cleanupErrors: string[];
}

const SEVERITY_RANK: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
const COUNTING = new Set<SlotRunTerminal>(["completed", "collapsed"]);

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function emptyOutput(terminal: HarnessOutput["terminal"], error: string): SlotHarnessOutput {
  return { terminal, requirements: [], assessments: [], evidence: [], findings: [], inspectedPaths: [], uninspected: [{ scope: "review", reason: error }], events: [], error };
}

/** The configuration a slot runs under: the run's configuration with the slot's harness and inference. */
export function slotConfiguration(config: ReviewFnConfig, slot: PanelSlot): ReviewFnConfig {
  const executable = config.harness.adapter === slot.harness.adapter ? config.harness.executable : undefined;
  return { ...config, harness: { adapter: slot.harness.adapter, version: slot.harness.version, ...(executable ? { executable } : {}) }, inference: { ...slot.inference } };
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

  public constructor(private readonly dependencies: PanelCoordinatorDependencies) {
    this.lenses = dependencies.lenses ?? defaultLensRegistry();
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
    const runId = digestJson({ kind: "reviewfn-panel", change: identityChange, contextDigest: prepared.context.digest, policy: request.policy, config: request.config, panelPolicyDigest: policyDigest, tests: prepared.tests.map(({ startedAt, finishedAt, runtimeMs, ...receipt }) => receipt), promptVersion: PANEL_PROMPT_VERSION, ...(request.since === undefined ? {} : { since: request.since }) });
    const environment = this.dependencies.environment ?? process.env;
    const secrets = harnessSecrets([request.config.inference.credentialEnv, ...policy.slots.map(slot => slot.inference.credentialEnv)], environment);
    const runController = new AbortController();
    const forwardAbort = () => runController.abort();
    request.signal?.addEventListener("abort", forwardAbort, { once: true });
    if (request.signal?.aborted) runController.abort();
    const cleanupErrors: string[] = [];
    let records: SlotRecord[];
    let context: RunContext;
    const parent = await mkdtemp(path.join(this.dependencies.workspaceRoot ?? tmpdir(), "reviewfn-panel-"));
    try {
      const provider = (this.dependencies.workspaces ?? (options => new GitSlotWorkspaceProvider(options)))({ objectStore: request.root, headCommit: prepared.change.headCommit, parent });
      context = { request, prepared, runId, secrets, resolved, provider, runSignal: runController.signal, cleanupErrors };
      const stageOne = await this.runStage(1, context, undefined);
      // Stage 2 always runs, whatever stage 1 found, and is told what stage 1 reported.
      const stageTwo = await this.runStage(2, context, priorFindings(stageOne));
      records = [...stageOne, ...stageTwo];
    } finally {
      request.signal?.removeEventListener("abort", forwardAbort);
      // Every slot removed its own checkout; this also removes anything an abandoned harness left, before the report is built.
      await removeTree(parent).catch(error => { cleanupErrors.push(`The run's checkout directory was not removed: ${message(error)}`); });
    }
    const quorum = collapseAndCount(records, policy);
    const requirementsReport = await this.requirementsReport(records, context, diagnostics);
    return this.assemble({ context, records, quorum, requirementsReport, policyDigest });
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
      if (!harness) continue;
      const config = slotConfiguration(request.config, slot);
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

  /** Run one stage's slots in policy order, at most `maxConcurrentSlots` at once, within the stage's wall-time budget. */
  private async runStage(stage: 1 | 2, context: RunContext, prior: PriorStageFinding[] | undefined): Promise<SlotRecord[]> {
    const slots = context.request.panelPolicy.slots.filter((slot): slot is PanelSlot & { stage: 1 | 2 } => slot.stage === stage);
    const deadline = Date.now() + context.request.policy.limits.harnessTimeoutMs;
    const queue = [...slots];
    const records = new Map<string, SlotRecord>();
    const worker = async () => {
      for (let slot = queue.shift(); slot; slot = queue.shift()) records.set(slot.id, await this.runSlot(slot, context, deadline, prior));
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
      harnessVersion: nonblank(resolved?.harnessVersion) ? resolved.harnessVersion : harness?.capabilities.version || slot.harness.version,
      provider: slot.inference.provider,
      model: nonblank(resolved?.model) ? resolved.model : slot.inference.model,
      auth: slot.inference.auth,
      ...(credential ? { credentialFingerprint: credentialFingerprint(credential) } : {}),
    };
  }

  /** Run one slot to a terminal outcome. Never throws; its checkout is removed whatever happened. */
  private async runSlot(slot: PanelSlot & { stage: 1 | 2 }, context: RunContext, deadline: number, prior: PriorStageFinding[] | undefined): Promise<SlotRecord> {
    const now = this.dependencies.now ?? (() => new Date());
    const { request, prepared } = context;
    const startedAt = now().toISOString();
    const baseIdentity = this.configuredIdentity(slot, context);
    const requirements = request.panelPolicy.requirementsSlot === slot.id;
    const finish = (terminal: SlotRunTerminal, reasons: string[], output: SlotHarnessOutput, extra: Partial<SlotRun> = {}, promptDigest = ""): SlotRecord => ({
      slot, output, reasons, promptDigest,
      run: { slotId: slot.id, identity: baseIdentity, terminal, voidReasons: [], startedAt, finishedAt: now().toISOString(), ...extra },
    });
    if (context.runSignal.aborted) return finish("canceled", ["The panel run was canceled before the slot started."], emptyOutput("canceled", "The panel run was canceled before the slot started."));
    const stageBudget = `Stage ${slot.stage} exhausted its ${request.policy.limits.harnessTimeoutMs} ms budget`;
    if (deadline - Date.now() <= 0) return finish("timed_out", [`${stageBudget} before the slot started.`], emptyOutput("timed_out", "Stage budget exhausted."));
    const maxOutputBytes = Math.min(slot.budget.maxOutputBytes, request.policy.limits.maxOutputBytes);
    let workspace: SlotWorkspace | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // Creating the checkout is bounded by the stage deadline; the slot's own timeout starts once its checkout exists.
      const creation = new AbortController();
      const creationTimer = setTimeout(() => creation.abort(), Math.max(1, deadline - Date.now()));
      try { workspace = await context.provider.create(slot.id, AbortSignal.any([context.runSignal, creation.signal])); }
      catch (error) {
        const terminal = context.runSignal.aborted ? "canceled" : creation.signal.aborted ? "timed_out" : "failed";
        const reason = terminal === "timed_out" ? `${stageBudget} while the slot checkout was created.` : `The slot checkout could not be created: ${message(error)}`;
        return finish(terminal, [reason], emptyOutput(terminal, reason));
      } finally { clearTimeout(creationTimer); }
      const slotLimit = Math.min(slot.budget.timeoutMs, request.policy.limits.harnessTimeoutMs);
      const timeoutMs = Math.max(1, Math.min(slotLimit, deadline - Date.now()));
      const slotController = new AbortController();
      let timedOut = false;
      timer = setTimeout(() => { timedOut = true; slotController.abort(); }, timeoutMs);
      const signal = AbortSignal.any([context.runSignal, slotController.signal]);
      const lens = this.lenses.get(slot.lens)!;
      const config = slotConfiguration(request.config, slot);
      const scope: SlotScope = requirements || request.panelPolicy.incremental === "full" || request.since === undefined
        ? { mode: "full", hunks: prepared.changeDetail.hunks }
        : { mode: "delta", hunks: prepared.changeDetail.hunks, delta: prepared.changeDetail.delta, since: request.since };
      const prompt = buildSlotPrompt({ slot, lens, change: prepared.change, context: prepared.context, config, policy: request.policy, tests: prepared.tests, scope, priorFindings: prior, requirements });
      const slotPolicy = { ...request.policy, limits: { ...request.policy.limits, harnessTimeoutMs: timeoutMs, maxOutputBytes } };
      const harness = this.dependencies.harnesses.find(item => item.capabilities.id === slot.harness.adapter)!;
      const input: SlotHarnessInput = { runId: context.runId, workspace: workspace.path, change: prepared.change, context: prepared.context, policy: slotPolicy, configuration: config, testReceipts: prepared.tests, prompt: prompt.prompt, ...(requirements ? {} : { outputSchema: lensOutputSchema }), signal, slot };
      const settled = await settle(Promise.resolve().then(() => harness.run(input)), signal, this.dependencies.abortGraceMs ?? DEFAULT_ABORT_GRACE_MS);
      clearTimeout(timer);
      const reasons: string[] = [];
      let raw: SlotHarnessOutput;
      if (settled.abandoned) raw = emptyOutput(timedOut ? "timed_out" : "canceled", "The harness did not stop after it was aborted; the slot was abandoned.");
      else if (settled.error !== undefined) raw = emptyOutput(timedOut ? "timed_out" : context.runSignal.aborted ? "canceled" : "failed", message(settled.error));
      else raw = settled.value as SlotHarnessOutput;
      const observed: SlotObservation = raw && typeof raw === "object" && raw.observed && typeof raw.observed === "object" ? raw.observed : {};
      let outputBytes = 0;
      try { outputBytes = Buffer.byteLength(JSON.stringify(raw && typeof raw === "object" ? { findings: raw.findings, evidence: raw.evidence, inspectedPaths: raw.inspectedPaths, uninspected: raw.uninspected, requirements: raw.requirements, assessments: raw.assessments } : null) ?? ""); }
      catch { /* Unserializable output fails payload validation below. */ }
      let output: SlotHarnessOutput = normalizeHarnessOutput(raw, { secrets: context.secrets, aborted: context.runSignal.aborted, payloadErrors: requirements ? undefined : payload => validateLensPayload({ findings: payload.findings, evidence: payload.evidence, inspectedPaths: payload.inspectedPaths, uninspected: payload.uninspected }) });
      if (!requirements) output = { ...output, requirements: [], assessments: [] };
      if (timedOut && !context.runSignal.aborted) { output.terminal = "timed_out"; reasons.push(timeoutMs < slotLimit ? `${stageBudget} while the slot ran.` : `The slot exceeded its ${timeoutMs} ms timeout.`); }
      else if (outputBytes > maxOutputBytes && output.terminal !== "canceled") { output.terminal = "timed_out"; reasons.push(`The slot output (${outputBytes} bytes) exceeded its ${maxOutputBytes}-byte limit.`); }
      if (output.terminal !== "completed" && output.error) reasons.push(redactText(output.error, context.secrets));
      if (output.terminal === "malformed") reasons.push(...output.uninspected.map(item => `${item.scope}: ${item.reason}`));
      const check = await workspace.verify();
      const identity: SlotIdentity = {
        ...baseIdentity,
        ...(nonblank(observed.harnessVersion) ? { harnessVersion: redactText(observed.harnessVersion, context.secrets) } : {}),
        ...(nonblank(observed.model) ? { model: redactText(observed.model, context.secrets) } : {}),
      };
      if (!identity.credentialFingerprint && nonblank(observed.accountIdentity)) identity.credentialFingerprint = credentialFingerprint(observed.accountIdentity);
      const voidReasons: SlotVoidReason[] = [];
      if (slot.inference.model !== "configured" && identity.model !== slot.inference.model) { voidReasons.push("model_mismatch"); reasons.push(`The harness served model ${identity.model}, not the configured ${slot.inference.model}.`); }
      if (!check.unchanged) { voidReasons.push("workspace_mutated"); reasons.push(check.reason ?? "The slot changed its checkout."); }
      const disallowed = Array.isArray(observed.disallowedTools) ? observed.disallowedTools.filter(nonblank).map(tool => redactText(tool, context.secrets)) : [];
      if (disallowed.length) { voidReasons.push("disallowed_tool_use"); reasons.push(`The harness used disallowed tools: ${disallowed.join(", ")}.`); }
      let terminal: SlotRunTerminal = output.terminal;
      if (voidReasons.length) terminal = "void";
      else if (terminal === "completed" && identity.harnessVersion !== slot.harness.version) { terminal = "failed"; reasons.push(`The harness reported version ${identity.harnessVersion}, not the pinned ${slot.harness.version}.`); }
      const usage = observedUsage(observed.usage);
      const transcript = request.config.retainTranscript && output.transcript ? await this.dependencies.artifacts.put("redacted-transcript", redactText(output.transcript, context.secrets), prepared.retention.transcriptDays).catch(() => undefined) : undefined;
      let stored: { id: string; digest: string } | undefined;
      try {
        const document = { slotId: slot.id, stage: slot.stage, lens: { id: lens.id, version: lens.version }, promptDigest: prompt.digest, terminal, voidReasons, reasons, identity, ...(transcript ? { redactedTranscriptArtifact: transcript.id } : {}), output: { findings: output.findings, evidence: output.evidence, inspectedPaths: output.inspectedPaths, uninspected: output.uninspected, requirements: output.requirements, assessments: output.assessments, events: output.events } };
        stored = await this.dependencies.artifacts.put(PANEL_SLOT_OUTPUT_ARTIFACT_KIND, JSON.stringify(document, null, 2), prepared.retention.reportDays);
      } catch (error) { reasons.push(`The slot output could not be stored: ${message(error)}`); }
      return finish(terminal, reasons, output, { identity, voidReasons, ...(stored ? { outputArtifact: stored.id, outputDigest: stored.digest } : {}), ...(usage ? { usage } : {}) }, prompt.digest);
    } catch (error) {
      const terminal = context.runSignal.aborted ? "canceled" : "failed";
      const reason = `The slot failed unexpectedly: ${message(error)}`;
      return finish(terminal, [reason], emptyOutput(terminal, reason));
    } finally {
      if (timer) clearTimeout(timer);
      if (workspace) await workspace.remove().catch(error => { context.cleanupErrors.push(`Slot ${slot.id} checkout was not removed: ${message(error)}`); });
    }
  }

  /** The requirements slot's 0.1 report, built through the shared 0.1 report path from the slot's final outcome. */
  private async requirementsReport(records: SlotRecord[], context: RunContext, diagnostics: PreflightDiagnostic[]): Promise<{ report?: ReviewReport; reasons: string[] }> {
    const slotId = context.request.panelPolicy.requirementsSlot;
    const record = records.find(item => item.slot.id === slotId);
    if (!record) return { reasons: [] };
    const output = structuredClone(record.output) as HarnessOutput;
    // A run that does not count (void, or a harness version other than the pinned one) never yields a completed report.
    if (!COUNTING.has(record.run.terminal)) {
      if (output.terminal === "completed") output.terminal = "failed";
      output.error = `Requirements slot ${record.slot.id} is ${record.run.terminal}: ${record.reasons.join(" ")}`;
    }
    const config = slotConfiguration(context.request.config, record.slot);
    const request = { ...context.request, config };
    try {
      const { report } = await assembleReviewReport(this.dependencies, {
        request, prepared: context.prepared, output, secrets: context.secrets, diagnostics,
        harness: { id: record.slot.harness.adapter, version: record.run.identity.harnessVersion },
        promptDigest: record.promptDigest, runId: reviewRunId(context.prepared, request, record.run.identity.harnessVersion), attemptId: context.request.attemptId ?? createAttemptId(),
      });
      return { report, reasons: [] };
    } catch (error) {
      return { reasons: [`The requirements report could not be built: ${message(error)}`] };
    }
  }

  private async assemble(input: { context: RunContext; records: SlotRecord[]; quorum: PanelQuorumStatus[]; requirementsReport: { report?: ReviewReport; reasons: string[] }; policyDigest: string }): Promise<PanelRunResult> {
    const { context, records, quorum } = input;
    const { request, prepared } = context;
    const now = this.dependencies.now ?? (() => new Date());
    const coverageReasons = [
      ...prepared.changeDetail.coverageReasons,
      ...prepared.context.incompleteReasons,
      ...prepared.executionErrors,
      ...prepared.tests.filter(receipt => receipt.exitCode !== 0 || receipt.timedOut || receipt.canceled).map(receipt => `Test ${receipt.id} did not pass (exit ${String(receipt.exitCode)}).`),
      ...(context.runSignal.aborted ? ["The panel run was canceled."] : []),
      ...quorum.filter(item => !item.met).map(item => `${PANEL_QUORUM_UNMET}: stage ${item.stage} has ${item.completed} completed slot run(s) with distinct identities; its quorum is ${item.required}.`),
      ...input.requirementsReport.reasons,
    ];
    const base: PanelReport = {
      schemaVersion: 1, kind: "reviewfn-panel", runId: context.runId, createdAt: now().toISOString(), change: prepared.change,
      ...(prepared.changeDetail.detail ? { changeDetail: prepared.changeDetail.detail } : {}),
      contextManifestDigest: prepared.context.digest, panelPolicyDigest: input.policyDigest, slots: structuredClone(request.panelPolicy.slots), slotRuns: records.map(record => record.run),
      ...(input.requirementsReport.report ? { requirementsReport: input.requirementsReport.report } : {}),
      gateReceipts: prepared.tests, evidence: [], findings: [], clusters: [], coverage: "complete", coverageReasons: [],
    };
    const options = { sourceControl: this.dependencies.sourceControl, root: request.root, context: prepared.context, artifacts: this.dependencies.artifacts, panelPolicy: request.panelPolicy };
    const admitted = new Map<string, number>();
    const union = new Map<string, PanelFinding>();
    const evidence = new Map<string, Evidence>();
    const contributing = records.filter(record => COUNTING.has(record.run.terminal));
    for (const record of contributing) {
      const candidates = slotCandidates(record);
      const excluded = await invalidCandidates(base, candidates, request, options);
      for (const [index, reason] of excluded) coverageReasons.push(`Slot ${record.slot.id} finding "${candidates.findings[index].title}" was excluded: ${reason}`);
      candidates.findings.forEach((finding, index) => {
        if (excluded.has(index)) return;
        admitted.set(record.slot.id, (admitted.get(record.slot.id) ?? 0) + 1);
        for (const id of finding.evidenceIds) evidence.set(id, candidates.evidence.get(id)!);
        const existing = union.get(finding.fingerprint);
        if (!existing) { union.set(finding.fingerprint, finding); return; }
        // Union, not vote: agreement is recorded in origins and never filters.
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
    const cited = new Set(findings.flatMap(finding => finding.evidenceIds));
    // Delta mode makes the delta the primary scope; otherwise every changed path must be inspected by a slot that succeeded.
    const scopePaths = request.panelPolicy.incremental === "delta" && request.since !== undefined && prepared.changeDetail.detail?.deltaPaths ? prepared.changeDetail.detail.deltaPaths : prepared.change.changedPaths;
    const inspected = new Set(contributing.flatMap(record => record.output.inspectedPaths));
    const uninspected = scopePaths.filter(item => !inspected.has(item));
    if (contributing.length && uninspected.length) coverageReasons.push(`No completed slot inspected ${uninspected.slice(0, MAX_LISTED_PATHS).join(", ")}${uninspected.length > MAX_LISTED_PATHS ? ` and ${uninspected.length - MAX_LISTED_PATHS} more path(s)` : ""}.`);
    coverageReasons.push(...context.cleanupErrors);
    const report: PanelReport = {
      ...base,
      evidence: [...evidence.values()].filter(item => cited.has(item.id)),
      findings,
      coverage: coverageReasons.length ? "incomplete" : "complete",
      coverageReasons: [...new Set(coverageReasons)],
    };
    report.verdict = derivePanelVerdict(report, request.policy);
    let validation = await validatePanelReport(report, request.policy, options);
    if (!validation.valid) {
      report.coverage = "incomplete";
      report.coverageReasons.push(...validation.issues.map(issue => `${issue.code} ${issue.path || "/"}: ${issue.message}`));
      report.coverageReasons = [...new Set(report.coverageReasons)];
      report.verdict = derivePanelVerdict(report, request.policy);
      if (report.verdict === undefined) delete report.verdict;
      validation = await validatePanelReport(report, request.policy, options);
    }
    if (report.verdict === undefined) delete report.verdict;
    const stored = await this.dependencies.artifacts.put(PANEL_REPORT_ARTIFACT_KIND, JSON.stringify(report, null, 2), prepared.retention.reportDays);
    const slots = records.map(record => ({ slotId: record.slot.id, stage: record.slot.stage, terminal: record.run.terminal, reasons: record.reasons, admittedFindings: admitted.get(record.slot.id) ?? 0 }));
    return { report, reportArtifact: stored.id, slots, quorum, validation };
  }
}

/** Stage-1 findings for stage 2: every finding from a stage-1 slot that completed, merged by fingerprint. */
function priorFindings(records: SlotRecord[]): PriorStageFinding[] {
  const merged = new Map<string, PriorStageFinding>();
  for (const record of records) {
    if (record.run.terminal !== "completed") continue;
    for (const finding of record.output.findings) {
      const existing = merged.get(finding.fingerprint);
      if (existing) { if (!existing.origins.includes(record.slot.id)) existing.origins.push(record.slot.id); continue; }
      merged.set(finding.fingerprint, { fingerprint: finding.fingerprint, severity: finding.severity, category: finding.category, title: finding.title, trigger: finding.trigger, ...(finding.anchor ? { anchor: finding.anchor } : {}), origins: [record.slot.id] });
    }
  }
  return [...merged.values()];
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
 * Indexes of a slot's findings that the panel contract rejects, each with its reasons. The slot's findings are validated
 * alone against the run's report so one slot's invalid finding never removes another slot's valid one.
 */
async function invalidCandidates(base: PanelReport, candidates: { findings: PanelFinding[]; evidence: Map<string, Evidence> }, request: PanelRunRequest, options: Parameters<typeof validatePanelReport>[2]): Promise<Map<number, string>> {
  const cited = new Set(candidates.findings.flatMap(finding => finding.evidenceIds));
  const evidence = [...candidates.evidence.values()].filter(item => cited.has(item.id));
  const provisional: PanelReport = { ...base, evidence, findings: candidates.findings, coverage: "incomplete", coverageReasons: ["Provisional per-slot validation."] };
  provisional.verdict = derivePanelVerdict(provisional, request.policy);
  if (provisional.verdict === undefined) delete provisional.verdict;
  const validation = await validatePanelReport(provisional, request.policy, options);
  const excluded = new Map<number, string>();
  const add = (index: number, reason: string) => excluded.set(index, excluded.has(index) ? `${excluded.get(index)}; ${reason}` : reason);
  for (const issue of validation.issues) {
    const findingMatch = /^\/findings\/(\d+)(?:\/|$)/.exec(issue.path);
    if (findingMatch) { add(Number(findingMatch[1]), issue.message); continue; }
    const evidenceMatch = /^\/evidence\/(\d+)(?:\/|$)/.exec(issue.path);
    if (!evidenceMatch) continue;
    const id = evidence[Number(evidenceMatch[1])]?.id;
    candidates.findings.forEach((finding, index) => { if (id !== undefined && finding.evidenceIds.includes(id)) add(index, issue.message); });
  }
  return excluded;
}

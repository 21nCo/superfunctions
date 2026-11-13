import { digestJson, sha256, stableStringify } from "../canonical.js";
import { verifyChangeDetail } from "../change.js";
import { ReviewFnError } from "../errors.js";
import { harnessOutputSchema } from "../schema.js";
import type { ArtifactStore, ContextManifest, Evidence, ReviewPolicy, ReviewReport, SourceControlAdapter, Verdict } from "../types.js";
import { deriveVerdict, validateReport } from "../validator.js";
import { PANEL_CREDENTIAL_FINGERPRINT_PATTERN, PANEL_DIGEST_PATTERN, PANEL_NONBLANK_PATTERN, PANEL_SLOT_ID_PATTERN, PANEL_TIMESTAMP_PATTERN, panelSchemaDefs } from "./schema.js";
import { PANEL_DEFAULT_MAX_CONCURRENT_SLOTS } from "./types.js";
import type { PanelFinding, PanelPolicy, PanelReport, PanelReportIssueCode, PanelReportValidationResult, PanelSlot, PanelValidationCode, PanelValidationIssue, PanelValidationResult, SlotIdentity, SlotRun } from "./types.js";

/** The closed set of panel validation codes. */
export const PANEL_VALIDATION_CODES: readonly PanelValidationCode[] = Object.freeze([
  "REVIEWFN_PANEL_SCHEMA", "REVIEWFN_PANEL_SLOT_DUPLICATE", "REVIEWFN_PANEL_SLOT_UNKNOWN",
  "REVIEWFN_PANEL_FINDING_INVALID", "REVIEWFN_PANEL_ORIGIN_UNKNOWN", "REVIEWFN_PANEL_VERIFICATION_INVALID",
  "REVIEWFN_PANEL_DISPOSITION_INVALID", "REVIEWFN_PANEL_VERDICT_MISMATCH",
]);

type Issues = PanelValidationIssue<PanelReportIssueCode>[];
type Check = (value: unknown, path: string, issues: Issues) => void;

function pointer(path: string, key: string | number): string {
  return `${path}/${String(key).replaceAll("~", "~0").replaceAll("/", "~1")}`;
}
function add(issues: Issues, code: PanelReportIssueCode, path: string, message: string): void {
  issues.push({ code, path: path || "/", message });
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Structural checks mirror `panelSchemaDefs` keyword for keyword; the schema agreement tests hold them equal.
// Properties whose value is `undefined` count as absent, as in Ajv and JSON serialization.
function string(pattern?: string, minLength = 0): Check {
  const expression = pattern === undefined ? undefined : new RegExp(pattern, "u");
  return (value, path, issues) => {
    if (typeof value !== "string") return add(issues, "REVIEWFN_PANEL_SCHEMA", path, "must be a string.");
    if ([...value].length < minLength) add(issues, "REVIEWFN_PANEL_SCHEMA", path, `must have at least ${minLength} character(s).`);
    if (expression && !expression.test(value)) add(issues, "REVIEWFN_PANEL_SCHEMA", path, `must match ${pattern}.`);
  };
}
function numeric(integer: boolean, minimum?: number, maximum?: number): Check {
  return (value, path, issues) => {
    if (typeof value !== "number" || !Number.isFinite(value) || (integer && !Number.isInteger(value))) return add(issues, "REVIEWFN_PANEL_SCHEMA", path, `must be ${integer ? "an integer" : "a number"}.`);
    if (minimum !== undefined && value < minimum) add(issues, "REVIEWFN_PANEL_SCHEMA", path, `must be >= ${minimum}.`);
    if (maximum !== undefined && value > maximum) add(issues, "REVIEWFN_PANEL_SCHEMA", path, `must be <= ${maximum}.`);
  };
}
const boolean: Check = (value, path, issues) => { if (typeof value !== "boolean") add(issues, "REVIEWFN_PANEL_SCHEMA", path, "must be a boolean."); };
function oneOf(values: readonly (string | number)[]): Check {
  return (value, path, issues) => { if (!values.includes(value as string | number)) add(issues, "REVIEWFN_PANEL_SCHEMA", path, `must be one of ${values.map(item => JSON.stringify(item)).join(", ")}.`); };
}
function nullable(check: Check): Check {
  return (value, path, issues) => { if (value !== null) check(value, path, issues); };
}
function array(item: Check, options: { min?: number; max?: number; unique?: boolean } = {}): Check {
  return (value, path, issues) => {
    if (!Array.isArray(value)) return add(issues, "REVIEWFN_PANEL_SCHEMA", path, "must be an array.");
    if (options.min !== undefined && value.length < options.min) add(issues, "REVIEWFN_PANEL_SCHEMA", path, `must have at least ${options.min} item(s).`);
    if (options.max !== undefined && value.length > options.max) add(issues, "REVIEWFN_PANEL_SCHEMA", path, `must have at most ${options.max} item(s).`);
    if (options.unique && new Set(value.map(entry => stableStringify(entry))).size !== value.length) add(issues, "REVIEWFN_PANEL_SCHEMA", path, "must not contain duplicate items.");
    value.forEach((entry, index) => item(entry, pointer(path, index), issues));
  };
}
function object(properties: Record<string, Check>, required: readonly string[], rule?: (value: Record<string, unknown>, path: string, issues: Issues) => void): Check {
  return (value, path, issues) => {
    if (!isRecord(value)) return add(issues, "REVIEWFN_PANEL_SCHEMA", path, "must be an object.");
    for (const key of required) if (value[key] === undefined) add(issues, "REVIEWFN_PANEL_SCHEMA", path, `must have required property ${key}.`);
    for (const [key, entry] of Object.entries(value)) {
      if (entry === undefined) continue;
      const check = Object.hasOwn(properties, key) ? properties[key] : undefined;
      if (!check) add(issues, "REVIEWFN_PANEL_SCHEMA", pointer(path, key), "is not an allowed property.");
      else check(entry, pointer(path, key), issues);
    }
    rule?.(value, path, issues);
  };
}

const defs = panelSchemaDefs;
const text = string();
const nonblank = string(PANEL_NONBLANK_PATTERN);
const texts = array(text);
const slotId = string(PANEL_SLOT_ID_PATTERN);
const timestamp = string(PANEL_TIMESTAMP_PATTERN);
const count = numeric(true, 0);
const positive = numeric(true, 1);
const reasons = array(object({ scope: text, reason: text }, ["scope", "reason"]));

const sourceReference = object({ sourceId: text, anchor: text, excerpt: text }, defs.sourceReference.required);
const codeAnchor = object({ commit: text, path: text, startLine: positive, endLine: positive, symbol: text }, defs.codeAnchor.required);
const requirement = object({
  id: text, statement: nonblank, sources: array(sourceReference, { min: 1 }), category: oneOf(defs.requirement.properties.category.enum), scope: text,
  classification: oneOf(defs.requirement.properties.classification.enum), dependencies: texts, ambiguity: text,
  extraction: object({ harness: text, promptDigest: text }, defs.requirement.properties.extraction.required),
}, defs.requirement.required);
const assessment = object({
  requirementId: text, status: oneOf(defs.assessment.properties.status.enum), evidenceIds: texts, reasoning: text, gaps: texts,
  confidence: numeric(false, 0, 1), waiverReference: sourceReference,
}, defs.assessment.required);
const evidence = object({
  id: text, kind: oneOf(defs.evidence.properties.kind.enum), description: text, source: sourceReference, code: codeAnchor,
  receiptId: text, artifactDigest: text, sourceExclusionReason: string(undefined, 1),
}, defs.evidence.required);
const findingProperties = {
  fingerprint: text, category: text, title: nonblank, trigger: nonblank, impact: nonblank, direction: nonblank, anchor: codeAnchor, evidenceIds: texts,
  basis: oneOf(defs.finding.properties.basis.enum), requirementIds: texts, lifecycle: oneOf(defs.finding.properties.lifecycle.enum),
};
const finding = object({ ...findingProperties, severity: oneOf(defs.finding.properties.severity.enum) }, defs.finding.required);
const changeSnapshot = object({
  repositoryId: text, host: text, pullRequest: positive, targetBranch: text, baseCommit: text, headCommit: text, mergeBaseCommit: text, diffDigest: text, changedPaths: texts, capturedAt: text,
}, defs.changeSnapshot.required);
const changeDetail = object({ hunksArtifact: text, hunksDigest: text, since: text, deltaHunksArtifact: text, deltaHunksDigest: text, deltaPaths: texts }, defs.changeDetail.required);
const testReceipt = object({
  id: text, command: texts, cwd: text, commit: text, startedAt: text, finishedAt: text, runtimeMs: numeric(false, 0), exitCode: nullable(numeric(true)), signal: nullable(text),
  timedOut: boolean, canceled: boolean, stdoutArtifact: text, stderrArtifact: text, stdoutDigest: text, stderrDigest: text, limitations: texts,
}, defs.testReceipt.required);
const runConfiguration = object({
  schemaVersion: oneOf([1]), policyDigest: text, promptDigest: text,
  harness: object({ id: text, version: text }, ["id", "version"]),
  inference: object({ provider: text, model: text, auth: text }, ["provider", "model", "auth"]),
  execution: object({ adapter: text, timeoutMs: numeric(false), maxOutputBytes: numeric(false) }, ["adapter", "timeoutMs", "maxOutputBytes"]),
  contextAdapters: texts, reviewCategories: array(oneOf(defs.requirement.properties.category.enum)), profile: text,
}, defs.runConfiguration.required);
const reviewReport = object({
  schemaVersion: oneOf([1]), runId: text, attemptId: text, createdAt: text, change: changeSnapshot, contextManifestDigest: text, contextManifestArtifact: text,
  configuration: runConfiguration, execution: oneOf(defs.reviewReport.properties.execution.enum), coverage: oneOf(defs.reviewReport.properties.coverage.enum), coverageReasons: texts,
  verdict: oneOf(defs.reviewReport.properties.verdict.enum), requirements: array(requirement), assessments: array(assessment), evidence: array(evidence), findings: array(finding),
  tests: array(testReceipt), inspectedPaths: texts, uninspected: reasons, normalizedEventArtifact: text, redactedTranscriptArtifact: text, limitations: texts, changeDetail,
}, defs.reviewReport.required);

const panelSlot = object({
  id: slotId, stage: oneOf(defs.panelSlot.properties.stage.enum),
  harness: object({ adapter: nonblank, version: nonblank }, ["adapter", "version"]),
  inference: object({ provider: nonblank, model: nonblank, auth: nonblank, credentialEnv: nonblank }, ["provider", "model", "auth"]),
  lens: nonblank, budget: object({ timeoutMs: positive, maxOutputBytes: positive }, ["timeoutMs", "maxOutputBytes"]),
}, defs.panelSlot.required);
const panelPolicy = object({
  version: oneOf([1]), slots: array(panelSlot, { min: 1 }), quorum: object({ stage1: count, stage2: count }, ["stage1", "stage2"]),
  requirementsSlot: nullable(slotId), maxConcurrentSlots: numeric(true, 1, 8), incremental: oneOf(defs.panelPolicy.properties.incremental.enum),
}, defs.panelPolicy.required);
const slotIdentity = object({
  harnessAdapter: nonblank, harnessVersion: nonblank, provider: nonblank, model: nonblank, auth: nonblank, credentialFingerprint: string(PANEL_CREDENTIAL_FINGERPRINT_PATTERN),
}, defs.slotIdentity.required);
const slotRun = object({
  slotId, identity: slotIdentity, terminal: oneOf(defs.slotRun.properties.terminal.enum),
  voidReasons: array(oneOf(defs.slotRun.properties.voidReasons.items.enum), { unique: true }),
  startedAt: timestamp, finishedAt: timestamp, outputArtifact: nonblank, outputDigest: string(PANEL_DIGEST_PATTERN),
  usage: object({ inputTokens: count, outputTokens: count, costUsd: numeric(false, 0) }, []),
}, defs.slotRun.required, (value, path, issues) => {
  // Mirrors the schema's if/then/else: an absent terminal satisfies the `if`, as in JSON Schema.
  if (!Array.isArray(value.voidReasons)) return;
  const isVoid = value.terminal === undefined || value.terminal === "void";
  if (isVoid && value.voidReasons.length < 1) add(issues, "REVIEWFN_PANEL_SCHEMA", pointer(path, "voidReasons"), "must name at least one reason for a void run.");
  if (!isVoid && value.voidReasons.length > 0) add(issues, "REVIEWFN_PANEL_SCHEMA", pointer(path, "voidReasons"), "must be empty unless the run is void.");
});
const panelSeverity: Check = (value, path, issues) => {
  if (value === "info") add(issues, "REVIEWFN_PANEL_FINDING_INVALID", path, "info is never a panel finding severity; use critical, high, medium or low (P0–P3).");
  else oneOf(defs.panelFinding.properties.severity.enum)(value, path, issues);
};
const panelFinding = object({
  ...findingProperties, severity: panelSeverity,
  origins: array(object({ slotId, lens: nonblank }, defs.panelFindingOrigin.required), { min: 1 }),
  confidence: numeric(false, 0, 1), ruleIds: array(nonblank),
  verification: object({
    verdict: oneOf(defs.panelFindingVerification.properties.verdict.enum), slotId, evidenceIds: texts,
    onBase: oneOf(defs.panelFindingVerification.properties.onBase.enum), reason: nonblank,
  }, defs.panelFindingVerification.required),
  disposition: oneOf(defs.panelFinding.properties.disposition.enum), dispositionReason: nonblank, suppressionReference: sourceReference,
}, defs.panelFinding.required);
const panelReport = object({
  schemaVersion: oneOf([1]), kind: oneOf(["reviewfn-panel"]), runId: nonblank, createdAt: timestamp, change: changeSnapshot, changeDetail,
  panelPolicyDigest: string(PANEL_DIGEST_PATTERN), slots: array(panelSlot, { min: 1 }), slotRuns: array(slotRun), requirementsReport: reviewReport,
  gateReceipts: array(testReceipt), evidence: array(evidence), findings: array(panelFinding),
  clusters: array(object({ id: nonblank, findingFingerprints: array(text, { min: 1, unique: true }) }, defs.panelFindingCluster.required)),
  coverage: oneOf(defs.panelReport.properties.coverage.enum), coverageReasons: array(nonblank), verdict: oneOf(defs.panelReport.properties.verdict.enum),
}, defs.panelReport.required, (value, path, issues) => {
  if ((value.coverage === undefined || value.coverage === "incomplete") && Array.isArray(value.coverageReasons) && value.coverageReasons.length < 1) add(issues, "REVIEWFN_PANEL_SCHEMA", pointer(path, "coverageReasons"), "must state at least one reason for incomplete coverage.");
});
const lensOutput = object({ findings: array(object({ ...findingProperties, severity: panelSeverity }, defs.finding.required)), evidence: array(evidence), inspectedPaths: texts, uninspected: reasons }, harnessOutputSchema.required.filter(key => key !== "requirements" && key !== "assessments"));

const structures = { panelPolicy, slotIdentity, slotRun, panelFinding, panelReport, lensOutput } as const;
/** Documents with a JSON Schema in `panelSchemaDefs` (`lensOutput` is `lensOutputSchema`). */
export type PanelStructure = keyof typeof structures;

/**
 * Structural issues of `value` as a `kind` document: the TypeScript mirror of the corresponding JSON Schema.
 * It reports `REVIEWFN_PANEL_SCHEMA`, except an `info` panel or lens finding severity, which is `REVIEWFN_PANEL_FINDING_INVALID`.
 */
export function panelStructureIssues(kind: PanelStructure, value: unknown): PanelValidationIssue<PanelValidationCode>[] {
  const issues: Issues = [];
  structures[kind](value, "", issues);
  return issues as PanelValidationIssue<PanelValidationCode>[];
}
function structural(check: Check, value: unknown): Issues {
  const issues: Issues = [];
  check(value, "", issues);
  return issues;
}
function result<Code extends string>(issues: PanelValidationIssue<Code>[]): PanelValidationResult<Code> {
  return { valid: issues.length === 0, issues };
}
function duplicates<T>(values: readonly T[], key: (value: T) => string): Array<{ index: number; key: string }> {
  const seen = new Set<string>();
  const repeated: Array<{ index: number; key: string }> = [];
  values.forEach((value, index) => { const id = key(value); if (seen.has(id)) repeated.push({ index, key: id }); else seen.add(id); });
  return repeated;
}

/** First 16 hex characters of the SHA-256 of a credential value or a harness-reported account identity. The value itself is never stored. */
export function credentialFingerprint(value: string): string {
  if (typeof value !== "string" || value.length === 0) throw new ReviewFnError("REVIEWFN_CONFIG_INVALID", "A credential fingerprint requires a nonempty credential value or account identity.");
  return sha256(value).slice(0, 16);
}

/** Canonical key of the identity tuple; equal keys mean the same slot identity. */
export function slotIdentityKey(identity: SlotIdentity): string {
  return digestJson([identity.harnessAdapter, identity.harnessVersion, identity.provider, identity.model, identity.auth, identity.credentialFingerprint ?? null]);
}

/** Structure of a panel policy, unique slot IDs, and a `requirementsSlot` naming a stage-1 or stage-2 slot. */
export function validatePanelPolicy(value: unknown): PanelValidationResult<PanelValidationCode> {
  const issues = structural(panelPolicy, value);
  if (issues.length) return result(issues as PanelValidationIssue<PanelValidationCode>[]);
  const policy = value as PanelPolicy;
  for (const { index, key } of duplicates(policy.slots, slot => slot.id)) add(issues, "REVIEWFN_PANEL_SLOT_DUPLICATE", `/slots/${index}/id`, `Slot ${key} is declared more than once.`);
  if (policy.requirementsSlot !== null && !policy.slots.some(slot => slot.id === policy.requirementsSlot && slot.stage !== "verifier")) add(issues, "REVIEWFN_PANEL_SLOT_UNKNOWN", "/requirementsSlot", `requirementsSlot ${policy.requirementsSlot} names no stage-1 or stage-2 slot.`);
  return result(issues as PanelValidationIssue<PanelValidationCode>[]);
}

/** Digest of a valid panel policy with `maxConcurrentSlots` defaulted, recorded as `PanelReport.panelPolicyDigest`. */
export function panelPolicyDigest(policy: PanelPolicy): string {
  const validation = validatePanelPolicy(policy);
  if (!validation.valid) throw new ReviewFnError("REVIEWFN_CONFIG_INVALID", `Invalid panel policy: ${validation.issues.map(issue => `${issue.code} ${issue.path} ${issue.message}`).join("; ")}`);
  return digestJson({ ...policy, maxConcurrentSlots: policy.maxConcurrentSlots ?? PANEL_DEFAULT_MAX_CONCURRENT_SLOTS });
}

export function validateSlotIdentity(value: unknown): PanelValidationResult<PanelValidationCode> {
  return result(structural(slotIdentity, value) as PanelValidationIssue<PanelValidationCode>[]);
}

export function validateSlotRun(value: unknown): PanelValidationResult<PanelValidationCode> {
  return result(structural(slotRun, value) as PanelValidationIssue<PanelValidationCode>[]);
}

/** Checks a finding needs no report context for: severity, lifecycle and disposition. */
function intrinsicFindingIssues(finding: PanelFinding, path: string, issues: Issues): void {
  if (finding.lifecycle !== "new") add(issues, "REVIEWFN_PANEL_FINDING_INVALID", pointer(path, "lifecycle"), `Lifecycle ${finding.lifecycle} needs prior-finding provenance; panel findings are new.`);
  for (const { index, key } of duplicates(finding.origins, origin => origin.slotId)) add(issues, "REVIEWFN_PANEL_FINDING_INVALID", pointer(pointer(path, "origins"), index), `Origin slot ${key} is listed more than once.`);
  if (finding.disposition === "dropped" && finding.verification?.verdict !== "refuted") add(issues, "REVIEWFN_PANEL_DISPOSITION_INVALID", pointer(path, "disposition"), "A dropped finding requires a refuted verification.");
  if (finding.disposition === "suppressed" && !finding.suppressionReference) add(issues, "REVIEWFN_PANEL_DISPOSITION_INVALID", pointer(path, "disposition"), "A suppressed finding requires a suppression reference.");
  if (finding.disposition !== "suppressed" && finding.suppressionReference) add(issues, "REVIEWFN_PANEL_DISPOSITION_INVALID", pointer(path, "suppressionReference"), "Only a suppressed finding carries a suppression reference.");
  if (finding.disposition !== "reported" && finding.dispositionReason === undefined) add(issues, "REVIEWFN_PANEL_DISPOSITION_INVALID", pointer(path, "dispositionReason"), `A ${finding.disposition} finding requires a disposition reason.`);
}

/** Structure, severity, lifecycle and disposition of one panel finding; references are checked by `validatePanelReport`. */
export function validatePanelFinding(value: unknown): PanelValidationResult<PanelValidationCode> {
  const issues = structural(panelFinding, value);
  if (!issues.length) intrinsicFindingIssues(value as PanelFinding, "", issues);
  return result(issues as PanelValidationIssue<PanelValidationCode>[]);
}

/**
 * 0.1's verdict derivation over the requirements report plus the reported (not dropped or suppressed) panel findings.
 * Without a requirements report no requirement was assessed, so as in 0.1 the verdict is at most `needs_verification`.
 */
export function derivePanelVerdict(report: Pick<PanelReport, "coverage" | "findings" | "requirementsReport">, policy: ReviewPolicy): Verdict | undefined {
  const requirements = report.requirementsReport;
  const coverage = report.coverage === "complete" && (requirements?.coverage ?? "complete") === "complete" ? "complete" : "incomplete";
  return deriveVerdict({
    execution: requirements?.execution ?? "completed",
    coverage,
    requirements: requirements?.requirements ?? [],
    assessments: requirements?.assessments ?? [],
    findings: [...(requirements?.findings ?? []), ...report.findings.filter(finding => finding.disposition === "reported")],
  }, policy);
}

export interface PanelReportValidationOptions {
  sourceControl?: SourceControlAdapter;
  root?: string;
  /** Frozen context of the run, required to validate a completed requirements report's sources. */
  context?: ContextManifest;
  artifacts?: ArtifactStore;
}

const REPORT_CODES = new Set<PanelReportIssueCode>(["REVIEWFN_CHANGE_DETAIL_MISMATCH", "REVIEWFN_SINCE_NOT_ANCESTOR"]);
function reportIssue(error: string, path: string): PanelValidationIssue<PanelReportIssueCode> {
  const match = /^(REVIEWFN_[A-Z_]+): (.*)$/s.exec(error);
  const code = match && REPORT_CODES.has(match[1] as PanelReportIssueCode) ? match[1] as PanelReportIssueCode : "REVIEWFN_REPORT_INVALID";
  return { code, path, message: match && code !== "REVIEWFN_REPORT_INVALID" ? match[2] : error };
}

function slotRunIssues(report: PanelReport, slots: Map<string, PanelSlot>, issues: Issues): void {
  const order = new Map([...slots.keys()].map((id, index) => [id, index]));
  for (const { index, key } of duplicates(report.slotRuns, run => run.slotId)) add(issues, "REVIEWFN_PANEL_SLOT_DUPLICATE", `/slotRuns/${index}/slotId`, `Slot ${key} has more than one run.`);
  const groups = new Map<string, Array<{ run: SlotRun; index: number }>>();
  report.slotRuns.forEach((run, index) => {
    const path = `/slotRuns/${index}`;
    const slot = slots.get(run.slotId);
    if (!slot) return add(issues, "REVIEWFN_PANEL_SLOT_UNKNOWN", `${path}/slotId`, `Run references unknown slot ${run.slotId}.`);
    const { identity } = run;
    if (identity.harnessAdapter !== slot.harness.adapter || identity.provider !== slot.inference.provider || identity.auth !== slot.inference.auth) add(issues, "REVIEWFN_PANEL_SCHEMA", `${path}/identity`, `Run identity does not match slot ${slot.id}'s harness adapter, provider or auth mode.`);
    const mismatch = slot.inference.model !== "configured" && identity.model !== slot.inference.model;
    if (mismatch && (run.terminal === "completed" || run.terminal === "collapsed")) add(issues, "REVIEWFN_PANEL_SCHEMA", `${path}/terminal`, `Resolved model ${identity.model} differs from configured model ${slot.inference.model}; the run must be void with model_mismatch.`);
    if (!mismatch && run.voidReasons.includes("model_mismatch")) add(issues, "REVIEWFN_PANEL_SCHEMA", `${path}/voidReasons`, "model_mismatch requires a resolved model that differs from the configured model.");
    if (Date.parse(run.finishedAt) < Date.parse(run.startedAt)) add(issues, "REVIEWFN_PANEL_SCHEMA", `${path}/finishedAt`, "A run cannot finish before it starts.");
    const group = `${String(slot.stage)}\u0000${slotIdentityKey(identity)}`;
    groups.set(group, [...(groups.get(group) ?? []), { run, index }]);
  });
  // Within a stage, the first slot (in policy order) of each identity counts; every later one is collapsed.
  for (const members of groups.values()) {
    const sorted = [...members].sort((left, right) => order.get(left.run.slotId)! - order.get(right.run.slotId)!);
    sorted.forEach(({ run, index }, position) => {
      if (position === 0 && run.terminal === "collapsed") add(issues, "REVIEWFN_PANEL_SLOT_DUPLICATE", `/slotRuns/${index}/terminal`, `Slot ${run.slotId} is collapsed but no earlier slot in its stage has the same identity.`);
      if (position > 0 && run.terminal !== "collapsed") add(issues, "REVIEWFN_PANEL_SLOT_DUPLICATE", `/slotRuns/${index}/terminal`, `Slot ${run.slotId} has the same identity as slot ${sorted[0].run.slotId} in its stage and must be collapsed.`);
    });
  }
}

function evidenceIssues(report: PanelReport, issues: Issues): Map<string, Evidence> {
  for (const { index, key } of duplicates(report.evidence, item => item.id)) add(issues, "REVIEWFN_PANEL_FINDING_INVALID", `/evidence/${index}/id`, `Evidence ${key} is declared more than once.`);
  report.evidence.forEach((item, index) => {
    if ((item.kind === "code" || item.kind === "diff") && !item.code) add(issues, "REVIEWFN_PANEL_FINDING_INVALID", `/evidence/${index}/code`, `Evidence ${item.id} has no code anchor.`);
    if (item.kind === "test" && report.gateReceipts.filter(receipt => receipt.id === item.receiptId).length !== 1) add(issues, "REVIEWFN_PANEL_FINDING_INVALID", `/evidence/${index}/receiptId`, `Evidence ${item.id} references no single gate receipt.`);
  });
  return new Map(report.evidence.map(item => [item.id, item]));
}

function findingIssues(report: PanelReport, slots: Map<string, PanelSlot>, evidence: Map<string, Evidence>, issues: Issues): void {
  const runs = new Map(report.slotRuns.map(run => [run.slotId, run]));
  const requirementIds = new Set(report.requirementsReport?.requirements.map(requirement => requirement.id) ?? []);
  const receipts = new Map(report.gateReceipts.map(receipt => [receipt.id, receipt]));
  for (const { index, key } of duplicates(report.findings, finding => finding.fingerprint)) add(issues, "REVIEWFN_PANEL_FINDING_INVALID", `/findings/${index}/fingerprint`, `Fingerprint ${key} is reported more than once; merge the origins into one finding.`);
  report.findings.forEach((finding, index) => {
    const path = `/findings/${index}`;
    intrinsicFindingIssues(finding, path, issues);
    if (!finding.evidenceIds.length) add(issues, "REVIEWFN_PANEL_FINDING_INVALID", `${path}/evidenceIds`, "A finding requires evidence.");
    for (const id of finding.evidenceIds) if (!evidence.has(id)) add(issues, "REVIEWFN_PANEL_FINDING_INVALID", `${path}/evidenceIds`, `Finding references unknown evidence ${id}.`);
    if (finding.evidenceIds.length && !finding.evidenceIds.some(id => ["code", "diff", "test"].includes(evidence.get(id)?.kind ?? ""))) add(issues, "REVIEWFN_PANEL_FINDING_INVALID", `${path}/evidenceIds`, "A finding requires code, diff or test evidence.");
    if (finding.basis === "reproduced" && !finding.evidenceIds.some(id => {
      const item = evidence.get(id);
      const receipt = item?.kind === "test" && item.receiptId !== undefined ? receipts.get(item.receiptId) : undefined;
      return !!receipt && receipt.commit === report.change.headCommit && receipt.exitCode !== null && !receipt.timedOut && !receipt.canceled;
    })) add(issues, "REVIEWFN_PANEL_FINDING_INVALID", `${path}/basis`, "A reproduced finding requires test evidence from a completed gate receipt at the reviewed head.");
    for (const id of finding.requirementIds) if (!requirementIds.has(id)) add(issues, "REVIEWFN_PANEL_FINDING_INVALID", `${path}/requirementIds`, `Finding references unknown requirement ${id}.`);
    finding.origins.forEach((origin, position) => {
      const slot = slots.get(origin.slotId);
      const reason = !slot ? "names no slot" : slot.stage === "verifier" ? "names a verifier slot" : slot.lens !== origin.lens ? `has lens ${origin.lens}, but slot ${slot.id} uses lens ${slot.lens}` : runs.get(slot.id)?.terminal !== "completed" ? "names a slot without a completed run" : undefined;
      if (reason) add(issues, "REVIEWFN_PANEL_ORIGIN_UNKNOWN", `${path}/origins/${position}`, `Origin ${origin.slotId} ${reason}.`);
    });
    const verification = finding.verification;
    if (!verification) return;
    const verifier = slots.get(verification.slotId);
    if (!verifier) return add(issues, "REVIEWFN_PANEL_SLOT_UNKNOWN", `${path}/verification/slotId`, `Verification references unknown slot ${verification.slotId}.`);
    const verifierRun = runs.get(verifier.id);
    if (verifier.stage !== "verifier") add(issues, "REVIEWFN_PANEL_VERIFICATION_INVALID", `${path}/verification/slotId`, `Slot ${verifier.id} is not a verifier slot.`);
    if (verifierRun?.terminal !== "completed") add(issues, "REVIEWFN_PANEL_VERIFICATION_INVALID", `${path}/verification/slotId`, `Verifier slot ${verifier.id} has no completed run.`);
    else {
      const key = slotIdentityKey(verifierRun.identity);
      const shared = finding.origins.find(origin => { const run = runs.get(origin.slotId); return run !== undefined && slotIdentityKey(run.identity) === key; });
      if (shared) add(issues, "REVIEWFN_PANEL_VERIFICATION_INVALID", `${path}/verification/slotId`, `Verifier slot ${verifier.id} has the same identity as origin slot ${shared.slotId}; verification must be independent.`);
    }
    for (const id of verification.evidenceIds) if (!evidence.has(id)) add(issues, "REVIEWFN_PANEL_VERIFICATION_INVALID", `${path}/verification/evidenceIds`, `Verification references unknown evidence ${id}.`);
    if (verification.verdict !== "inconclusive" && !verification.evidenceIds.length) add(issues, "REVIEWFN_PANEL_VERIFICATION_INVALID", `${path}/verification/evidenceIds`, `A ${verification.verdict} verification requires evidence.`);
  });
  const fingerprints = new Set(report.findings.map(finding => finding.fingerprint));
  const clustered = new Map<string, string>();
  for (const { index, key } of duplicates(report.clusters, cluster => cluster.id)) add(issues, "REVIEWFN_PANEL_FINDING_INVALID", `/clusters/${index}/id`, `Cluster ${key} is declared more than once.`);
  report.clusters.forEach((cluster, index) => {
    for (const fingerprint of cluster.findingFingerprints) {
      if (!fingerprints.has(fingerprint)) add(issues, "REVIEWFN_PANEL_FINDING_INVALID", `/clusters/${index}/findingFingerprints`, `Cluster ${cluster.id} references unknown finding ${fingerprint}.`);
      const other = clustered.get(fingerprint);
      if (other !== undefined && other !== cluster.id) add(issues, "REVIEWFN_PANEL_FINDING_INVALID", `/clusters/${index}/findingFingerprints`, `Finding ${fingerprint} is in clusters ${other} and ${cluster.id}.`);
      clustered.set(fingerprint, cluster.id);
    }
  });
}

async function anchorIssues(report: PanelReport, options: PanelReportValidationOptions, issues: Issues): Promise<void> {
  const { sourceControl, root } = options;
  if (!sourceControl || !root) return;
  // Panel evidence cites the reviewed head, or the merge base for pre-existing (on-base) code.
  const commits = new Set([report.change.headCommit, report.change.mergeBaseCommit]);
  const anchors = [
    ...report.evidence.flatMap((item, index) => item.code ? [{ anchor: item.code, path: `/evidence/${index}/code` }] : []),
    ...report.findings.flatMap((finding, index) => finding.anchor ? [{ anchor: finding.anchor, path: `/findings/${index}/anchor` }] : []),
  ];
  for (const { anchor, path } of anchors) {
    if (!commits.has(anchor.commit)) add(issues, "REVIEWFN_PANEL_FINDING_INVALID", path, `Anchor commit ${anchor.commit} is neither the reviewed head nor the merge base.`);
    else if (!(await sourceControl.verifyAnchor(root, anchor))) add(issues, "REVIEWFN_PANEL_FINDING_INVALID", path, `Anchor ${anchor.path} is not valid at ${anchor.commit}.`);
  }
}

/**
 * Validate a panel report. Structural problems are reported alone; otherwise slots, runs, findings, origins,
 * verification, dispositions, the embedded 0.1 requirements report and the derived verdict are checked.
 */
export async function validatePanelReport(value: unknown, policy: ReviewPolicy, options: PanelReportValidationOptions = {}): Promise<PanelReportValidationResult> {
  const issues = structural(panelReport, value);
  if (issues.length) return { valid: false, issues };
  const report = value as PanelReport;
  const slots = new Map<string, PanelSlot>();
  report.slots.forEach((slot, index) => {
    if (slots.has(slot.id)) add(issues, "REVIEWFN_PANEL_SLOT_DUPLICATE", `/slots/${index}/id`, `Slot ${slot.id} is declared more than once.`);
    else slots.set(slot.id, slot);
  });
  slotRunIssues(report, slots, issues);
  const evidence = evidenceIssues(report, issues);
  findingIssues(report, slots, evidence, issues);
  await anchorIssues(report, options, issues);

  const requirements: ReviewReport | undefined = report.requirementsReport;
  if (requirements) {
    if (stableStringify(requirements.change) !== stableStringify(report.change)) add(issues, "REVIEWFN_REPORT_INVALID", "/requirementsReport/change", "The requirements report reviewed a different change than the panel.");
    if (stableStringify(requirements.changeDetail ?? null) !== stableStringify(report.changeDetail ?? null)) add(issues, "REVIEWFN_REPORT_INVALID", "/requirementsReport/changeDetail", "The requirements report records different change detail than the panel.");
    const validation = await validateReport(requirements, policy, options.sourceControl, options.root, options.context, options.artifacts);
    issues.push(...validation.errors.map(error => reportIssue(error, "/requirementsReport")));
  } else if (report.changeDetail) {
    const detail = await verifyChangeDetail(report as unknown as ReviewReport, options.artifacts);
    issues.push(...detail.errors.map(error => reportIssue(error, "/changeDetail")));
  }

  const verdict = derivePanelVerdict(report, policy);
  if (report.verdict !== verdict) add(issues, "REVIEWFN_PANEL_VERDICT_MISMATCH", "/verdict", `Verdict ${String(report.verdict)} does not match derived verdict ${String(verdict)}.`);
  return { valid: issues.length === 0, issues, verdict };
}

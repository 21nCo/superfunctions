import { digestJson, sha256, stableStringify } from "../canonical.js";
import { verifyChangeDetail, type ChangeDetailVerification } from "../change.js";
import { globGrammarIssue } from "../context/glob.js";
import { ReviewFnError } from "../errors.js";
import { harnessOutputSchema } from "../schema.js";
import type { ArtifactStore, CodeAnchor, ContextManifest, Evidence, ReviewPolicy, ReviewReport, SourceControlAdapter, SourceReference, Verdict } from "../types.js";
import { anchorCommitChecker, deriveVerdict, reproductionVerified, sinceAncestryError, sourceReferenceChecker, validateReport, verifiedDeltaOf, waiverReferenceValid } from "../validator.js";
import { PANEL_CREDENTIAL_FINGERPRINT_PATTERN, PANEL_DIGEST_PATTERN, PANEL_ENV_NAME_PATTERN, PANEL_MODEL_REPORT_PATTERN, PANEL_NONBLANK_PATTERN, PANEL_PROFILE_NAME_PATTERN, PANEL_SLOT_ID_PATTERN, PANEL_TIMESTAMP_PATTERN, panelSchemaDefs } from "./schema.js";
import { HARNESS_PROFILE_PLACEHOLDERS, PANEL_DEFAULT_MAX_CONCURRENT_SLOTS } from "./types.js";
import type { HarnessProfile, PanelFinding, PanelFindingOrigin, PanelPolicy, PanelReport, PanelReportIssueCode, PanelReportValidationResult, PanelSlot, PanelValidationCode, PanelValidationIssue, PanelValidationResult, SlotIdentity, SlotRun } from "./types.js";

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
  issues.push({ code, path, message });
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
function constant(expected: boolean): Check {
  return (value, path, issues) => { if (value !== expected) add(issues, "REVIEWFN_PANEL_SCHEMA", path, `must be ${String(expected)}.`); };
}
/** An object of any keys matching `keyPattern`, each value checked by `item` (JSON Schema `propertyNames` and `additionalProperties`). */
function record(keyPattern: string, item: Check): Check {
  const expression = new RegExp(keyPattern, "u");
  return (value, path, issues) => {
    if (!isRecord(value)) return add(issues, "REVIEWFN_PANEL_SCHEMA", path, "must be an object.");
    for (const [key, entry] of Object.entries(value)) {
      if (entry === undefined) continue;
      if (!expression.test(key)) add(issues, "REVIEWFN_PANEL_SCHEMA", pointer(path, key), `property name must match ${keyPattern}.`);
      item(entry, pointer(path, key), issues);
    }
  };
}
function nullable(check: Check): Check {
  return (value, path, issues) => { if (value !== null) check(value, path, issues); };
}
function array(item: Check, options: { min?: number; max?: number; unique?: boolean } = {}): Check {
  return (value, path, issues) => {
    if (!Array.isArray(value)) return add(issues, "REVIEWFN_PANEL_SCHEMA", path, "must be an array.");
    if (options.min !== undefined && value.length < options.min) add(issues, "REVIEWFN_PANEL_SCHEMA", path, `must have at least ${options.min} item(s).`);
    if (options.max !== undefined && value.length > options.max) add(issues, "REVIEWFN_PANEL_SCHEMA", path, `must have at most ${options.max} item(s).`);
    // Items are checked first: only valid items are canonicalized, so invalid input yields issues, never a throw.
    const before = issues.length;
    value.forEach((entry, index) => item(entry, pointer(path, index), issues));
    if (options.unique && issues.length === before && new Set(value.map(entry => stableStringify(entry))).size !== value.length) add(issues, "REVIEWFN_PANEL_SCHEMA", path, "must not contain duplicate items.");
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

const profileName = string(PANEL_PROFILE_NAME_PATTERN);
const harnessProfile = object({
  argv: texts, promptVia: oneOf(defs.harnessProfile.properties.promptVia.enum), outputVia: oneOf(defs.harnessProfile.properties.outputVia.enum),
  envAllowlist: array(string(PANEL_ENV_NAME_PATTERN), { unique: true }), modelReport: string(PANEL_MODEL_REPORT_PATTERN),
  capabilities: object({ structuredOutput: boolean, sandbox: oneOf(defs.harnessProfile.properties.capabilities.properties.sandbox.enum) }, ["structuredOutput", "sandbox"]),
  versionArgv: texts,
}, defs.harnessProfile.required);
const panelSlot = object({
  id: slotId, stage: oneOf(defs.panelSlot.properties.stage.enum),
  harness: object({ adapter: nonblank, version: nonblank, executable: nonblank, profile: profileName }, ["adapter", "version"]),
  inference: object({ provider: nonblank, model: nonblank, auth: nonblank, credentialEnv: nonblank }, ["provider", "model", "auth"]),
  lens: nonblank, budget: object({ timeoutMs: positive, maxOutputBytes: positive }, ["timeoutMs", "maxOutputBytes"]),
}, defs.panelSlot.required, (value, path, issues) => {
  // Mirrors the harness's if/then/else: only the cli harness names a profile and an executable, and always both.
  if (isRecord(value.harness) && value.harness.adapter !== undefined) issues.push(...slotHarnessIssues(value as unknown as PanelSlot, pointer(path, "harness")));
});
const panelPolicy = object({
  version: oneOf([1]), slots: array(panelSlot, { min: 1 }), quorum: object({ stage1: count, stage2: count }, ["stage1", "stage2"]),
  requirementsSlot: nullable(slotId), maxConcurrentSlots: numeric(true, 1, 8), incremental: oneOf(defs.panelPolicy.properties.incremental.enum),
  profiles: record(PANEL_PROFILE_NAME_PATTERN, harnessProfile),
  contextPairs: array(object({ when: nonblank, include: array(nonblank, { min: 1 }) }, ["when", "include"])), contextExcludeGlobs: array(nonblank),
}, defs.panelPolicy.required);
const slotIdentity = object({
  harnessAdapter: nonblank, harnessVersion: nonblank, provider: nonblank, model: nonblank, auth: nonblank, credentialFingerprint: string(PANEL_CREDENTIAL_FINGERPRINT_PATTERN),
  harnessExecutable: nonblank, harnessProfile: profileName, modelVerified: constant(false), modelMismatch: constant(true),
}, defs.slotIdentity.required);
const slotRun = object({
  slotId, identity: slotIdentity, terminal: oneOf(defs.slotRun.properties.terminal.enum),
  voidReasons: array(oneOf(defs.slotRun.properties.voidReasons.items.enum), { unique: true }),
  startedAt: timestamp, finishedAt: timestamp, outputArtifact: nonblank, outputDigest: string(PANEL_DIGEST_PATTERN),
  usage: object({ inputTokens: count, outputTokens: count, costUsd: numeric(false, 0) }, []),
  limitations: array(oneOf(defs.slotRun.properties.limitations.items.enum), { unique: true }),
}, defs.slotRun.required, (value, path, issues) => {
  // Mirrors the allOf if/then/else: model_unverified is recorded exactly when the identity's model is unverified.
  const unverified = isRecord(value.identity) && value.identity.modelVerified === false;
  const recorded = Array.isArray(value.limitations) && value.limitations.includes("model_unverified");
  if (unverified && !recorded && (value.limitations === undefined || Array.isArray(value.limitations))) add(issues, "REVIEWFN_PANEL_SCHEMA", pointer(path, "limitations"), "A run whose model is unverified must record the model_unverified limitation.");
  if (!unverified && recorded) add(issues, "REVIEWFN_PANEL_SCHEMA", pointer(path, "limitations"), "model_unverified is recorded only for a run whose model is unverified (modelVerified false).");
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
  contextManifestDigest: string(PANEL_DIGEST_PATTERN), panelPolicyDigest: string(PANEL_DIGEST_PATTERN), slots: array(panelSlot, { min: 1 }), slotRuns: array(slotRun), requirementsReport: reviewReport,
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
  // An unverified model identifies nothing: such runs of one executable and profile are one identity, whatever their
  // configured provider, model, auth or credential.
  if (identity.modelVerified === false) return harnessKey(identity);
  const profiled = identity.harnessExecutable !== undefined || identity.harnessProfile !== undefined ? [identity.harnessExecutable ?? null, identity.harnessProfile ?? null] : [];
  return digestJson([identity.harnessAdapter, identity.harnessVersion, identity.provider, identity.model, identity.auth, identity.credentialFingerprint ?? null, ...profiled]);
}
/** Whether two runs are one identity, as collapse treats them: a model-unverified side matches on its harness key. */
export const sameSlotIdentity = (left: SlotIdentity, right: SlotIdentity) => slotIdentityKey(left) === slotIdentityKey(right) || ((left.modelVerified === false || right.modelVerified === false) && harnessKey(left) === harnessKey(right));
const harnessKey = (identity: SlotIdentity) => digestJson(["model_unverified", identity.harnessAdapter, identity.harnessVersion, identity.harnessExecutable ?? null, identity.harnessProfile ?? null]);

/**
 * The slot each counting run of `runs` (in policy order) collapses into, itself when it counts. Within a stage the first
 * run of an identity counts; verified runs go first, so a model-unverified run also collapses into a counted run of its
 * adapter version, executable and profile and never adds an identity a verified run represents.
 */
export function slotCollapseTargets(runs: ReadonlyArray<{ slotId: string; stage: PanelSlot["stage"]; identity: SlotIdentity; terminal?: SlotRun["terminal"] }>): Map<string, string> {
  const targets = new Map<string, string>();
  const counted = new Map<string, string>();
  for (const run of [...runs.filter(item => item.identity.modelVerified !== false), ...runs.filter(item => item.identity.modelVerified === false)]) {
    const target = counted.get(`${String(run.stage)}\u0000${slotIdentityKey(run.identity)}`) ?? run.slotId;
    targets.set(run.slotId, target);
    if (run.terminal === "collapsed") continue; // A stored collapse counts for no later run: its target must precede it.
    for (const key of [slotIdentityKey(run.identity), harnessKey(run.identity)]) if (!counted.has(`${String(run.stage)}\u0000${key}`)) counted.set(`${String(run.stage)}\u0000${key}`, target);
  }
  return targets;
}

/** The one profile-driven harness: only its slots name a profile and an executable. */
const PROFILE_HARNESS_ADAPTER = "cli";

const PLACEHOLDER_TOKEN = /\{[A-Za-z][A-Za-z0-9]*\}/u;

/** Number of capture groups of a regular expression source, or undefined when it does not compile on its own; counted by a linear scan, never by matching an untrusted regex. */
function captureGroups(source: string): number | undefined {
  try { new RegExp(source, "u"); } catch { return undefined; }
  let groups = 0;
  let inClass = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (char === "\\") index += 1;
    else if (inClass) inClass = char !== "]";
    else if (char === "[") inClass = true;
    // `(` captures unless it opens `(?:`, a lookaround or a modifier group; `(?<name>` captures, `(?<=` and `(?<!` do not.
    else if (char === "(" && (source[index + 1] !== "?" || (source[index + 2] === "<" && source[index + 3] !== "=" && source[index + 3] !== "!"))) groups += 1;
  }
  return groups;
}

/**
 * Semantic issues of one structurally valid harness profile: placeholders are the closed set and only ever whole
 * arguments, the prompt and output channels it declares appear in `argv`, a CLI that enforces the output schema is given
 * `{schemaFile}`, and a `stderr-regex` model report compiles with exactly one capture group.
 */
export function harnessProfileIssues(profile: HarnessProfile, path: string): PanelValidationIssue<PanelValidationCode>[] {
  const issues: Issues = [];
  const placeholders: readonly string[] = HARNESS_PROFILE_PLACEHOLDERS;
  profile.argv.forEach((argument, index) => {
    if (placeholders.includes(argument)) return;
    if (PLACEHOLDER_TOKEN.test(argument)) add(issues, "REVIEWFN_PANEL_SCHEMA", pointer(pointer(path, "argv"), index), `${JSON.stringify(argument)} is not a whole-argument placeholder; placeholders are ${placeholders.join(", ")}, each as a whole argument.`);
  });
  (profile.versionArgv ?? []).forEach((argument, index) => {
    if (placeholders.includes(argument) || PLACEHOLDER_TOKEN.test(argument)) add(issues, "REVIEWFN_PANEL_SCHEMA", pointer(pointer(path, "versionArgv"), index), "versionArgv takes no placeholders.");
  });
  const requires = (placeholder: string, why: string) => { if (!profile.argv.includes(placeholder)) add(issues, "REVIEWFN_PANEL_SCHEMA", pointer(path, "argv"), `must include ${placeholder} ${why}.`); };
  if (profile.promptVia === "file") requires("{promptFile}", "when promptVia is file");
  if (profile.outputVia === "file") requires("{outputFile}", "when outputVia is file");
  if (profile.capabilities.structuredOutput) requires("{schemaFile}", "when the CLI enforces the output schema (capabilities.structuredOutput)");
  if (profile.modelReport.startsWith("stderr-regex:")) {
    const groups = captureGroups(profile.modelReport.slice("stderr-regex:".length));
    if (groups === undefined) add(issues, "REVIEWFN_PANEL_SCHEMA", pointer(path, "modelReport"), "stderr-regex is not a valid regular expression.");
    else if (groups !== 1) add(issues, "REVIEWFN_PANEL_SCHEMA", pointer(path, "modelReport"), `stderr-regex must have exactly one capture group, not ${groups}.`);
  }
  return issues as PanelValidationIssue<PanelValidationCode>[];
}

/** Structure and semantics of one harness profile, as `validatePanelPolicy` checks each entry of `profiles`. */
export function validateHarnessProfile(value: unknown): PanelValidationResult<PanelValidationCode> {
  const issues = structural(harnessProfile, value) as PanelValidationIssue<PanelValidationCode>[];
  if (!issues.length) for (const issue of harnessProfileIssues(value as HarnessProfile, "")) issues.push(issue);
  return result(issues);
}

/**
 * Issues of a slot's harness pairing, which holds whatever the policy: only the `cli` harness is profile-driven, and it
 * always names both a profile and an executable; every other harness names neither.
 */
export function slotHarnessIssues(slot: PanelSlot, path: string): PanelValidationIssue<PanelValidationCode>[] {
  const issues: Issues = [];
  const { adapter, executable, profile } = slot.harness;
  if (adapter !== PROFILE_HARNESS_ADAPTER) {
    if (profile !== undefined || executable !== undefined) add(issues, "REVIEWFN_PANEL_SCHEMA", path, `Slot ${slot.id} uses harness ${adapter}, which takes no profile or executable; only the ${PROFILE_HARNESS_ADAPTER} harness is profile-driven.`);
  } else if (profile === undefined && executable === undefined) add(issues, "REVIEWFN_PANEL_SCHEMA", path, `Slot ${slot.id} uses the ${PROFILE_HARNESS_ADAPTER} harness, which runs only a profile the policy declares, with an executable; it names neither.`);
  else if (executable === undefined) add(issues, "REVIEWFN_PANEL_SCHEMA", path, `Slot ${slot.id} names a profile without an executable.`);
  else if (profile === undefined) add(issues, "REVIEWFN_PANEL_SCHEMA", pointer(path, "executable"), `Slot ${slot.id} names an executable without a profile; only a profile-driven harness takes one from the slot.`);
  return issues as PanelValidationIssue<PanelValidationCode>[];
}

/** Structure of a panel policy, unique slot IDs, a `requirementsSlot` naming a stage-1 or stage-2 slot, valid harness profiles, and slot profiles the policy declares, each with an executable. */
export function validatePanelPolicy(value: unknown): PanelValidationResult<PanelValidationCode> {
  const issues = structural(panelPolicy, value);
  if (issues.length) return result(issues as PanelValidationIssue<PanelValidationCode>[]);
  const policy = value as PanelPolicy;
  for (const { index, key } of duplicates(policy.slots, slot => slot.id)) add(issues, "REVIEWFN_PANEL_SLOT_DUPLICATE", `/slots/${index}/id`, `Slot ${key} is declared more than once.`);
  if (policy.requirementsSlot !== null && !policy.slots.some(slot => slot.id === policy.requirementsSlot && slot.stage !== "verifier")) add(issues, "REVIEWFN_PANEL_SLOT_UNKNOWN", "/requirementsSlot", `requirementsSlot ${policy.requirementsSlot} names no stage-1 or stage-2 slot.`);
  const profiles = policy.profiles ?? {};
  // An entry set to undefined declares no profile: it is skipped like an absent one, never dereferenced.
  for (const [name, profile] of Object.entries(profiles)) if (profile !== undefined) for (const issue of harnessProfileIssues(profile, pointer("/profiles", name))) issues.push(issue);
  policy.slots.forEach((slot, index) => {
    const { profile } = slot.harness;
    if (profile !== undefined && (!Object.hasOwn(profiles, profile) || profiles[profile] === undefined)) add(issues, "REVIEWFN_PANEL_SCHEMA", `/slots/${index}/harness/profile`, `Slot ${slot.id} names profile ${profile}, which the policy's profiles do not declare.`);
  });
  const globs: Array<[string, string]> = [
    ...(policy.contextPairs ?? []).flatMap((pair, index): Array<[string, string]> => [[`/contextPairs/${index}/when`, pair.when], ...pair.include.map((glob, item): [string, string] => [`/contextPairs/${index}/include/${item}`, glob])]),
    ...(policy.contextExcludeGlobs ?? []).map((glob, index): [string, string] => [`/contextExcludeGlobs/${index}`, glob]),
  ];
  for (const [path, glob] of globs) {
    const issue = globGrammarIssue(glob);
    if (issue) add(issues, "REVIEWFN_GLOB_UNSUPPORTED", path, issue);
  }
  return result(issues as PanelValidationIssue<PanelValidationCode>[]);
}

/** Digest of a valid panel policy with `maxConcurrentSlots` defaulted, recorded as `PanelReport.panelPolicyDigest`. */
export function panelPolicyDigest(policy: PanelPolicy): string {
  const validation = validatePanelPolicy(policy);
  if (!validation.valid) {
    const details = validation.issues.map(issue => [issue.code, issue.path, issue.message].join(" ")).join("; ");
    throw new ReviewFnError("REVIEWFN_CONFIG_INVALID", `Invalid panel policy: ${details}`);
  }
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
  /** Verifies code anchors and incremental-range ancestry; without it every code anchor fails closed. */
  sourceControl?: SourceControlAdapter;
  root?: string;
  /**
   * Frozen context of the run. Required to verify a completed requirements report, suppression references and source
   * evidence; it is used only when its digest equals the report's `contextManifestDigest` (or the requirements report's).
   */
  context?: ContextManifest;
  /** Retained artifacts: change detail, reproduction logs and slot outputs fail closed without it. */
  artifacts?: ArtifactStore;
  /**
   * The panel policy the run used. It must have the report's `panelPolicyDigest` and slots. It binds the requirements
   * report to `requirementsSlot`: without it an embedded requirements report fails closed.
   */
  panelPolicy?: PanelPolicy;
}

const REPORT_CODES = new Set<PanelReportIssueCode>(["REVIEWFN_CHANGE_DETAIL_MISMATCH", "REVIEWFN_SINCE_NOT_ANCESTOR"]);
function reportIssue(error: string, path: string): PanelValidationIssue<PanelReportIssueCode> {
  const match = /^(REVIEWFN_[A-Z_]+): (.*)$/s.exec(error);
  const code = match && REPORT_CODES.has(match[1] as PanelReportIssueCode) ? match[1] as PanelReportIssueCode : "REVIEWFN_REPORT_INVALID";
  return { code, path, message: match && code !== "REVIEWFN_REPORT_INVALID" ? match[2] : error };
}

/** A timestamp that matches the pattern and names a real calendar date (the pattern admits February 30). */
function timestampExists(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})T/.exec(value);
  if (!match || Number.isNaN(Date.parse(value))) return false;
  const [year, month, day] = match.slice(1).map(Number);
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

/** Terminals of runs that succeeded: `completed` counts toward quorum, and `collapsed` would have. */
const COUNTING = new Set<SlotRun["terminal"]>(["completed", "collapsed"]);

/** The supplied panel policy when it is the one the report records; otherwise an issue, and no policy. */
function boundPanelPolicy(report: PanelReport, policy: PanelPolicy | undefined, issues: Issues): PanelPolicy | undefined {
  if (!policy) return undefined;
  let digest: string | undefined;
  try { digest = panelPolicyDigest(policy); } catch { /* An invalid policy cannot be the one the report records. */ }
  if (digest !== report.panelPolicyDigest) add(issues, "REVIEWFN_PANEL_SCHEMA", "/panelPolicyDigest", "The supplied panel policy is invalid or does not have the report's digest.");
  else if (stableStringify(policy.slots) !== stableStringify(report.slots)) add(issues, "REVIEWFN_PANEL_SCHEMA", "/slots", "The report's slots differ from the panel policy's.");
  else return policy;
  return undefined;
}

/**
 * The requirements report comes from the run of the panel policy's `requirementsSlot`. A `completed` or `collapsed` run
 * produced a completed requirements report, which must be present. Any other run may only record its failure in a report
 * whose execution did not complete, so the verdict stays absent as in 0.1.
 */
function requirementsProvenanceIssues(report: PanelReport, policy: PanelPolicy | undefined, issues: Issues): void {
  const slotId = policy?.requirementsSlot ?? null;
  const run = slotId === null ? undefined : report.slotRuns.find(item => item.slotId === slotId);
  const succeeded = run !== undefined && COUNTING.has(run.terminal);
  const requirements = report.requirementsReport;
  if (!requirements) {
    if (succeeded) add(issues, "REVIEWFN_PANEL_ORIGIN_UNKNOWN", "/requirementsReport", `Requirements slot ${String(slotId)} is ${run.terminal} but the report has no requirements report.`);
  } else if (!run) {
    const reason = !policy ? "cannot be attributed without the panel policy the report records" : slotId === null ? "has no requirementsSlot in the panel policy" : `has no run of requirements slot ${slotId}`;
    add(issues, "REVIEWFN_PANEL_ORIGIN_UNKNOWN", "/requirementsReport", `The requirements report ${reason}.`);
  } else {
    if (succeeded !== (requirements.execution === "completed")) add(issues, "REVIEWFN_PANEL_ORIGIN_UNKNOWN", "/requirementsReport/execution", `Requirements slot ${String(slotId)} is ${run.terminal}, which contradicts a requirements report whose execution is ${requirements.execution}.`);
    // The report records the configuration that produced it: the slot's harness adapter and configured inference, and
    // for a run that succeeded the harness version the slot pins.
    const slot = policy!.slots.find(item => item.id === slotId)!;
    const { harness, inference } = requirements.configuration;
    if (harness.id !== slot.harness.adapter || (succeeded && harness.version !== slot.harness.version) || inference.provider !== slot.inference.provider || inference.model !== slot.inference.model || inference.auth !== slot.inference.auth) {
      add(issues, "REVIEWFN_PANEL_ORIGIN_UNKNOWN", "/requirementsReport/configuration", `The requirements report was produced by another harness or inference configuration than requirements slot ${String(slotId)}.`);
    }
  }
}

function slotRunIssues(report: PanelReport, slots: Map<string, PanelSlot>, issues: Issues, profiles?: PanelPolicy["profiles"]): void {
  const order = new Map([...slots.keys()].map((id, index) => [id, index]));
  for (const { index, key } of duplicates(report.slotRuns, run => run.slotId)) add(issues, "REVIEWFN_PANEL_SLOT_DUPLICATE", `/slotRuns/${index}/slotId`, `Slot ${key} has more than one run.`);
  report.slotRuns.forEach((run, index) => {
    const path = `/slotRuns/${index}`;
    for (const key of ["startedAt", "finishedAt"] as const) if (!timestampExists(run[key])) add(issues, "REVIEWFN_PANEL_SCHEMA", `${path}/${key}`, `${run[key]} is not a real UTC time.`);
    if (timestampExists(run.startedAt) && timestampExists(run.finishedAt) && Date.parse(run.finishedAt) < Date.parse(run.startedAt)) add(issues, "REVIEWFN_PANEL_SCHEMA", `${path}/finishedAt`, "A run cannot finish before it starts.");
    const slot = slots.get(run.slotId);
    if (!slot) return add(issues, "REVIEWFN_PANEL_SLOT_UNKNOWN", `${path}/slotId`, `Run references unknown slot ${run.slotId}.`);
    const { identity } = run;
    if (identity.harnessAdapter !== slot.harness.adapter || identity.provider !== slot.inference.provider || identity.auth !== slot.inference.auth) add(issues, "REVIEWFN_PANEL_SCHEMA", `${path}/identity`, `Run identity does not match slot ${slot.id}'s harness adapter, provider or auth mode.`);
    if (identity.harnessExecutable !== slot.harness.executable || identity.harnessProfile !== slot.harness.profile) add(issues, "REVIEWFN_PANEL_SCHEMA", `${path}/identity`, `Run identity does not match slot ${slot.id}'s harness executable or profile.`);
    // An unverified model is always recorded as a limitation, and the model it stands for is the configured one.
    if (identity.modelVerified === false && identity.model !== slot.inference.model) add(issues, "REVIEWFN_PANEL_SCHEMA", `${path}/identity/model`, "A run whose model is unverified records the configured model.");
    if (identity.modelVerified === false && slot.harness.profile === undefined) add(issues, "REVIEWFN_PANEL_SCHEMA", `${path}/identity/modelVerified`, `Slot ${slot.id} runs no harness profile, so its model is never recorded as unverified.`);
    // With the bound panel policy, the slot's profile fixes what its runs record, so a report cannot drop a limitation, or
    // claim a verified model and count as a distinct identity, where the profile reports no model.
    const profile = slot.harness.profile !== undefined && profiles && Object.hasOwn(profiles, slot.harness.profile) ? profiles[slot.harness.profile] : undefined;
    if (profile) {
      const limitations = run.limitations ?? [];
      if (profile.modelReport === "none" && (identity.modelVerified !== false || !limitations.includes("model_unverified"))) add(issues, "REVIEWFN_PANEL_SCHEMA", `${path}/identity/modelVerified`, `Slot ${slot.id}'s profile ${slot.harness.profile} reports no model, so its run must record modelVerified false and the model_unverified limitation.`);
      if (profile.capabilities.sandbox === "tree-verified-only" && !limitations.includes("sandbox_tree_verified_only")) add(issues, "REVIEWFN_PANEL_SCHEMA", `${path}/limitations`, `Slot ${slot.id}'s profile ${slot.harness.profile} enforces no tool restriction, so its run must record sandbox_tree_verified_only.`);
    }
    // A harness reporting another version than the slot pins is recorded truthfully, but its run never counts or collapses.
    if (identity.harnessVersion !== slot.harness.version && COUNTING.has(run.terminal)) add(issues, "REVIEWFN_PANEL_SCHEMA", `${path}/identity/harnessVersion`, `Harness version ${identity.harnessVersion} differs from slot ${slot.id}'s ${slot.harness.version}; such a run cannot be ${run.terminal}.`);
    // The harness's raw mismatch verdict needs a verified model and a configured model to differ from.
    if (identity.modelMismatch === true && (identity.modelVerified === false || slot.inference.model === "configured")) add(issues, "REVIEWFN_PANEL_SCHEMA", `${path}/identity/modelMismatch`, "A model mismatch needs a verified model and an explicitly configured model.");
    // One precedence: an observed model mismatch, by a differing model or the harness's raw verdict, voids the run whatever else happened.
    const mismatch = slot.inference.model !== "configured" && (identity.model !== slot.inference.model || identity.modelMismatch === true);
    if (mismatch && run.terminal !== "void") add(issues, "REVIEWFN_PANEL_SCHEMA", `${path}/terminal`, `Resolved model ${identity.model} differs from configured model ${slot.inference.model}; the run must be void with model_mismatch.`);
    else if (mismatch && !run.voidReasons.includes("model_mismatch")) add(issues, "REVIEWFN_PANEL_SCHEMA", `${path}/voidReasons`, `Resolved model ${identity.model} differs from configured model ${slot.inference.model}; the void reasons must include model_mismatch.`);
    if (!mismatch && run.voidReasons.includes("model_mismatch")) add(issues, "REVIEWFN_PANEL_SCHEMA", `${path}/voidReasons`, "model_mismatch requires a resolved model that differs from the configured model, or a harness-reported model mismatch.");
  });
  // Within a stage, the run that counts for an identity is the coordinator's (slotCollapseTargets); every other run of it
  // that would also count is collapsed; runs that did not complete neither count nor collapse.
  const counting = report.slotRuns.filter(run => COUNTING.has(run.terminal) && slots.has(run.slotId)).sort((left, right) => order.get(left.slotId)! - order.get(right.slotId)!).map(run => ({ ...run, stage: slots.get(run.slotId)!.stage }));
  const targets = slotCollapseTargets(counting);
  report.slotRuns.forEach((run, index) => {
    const target = targets.get(run.slotId);
    if (run.terminal === "completed" && target !== undefined && target !== run.slotId) add(issues, "REVIEWFN_PANEL_SLOT_DUPLICATE", `/slotRuns/${index}/terminal`, `Slot ${run.slotId} has the same identity as slot ${target}, which counts for its stage; it must be collapsed.`);
    if (run.terminal === "collapsed" && target === run.slotId) add(issues, "REVIEWFN_PANEL_SLOT_DUPLICATE", `/slotRuns/${index}/terminal`, `Slot ${run.slotId} is collapsed but no earlier completed slot in its stage has the same identity.`);
  });
}

interface EvidenceContext {
  report: PanelReport;
  options: PanelReportValidationOptions;
  referenceValid: (ref: SourceReference) => boolean;
  detail: ChangeDetailVerification;
}

async function evidenceIssues({ report, options, referenceValid, detail }: EvidenceContext, issues: Issues): Promise<Map<string, Evidence>> {
  const { artifacts } = options;
  const verifiedDelta = verifiedDeltaOf(report as unknown as ReviewReport, detail);
  const changedPaths = new Set([...report.change.changedPaths, ...(verifiedDelta?.files.map(file => file.path) ?? [])]);
  for (const { index, key } of duplicates(report.evidence, item => item.id)) add(issues, "REVIEWFN_PANEL_FINDING_INVALID", `/evidence/${index}/id`, `Evidence ${key} is declared more than once.`);
  for (const [index, item] of report.evidence.entries()) {
    const path = `/evidence/${index}`;
    if (item.sourceExclusionReason !== undefined && (item.kind !== "source" || !item.sourceExclusionReason.trim())) add(issues, "REVIEWFN_PANEL_FINDING_INVALID", `${path}/sourceExclusionReason`, `Evidence ${item.id} has an invalid source exclusion reason.`);
    if (item.kind === "source" && (!item.source || !referenceValid(item.source))) add(issues, "REVIEWFN_PANEL_FINDING_INVALID", `${path}/source`, `Evidence ${item.id} has no source verifiable against the frozen context.`);
    if ((item.kind === "code" || item.kind === "diff") && !item.code) add(issues, "REVIEWFN_PANEL_FINDING_INVALID", `${path}/code`, `Evidence ${item.id} has no code anchor.`);
    if (item.kind === "diff" && item.code && !changedPaths.has(item.code.path)) add(issues, "REVIEWFN_PANEL_FINDING_INVALID", `${path}/code`, `Diff evidence ${item.id} is outside the changed paths.`);
    if (item.kind === "test" && report.gateReceipts.filter(receipt => receipt.id === item.receiptId && receipt.commit === report.change.headCommit).length !== 1) add(issues, "REVIEWFN_PANEL_FINDING_INVALID", `${path}/receiptId`, `Evidence ${item.id} references no single gate receipt at the reviewed head.`);
    if (item.kind === "artifact") {
      // Panel artifact evidence cites a retained slot output by digest.
      const run = report.slotRuns.find(candidate => candidate.outputArtifact !== undefined && candidate.outputDigest !== undefined && candidate.outputDigest === item.artifactDigest);
      const bytes = run && artifacts ? await artifacts.get(run.outputArtifact!) : undefined;
      if (!bytes || sha256(bytes) !== item.artifactDigest) add(issues, "REVIEWFN_PANEL_FINDING_INVALID", `${path}/artifactDigest`, `Evidence ${item.id} references no retained slot output with a matching digest.`);
    }
  }
  return new Map(report.evidence.map(item => [item.id, item]));
}

/**
 * Why `origin` cannot have reported a finding, if it cannot. Collapse affects quorum only: a collapsed run succeeded
 * with its own lens, so it is an origin like a completed run. Every other terminal produced no findings.
 */
function originProblem(origin: PanelFindingOrigin, slot: PanelSlot | undefined, runs: Map<string, SlotRun>): string | undefined {
  if (!slot) return "names no slot";
  if (slot.stage === "verifier") return "names a verifier slot";
  if (slot.lens !== origin.lens) return `has lens ${origin.lens}, but slot ${slot.id} uses lens ${slot.lens}`;
  const run = runs.get(slot.id);
  if (!run || !COUNTING.has(run.terminal)) return "names a slot without a completed or collapsed run";
  return undefined;
}

async function findingIssues(context: EvidenceContext, policy: ReviewPolicy, slots: Map<string, PanelSlot>, evidence: Map<string, Evidence>, issues: Issues): Promise<void> {
  const { report, options, referenceValid } = context;
  const runs = new Map(report.slotRuns.map(run => [run.slotId, run]));
  const requirementIds = new Set(report.requirementsReport?.requirements.map(requirement => requirement.id) ?? []);
  // The 0.1 bound applies to every recorded finding: dropped and suppressed findings stay in the report.
  if (report.findings.length > policy.limits.maxFindings) add(issues, "REVIEWFN_PANEL_FINDING_INVALID", "/findings", `The report records ${report.findings.length} findings, more than maxFindings (${policy.limits.maxFindings}).`);
  for (const { index, key } of duplicates(report.findings, finding => finding.fingerprint)) add(issues, "REVIEWFN_PANEL_FINDING_INVALID", `/findings/${index}/fingerprint`, `Fingerprint ${key} is reported more than once; merge the origins into one finding.`);
  for (const [index, finding] of report.findings.entries()) {
    const path = `/findings/${index}`;
    intrinsicFindingIssues(finding, path, issues);
    if (finding.disposition === "suppressed" && finding.suppressionReference && !waiverReferenceValid(finding.suppressionReference, referenceValid, policy)) add(issues, "REVIEWFN_PANEL_DISPOSITION_INVALID", `${path}/suppressionReference`, "The suppression reference does not cite a waiver authority verifiable against the frozen context.");
    if (!finding.evidenceIds.length) add(issues, "REVIEWFN_PANEL_FINDING_INVALID", `${path}/evidenceIds`, "A finding requires evidence.");
    for (const id of finding.evidenceIds) if (!evidence.has(id)) add(issues, "REVIEWFN_PANEL_FINDING_INVALID", `${path}/evidenceIds`, `Finding references unknown evidence ${id}.`);
    if (finding.evidenceIds.length && !finding.evidenceIds.some(id => ["code", "diff", "test"].includes(evidence.get(id)?.kind ?? ""))) add(issues, "REVIEWFN_PANEL_FINDING_INVALID", `${path}/evidenceIds`, "A finding requires code, diff or test evidence.");
    if (finding.basis === "reproduced" && !(await reproductionVerified(finding.evidenceIds, evidence, report.gateReceipts, report.change.headCommit, options.artifacts))) add(issues, "REVIEWFN_PANEL_FINDING_INVALID", `${path}/basis`, "A reproduced finding requires a completed gate receipt at the reviewed head with verified retained logs.");
    for (const id of finding.requirementIds) if (!requirementIds.has(id)) add(issues, "REVIEWFN_PANEL_FINDING_INVALID", `${path}/requirementIds`, `Finding references unknown requirement ${id}.`);
    finding.origins.forEach((origin, position) => {
      const reason = originProblem(origin, slots.get(origin.slotId), runs);
      if (reason) add(issues, "REVIEWFN_PANEL_ORIGIN_UNKNOWN", `${path}/origins/${position}`, `Origin ${origin.slotId} ${reason}.`);
    });
    const verification = finding.verification;
    if (!verification) continue;
    const verifier = slots.get(verification.slotId);
    if (!verifier) { add(issues, "REVIEWFN_PANEL_SLOT_UNKNOWN", `${path}/verification/slotId`, `Verification references unknown slot ${verification.slotId}.`); continue; }
    const verifierRun = runs.get(verifier.id);
    if (verifier.stage !== "verifier") add(issues, "REVIEWFN_PANEL_VERIFICATION_INVALID", `${path}/verification/slotId`, `Slot ${verifier.id} is not a verifier slot.`);
    // As for origins, collapse affects quorum only: a collapsed verifier run succeeded and its verification stands.
    if (!verifierRun || !COUNTING.has(verifierRun.terminal)) add(issues, "REVIEWFN_PANEL_VERIFICATION_INVALID", `${path}/verification/slotId`, `Verifier slot ${verifier.id} has no completed or collapsed run.`);
    else {
      const shared = finding.origins.find(origin => { const run = runs.get(origin.slotId); return run !== undefined && sameSlotIdentity(run.identity, verifierRun.identity); });
      if (shared) add(issues, "REVIEWFN_PANEL_VERIFICATION_INVALID", `${path}/verification/slotId`, `Verifier slot ${verifier.id} has the same identity as origin slot ${shared.slotId}; verification must be independent.`);
    }
    for (const id of verification.evidenceIds) if (!evidence.has(id)) add(issues, "REVIEWFN_PANEL_VERIFICATION_INVALID", `${path}/verification/evidenceIds`, `Verification references unknown evidence ${id}.`);
    if (verification.verdict !== "inconclusive" && !verification.evidenceIds.length) add(issues, "REVIEWFN_PANEL_VERIFICATION_INVALID", `${path}/verification/evidenceIds`, `A ${verification.verdict} verification requires evidence.`);
  }
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

/**
 * Evidence cited only as on-base evidence: by at least one verification whose `onBase` is `present` or `absent`, and
 * by no finding. Only this evidence may anchor at the merge base on any path, because it describes the base itself.
 */
function onBaseEvidenceIds(report: PanelReport): Set<string> {
  const findingCited = new Set(report.findings.flatMap(finding => finding.evidenceIds));
  const baseCited = new Set(report.findings.flatMap(finding => finding.verification && finding.verification.onBase !== "not_checked" ? finding.verification.evidenceIds : []));
  const otherCited = new Set(report.findings.flatMap(finding => finding.verification?.onBase === "not_checked" ? finding.verification.evidenceIds : []));
  return new Set([...baseCited].filter(id => !findingCited.has(id) && !otherCited.has(id)));
}

/**
 * Code anchors follow the 0.1 commit rule (`anchorCommitChecker`), with one narrow allowance for on-base evidence, and
 * are verified through source control; without it they fail closed.
 */
async function anchorIssues({ report, options, detail }: EvidenceContext, issues: Issues): Promise<void> {
  const { sourceControl, root } = options;
  const allowedCommit = anchorCommitChecker(report as unknown as ReviewReport, verifiedDeltaOf(report as unknown as ReviewReport, detail), sourceControl, root);
  const onBase = onBaseEvidenceIds(report);
  const anchors: Array<{ anchor: CodeAnchor; path: string; onBase: boolean }> = [
    ...report.evidence.flatMap((item, index) => item.code ? [{ anchor: item.code, path: `/evidence/${index}/code`, onBase: onBase.has(item.id) }] : []),
    ...report.findings.flatMap((finding, index) => finding.anchor ? [{ anchor: finding.anchor, path: `/findings/${index}/anchor`, onBase: false }] : []),
  ];
  for (const { anchor, path, onBase: baseEvidence } of anchors) {
    const allowed = (baseEvidence && anchor.commit === report.change.mergeBaseCommit) || await allowedCommit(anchor);
    if (!allowed) add(issues, "REVIEWFN_PANEL_FINDING_INVALID", path, `Anchor ${anchor.path}@${anchor.commit} does not reference the reviewed head; the merge base or since commit is allowed only for a changed path verified absent at head${baseEvidence ? "" : ", or for on-base verification evidence at the merge base"}.`);
    else if (!sourceControl || !root) add(issues, "REVIEWFN_PANEL_FINDING_INVALID", path, `Anchor ${anchor.path} cannot be verified without source control.`);
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
  if (!timestampExists(report.createdAt)) add(issues, "REVIEWFN_PANEL_SCHEMA", "/createdAt", `${report.createdAt} is not a real UTC time.`);
  const slots = new Map<string, PanelSlot>();
  report.slots.forEach((slot, index) => {
    if (slots.has(slot.id)) add(issues, "REVIEWFN_PANEL_SLOT_DUPLICATE", `/slots/${index}/id`, `Slot ${slot.id} is declared more than once.`);
    else slots.set(slot.id, slot);
  });
  const requirements: ReviewReport | undefined = report.requirementsReport;
  if (requirements && report.contextManifestDigest !== undefined && report.contextManifestDigest !== requirements.contextManifestDigest) add(issues, "REVIEWFN_REPORT_INVALID", "/requirementsReport/contextManifestDigest", "The requirements report used a different frozen context than the panel.");
  // Source references are verifiable only against the frozen context the report records.
  const contextDigest = report.contextManifestDigest ?? requirements?.contextManifestDigest;
  const context = options.context && contextDigest !== undefined && options.context.digest === contextDigest ? options.context : undefined;
  const evidenceContext: EvidenceContext = { report, options, referenceValid: sourceReferenceChecker(context, policy), detail: await verifyChangeDetail(report as unknown as ReviewReport, options.artifacts) };

  const bound = boundPanelPolicy(report, options.panelPolicy, issues);
  slotRunIssues(report, slots, issues, bound?.profiles);
  requirementsProvenanceIssues(report, bound, issues);
  const evidence = await evidenceIssues(evidenceContext, issues);
  await findingIssues(evidenceContext, policy, slots, evidence, issues);
  await anchorIssues(evidenceContext, issues);

  if (requirements) {
    if (stableStringify(requirements.change) !== stableStringify(report.change)) add(issues, "REVIEWFN_REPORT_INVALID", "/requirementsReport/change", "The requirements report reviewed a different change than the panel.");
    if (stableStringify(requirements.changeDetail ?? null) !== stableStringify(report.changeDetail ?? null)) add(issues, "REVIEWFN_REPORT_INVALID", "/requirementsReport/changeDetail", "The requirements report records different change detail than the panel.");
    const validation = await validateReport(requirements, policy, options.sourceControl, options.root, options.context, options.artifacts);
    issues.push(...validation.errors.map(error => reportIssue(error, "/requirementsReport")));
  } else {
    // The same change-detail and incremental-range checks 0.1 applies, on the panel's own change detail.
    issues.push(...evidenceContext.detail.errors.map(error => reportIssue(error, "/changeDetail")));
    const since = await sinceAncestryError(report, options.sourceControl, options.root);
    if (since) issues.push(reportIssue(since, "/changeDetail/since"));
  }

  const verdict = derivePanelVerdict(report, policy);
  if (report.verdict !== verdict) add(issues, "REVIEWFN_PANEL_VERDICT_MISMATCH", "/verdict", `Verdict ${String(report.verdict)} does not match derived verdict ${String(verdict)}.`);
  return { valid: issues.length === 0, issues, verdict };
}

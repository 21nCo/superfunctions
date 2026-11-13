import type { ChangeDetail, ChangeSnapshot, CoverageStatus, Evidence, Finding, FindingSeverity, ReviewReport, SourceReference, TestReceipt, Verdict } from "../types.js";

/** Lens priorities. Each maps onto the existing `FindingSeverity`; a panel lens never emits `info`. */
export type PanelPriority = "P0" | "P1" | "P2" | "P3";
export type PanelFindingSeverity = Exclude<FindingSeverity, "info">;

export const PANEL_PRIORITY_SEVERITY: Readonly<Record<PanelPriority, PanelFindingSeverity>> = Object.freeze({ P0: "critical", P1: "high", P2: "medium", P3: "low" });

/** Stage-1 and stage-2 slots review the change; `verifier` slots check findings. */
export type PanelSlotStage = 1 | 2 | "verifier";

export interface PanelSlot {
  /** Matches `^[a-z0-9][a-z0-9-]{0,62}$` and is unique within the panel. */
  id: string;
  stage: PanelSlotStage;
  harness: { adapter: string; version: string };
  /** `model: "configured"` defers to the harness default, as in 0.1, and is never a model mismatch. */
  inference: { provider: string; model: string; auth: string; credentialEnv?: string };
  lens: string;
  budget: { timeoutMs: number; maxOutputBytes: number };
}

/** Panel policy v1 (`.reviewfn/panel.json`). Loading and repository tightening belong to the panel orchestrator. */
export interface PanelPolicy {
  version: 1;
  slots: PanelSlot[];
  /** Completed runs with distinct identities each stage needs. */
  quorum: { stage1: number; stage2: number };
  /** The slot that extracts and assesses requirements, or null to skip requirement extraction. */
  requirementsSlot: string | null;
  /** 1–8; `PANEL_DEFAULT_MAX_CONCURRENT_SLOTS` when absent. */
  maxConcurrentSlots?: number;
  incremental: "full" | "delta";
}

export const PANEL_DEFAULT_MAX_CONCURRENT_SLOTS = 2;

/**
 * Slot identity: (harness adapter, harness version, provider, resolved model, auth mode, credential fingerprint).
 * Within a stage, the first `completed` run of an identity in policy order counts toward quorum; a later run of the
 * same identity that would also count is `collapsed`. Runs that do not complete neither count nor collapse.
 */
export interface SlotIdentity {
  harnessAdapter: string;
  /** The harness-reported version. */
  harnessVersion: string;
  provider: string;
  /** The model the harness resolved; the configured model when the harness reported none. */
  model: string;
  auth: string;
  /** First 16 hex characters of the SHA-256 of the credential value or the harness-reported account identity; absent when neither was observed. */
  credentialFingerprint?: string;
}

export type SlotRunTerminal = "completed" | "failed" | "canceled" | "quota_exhausted" | "timed_out" | "malformed" | "void" | "collapsed";
/**
 * `model_mismatch`: the resolved model differs from a configured model other than `configured`; such a run is always
 * `void` with this reason, whatever else happened. `workspace_mutated`: the slot changed its checkout.
 * `disallowed_tool_use`: the harness reported a forbidden tool.
 */
export type SlotVoidReason = "model_mismatch" | "workspace_mutated" | "disallowed_tool_use";

export interface SlotRun {
  slotId: string;
  identity: SlotIdentity;
  terminal: SlotRunTerminal;
  /** Nonempty exactly when `terminal` is `void`. */
  voidReasons: SlotVoidReason[];
  startedAt: string;
  finishedAt: string;
  outputArtifact?: string;
  outputDigest?: string;
  /** Recorded only when the harness observed the value; never estimated. */
  usage?: { inputTokens?: number; outputTokens?: number; costUsd?: number };
}

export interface PanelFindingOrigin {
  slotId: string;
  lens: string;
}

export type VerificationVerdict = "confirmed" | "refuted" | "inconclusive";

export interface PanelFindingVerification {
  verdict: VerificationVerdict;
  /** A completed `verifier` slot whose identity differs from every origin slot's identity. */
  slotId: string;
  evidenceIds: string[];
  /** Whether the defect is also present on the base revision. */
  onBase: "present" | "absent" | "not_checked";
  reason: string;
}

export type PanelFindingDisposition = "reported" | "dropped" | "suppressed";

/** A 0.1 `Finding` with panel provenance. Dropped and suppressed findings stay in the report. */
export interface PanelFinding extends Omit<Finding, "severity"> {
  severity: PanelFindingSeverity;
  /** Every completed lens slot that reported this finding; at least one. */
  origins: PanelFindingOrigin[];
  /** 0–1; informational only and never used for gating. */
  confidence: number;
  ruleIds: string[];
  verification?: PanelFindingVerification;
  disposition: PanelFindingDisposition;
  /** Required unless `disposition` is `reported`. */
  dispositionReason?: string;
  /** Required exactly when `disposition` is `suppressed`. */
  suppressionReference?: SourceReference;
}

/** A group of panel findings judged to describe one defect. Clustering itself is delivered separately. */
export interface PanelFindingCluster {
  id: string;
  findingFingerprints: string[];
}

export interface PanelReport {
  schemaVersion: 1;
  kind: "reviewfn-panel";
  runId: string;
  createdAt: string;
  change: ChangeSnapshot;
  changeDetail?: ChangeDetail;
  /**
   * Digest of the frozen context the run used; equal to the requirements report's when both are present. Source
   * references (suppressions and source evidence) are verified only against a context with this digest.
   */
  contextManifestDigest?: string;
  /** `panelPolicyDigest(policy)` of the policy the run used. */
  panelPolicyDigest: string;
  slots: PanelSlot[];
  slotRuns: SlotRun[];
  /** The requirements slot's 0.1 report; absent when the policy skips requirement extraction. */
  requirementsReport?: ReviewReport;
  /** Trusted gate receipts every slot received. */
  gateReceipts: TestReceipt[];
  /** Evidence cited by panel findings and verifications. */
  evidence: Evidence[];
  findings: PanelFinding[];
  clusters: PanelFindingCluster[];
  coverage: CoverageStatus;
  coverageReasons: string[];
  verdict?: Verdict;
}

/** Lens slot output: the 0.1 harness output without requirements or assessments. */
export interface LensOutput {
  findings: Finding[];
  evidence: Evidence[];
  inspectedPaths: string[];
  uninspected: Array<{ scope: string; reason: string }>;
}

export type PanelValidationCode =
  | "REVIEWFN_PANEL_SCHEMA"
  | "REVIEWFN_PANEL_SLOT_DUPLICATE"
  | "REVIEWFN_PANEL_SLOT_UNKNOWN"
  | "REVIEWFN_PANEL_FINDING_INVALID"
  | "REVIEWFN_PANEL_ORIGIN_UNKNOWN"
  | "REVIEWFN_PANEL_VERIFICATION_INVALID"
  | "REVIEWFN_PANEL_DISPOSITION_INVALID"
  | "REVIEWFN_PANEL_VERDICT_MISMATCH";

/** Errors from validating the embedded requirements report keep their 0.1 code, `REVIEWFN_REPORT_INVALID` unless 0.1 prefixes another. */
export type PanelReportIssueCode = PanelValidationCode | "REVIEWFN_REPORT_INVALID" | "REVIEWFN_CHANGE_DETAIL_MISMATCH" | "REVIEWFN_SINCE_NOT_ANCESTOR";

export interface PanelValidationIssue<Code extends string = PanelReportIssueCode> {
  code: Code;
  /** RFC 6901 JSON Pointer into the validated document; the empty string is the document root. */
  path: string;
  message: string;
}

export interface PanelValidationResult<Code extends string = PanelReportIssueCode> {
  valid: boolean;
  issues: PanelValidationIssue<Code>[];
}

export interface PanelReportValidationResult extends PanelValidationResult {
  /** The verdict derived from the requirements report plus reported panel findings, when the document is well formed. */
  verdict?: Verdict;
}

/** Outcome of the work an evidence record describes. Only `passed` satisfies the validator. */
export type EvidenceStatus = "passed" | "failed" | "blocked" | "skipped" | "not-applicable";

/** One hashed artifact. `path` is a relative POSIX path, unique within the record. */
export interface EvidenceArtifactHash {
  path: string;
  /** 64 lowercase hex characters. */
  sha256: string;
  /** Free format label, such as `catchfn.evidence-event/v1`. */
  format?: string;
}

export interface EvidenceSource {
  /** 40 or 64 lowercase hex characters. */
  commit: string;
  dirty: boolean;
  dirtyReason?: string | null;
  /** 64 lowercase hex characters, or null when the source has no lockfile. */
  lockfileSha256: string | null;
  /** At least one entry. */
  artifactHashes: EvidenceArtifactHash[];
}

export interface EvidenceEnvironment {
  os: string;
  arch: string;
  runtime: string;
  tools: Record<string, string>;
  /** For example a browser or framework. */
  attributes?: Record<string, string | null>;
}

export interface EvidenceTiming {
  /** RFC 3339 date-time with an offset. */
  startedAt: string;
  /** RFC 3339 date-time with an offset, not earlier than `startedAt`. */
  completedAt: string;
  durationMs: number;
}

/** An evidence record in format v1. */
export interface EvidenceRecordV1 {
  schemaVersion: 1;
  recordId: string;
  /** Free string; the caller's expiry policy decides which classes exist. */
  evidenceClass: string;
  /** At least one unique ID, such as `SET-25`. */
  subjectIds: string[];
  status: EvidenceStatus;
  source: EvidenceSource;
  environment: EvidenceEnvironment;
  timing: EvidenceTiming;
  /** RFC 3339 date-time with an offset. */
  expiresAt: string;
  supersedes?: string | null;
}

/** The maximum lifetime, in hours after `timing.completedAt`, of each evidence class. */
export type EvidenceExpiryPolicy = Readonly<Record<string, number>>;

export interface ValidateEvidenceRecordOptions {
  /** The commit the record must come from: 40 or 64 lowercase hex characters. */
  expectedCommit: string;
  /** The evaluation time: a `Date`, a finite number of epoch milliseconds (taken at its exact binary64 value) or an RFC 3339 date-time with an offset. */
  now: Date | number | string;
  /** Positive finite hours of elapsed time per evidence class, counting inserted leap seconds. */
  expiryPolicy: EvidenceExpiryPolicy;
}

export const EVIDENCE_FAILURE_CODES = [
  "EVIDENCE_OPTIONS_INVALID",
  "EVIDENCE_MISSING",
  "EVIDENCE_MISSING_FIELD",
  "EVIDENCE_MALFORMED",
  "EVIDENCE_CLASS_NOT_IN_POLICY",
  "EVIDENCE_EXPIRED",
  "EVIDENCE_EXPIRY_EXCEEDS_POLICY",
  "EVIDENCE_COMPLETED_IN_FUTURE",
  "EVIDENCE_COMMIT_MISMATCH",
  "EVIDENCE_DIRTY",
  "EVIDENCE_NOT_PASSED",
  // Reported only by verifyEvidence from `@superfunctions/evidence/node`.
  "EVIDENCE_ARTIFACT_MISSING",
  "EVIDENCE_ARTIFACT_NOT_REGULAR_FILE",
  "EVIDENCE_ARTIFACT_SYMLINK",
  "EVIDENCE_ARTIFACT_OUTSIDE_ROOT",
  "EVIDENCE_ARTIFACT_UNREADABLE",
  "EVIDENCE_ARTIFACT_HASH_MISMATCH",
] as const;

export type EvidenceFailureCode = (typeof EVIDENCE_FAILURE_CODES)[number];

export interface EvidenceFailure {
  code: EvidenceFailureCode;
  /** JSON Pointer (RFC 6901) to the member the failure is about. */
  path?: string;
  detail?: Readonly<Record<string, unknown>>;
}

export interface EvidenceValidationResult {
  /** True only when `failures` is empty. */
  ok: boolean;
  failures: EvidenceFailure[];
}

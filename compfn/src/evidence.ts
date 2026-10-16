/**
 * Evidence types: EvidenceType, Evidence, CreateEvidenceInput.
 */

export const EVIDENCE_TYPES: readonly string[] = [
  "automated_secfn",
  "automated_authfn",
  "automated_logfn",
  "automated_watchfn",
  "automated_hostfn",
  "automated_flowfn",
  "automated_filefn",
  "automated_plugfn",
  "manual_attestation",
  "file_upload",
  "questionnaire",
  "custom_check",
  "scoping_decision",
  "external_webhook",
] as const;

export type EvidenceType =
  | "automated_secfn"
  | "automated_authfn"
  | "automated_logfn"
  | "automated_watchfn"
  | "automated_hostfn"
  | "automated_flowfn"
  | "automated_filefn"
  | "automated_plugfn"
  | "manual_attestation"
  | "file_upload"
  | "questionnaire"
  | "custom_check"
  | "scoping_decision"
  | "external_webhook";

export interface Evidence {
  id: string;
  controlId: string;
  type: EvidenceType;
  sourceId?: string;
  frameworkRequirementId?: string;
  timestamp: number;
  actorId: string;
  outcome: "pass" | "fail" | "unknown";
  payload?: Record<string, unknown>;
  artifactRef?: string;
  createdAt: number;
}

export interface CreateEvidenceInput {
  controlId: string;
  type: EvidenceType;
  sourceId?: string;
  frameworkRequirementId?: string;
  timestamp?: number;
  actorId: string;
  outcome: "pass" | "fail" | "unknown";
  payload?: Record<string, unknown>;
  artifactRef?: string;
}

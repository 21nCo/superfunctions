/**
 * Evidence adapter contract: types and interface for pluggable evidence adapters.
 * Adapters translate external systems (secfn, authfn, etc.) into AdapterEvidence
 * which CompFn persists via evidence.create() when checks.run() is invoked.
 */

import type { EvidenceType } from "../evidence.js";

/**
 * Input passed to EvidenceAdapter.runCheck() when a check is run.
 * checkId and controlId come from the CheckDefinition; method and customConfig
 * are optional and may be used by the adapter to select behavior.
 */
export interface AdapterCheckInput {
  checkId: string;
  controlId: string;
  /** From CheckDefinition.adapterMethod (e.g. "getRbacStatus", "getMfaStatus"). */
  method?: string;
  /** From CheckDefinition.customConfig. */
  customConfig?: Record<string, unknown>;
}

/**
 * Evidence-shaped result returned by an adapter. CompFn sets controlId, sourceId,
 * and actorId when persisting; the adapter supplies type, outcome, and optional
 * timestamp, payload, artifactRef, frameworkRequirementId.
 */
export interface AdapterEvidence {
  type: EvidenceType;
  outcome: "pass" | "fail" | "unknown";
  timestamp?: number;
  payload?: Record<string, unknown>;
  artifactRef?: string;
  frameworkRequirementId?: string;
}

/**
 * Evidence adapter contract. Implementations must have:
 * - name: string (e.g. "secfn", "authfn")
 * - runCheck(input): Promise<AdapterEvidence>
 *
 * When a check with adapterName is run, config.adapters[adapterName] is looked up;
 * if present, runCheck({ checkId, controlId, method, customConfig }) is called.
 * The returned AdapterEvidence is persisted as one evidence record via evidence.create().
 */
export interface EvidenceAdapter {
  name: string;
  runCheck(input: AdapterCheckInput): Promise<AdapterEvidence>;
}

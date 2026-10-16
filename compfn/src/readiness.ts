/**
 * Readiness types: ControlReadiness, FrameworkReadiness, ReadinessStatus.
 */

export type ReadinessStatus = "compliant" | "not_compliant" | "not_applicable";

export interface ControlReadiness {
  controlId: string;
  status: ReadinessStatus;
  lastEvidenceAt?: number;
  lastEvidenceId?: string;
  requirementIds?: string[];
}

export interface FrameworkReadiness {
  frameworkId: string;
  status: ReadinessStatus;
  controlReadiness: ControlReadiness[];
  lastUpdated: number;
}

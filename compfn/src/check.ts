/**
 * Check types: CheckDefinition, RunCheckResult.
 */

export interface CheckDefinition {
  id: string;
  name: string;
  controlId: string;
  schedule?: string;
  trigger?: string;
  adapterName?: string;
  adapterMethod?: string;
  customConfig?: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

export interface RunCheckResult {
  checkId: string;
  controlId: string;
  evidenceId: string;
  outcome: "pass" | "fail" | "unknown";
  timestamp: number;
}

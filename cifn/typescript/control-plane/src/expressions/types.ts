/**
 * Expression evaluation types for CiFn pipeline conditions and interpolation.
 * Supports: github.*, secrets.*, success(), failure(), always(), and 2048-char cap.
 */

import type { StepStatus } from '../pipeline/types.js';

/** Maximum allowed length for a single expression or `if` string (bytes, UTF-8). */
export const EXPR_MAX_LENGTH = 2048;

/** GitHub context available in expressions. */
export interface GithubContext {
  ref?: string;
  repository?: string;
  sha?: string;
  event_name?: string;
}

/** Step outcomes for the current job (prior steps only). success()/failure()/always() use this. */
export type StepOutcome = StepStatus;

/** Context for evaluating boolean conditions (job/step `if`). */
export interface EvalContext {
  /** GitHub trigger context (ref, repository, sha, event_name). */
  github?: GithubContext;
  /** Resolve secret by name. Return null if not available. */
  getSecret?(name: string): Promise<string | null>;
  /** Status of prior steps in the same job (index = step index). success()/failure()/always() use this. */
  stepOutcomes?: StepOutcome[];
}

/** Context for interpolation (${{ ... }}) — includes hashFiles. */
export interface InterpolateContext extends EvalContext {
  /** Workspace root path for hashFiles(glob). */
  workspaceRoot?: string;
  /** Compute hash of files matching glob (relative to workspaceRoot). Deterministic. */
  hashFiles?(glob: string): Promise<string>;
}

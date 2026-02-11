/**
 * Build _cms workflow metadata for draft documents (deterministic shape).
 */

import type { CmsfnWorkflowMetadata, CmsfnWorkflowState } from "@cmsfn/core";

const DEFAULT_WORKFLOW_NAME = "default";

/**
 * Return the _cms object to store in a draft document.
 * updatedAt is ISO 8601 (deterministic for tests when passed in).
 */
export function writeCmsMetadata(
  state: CmsfnWorkflowState,
  options?: { workflowName?: string; assignees?: string[]; updatedAt?: string }
): CmsfnWorkflowMetadata {
  const workflowName = options?.workflowName ?? DEFAULT_WORKFLOW_NAME;
  const updatedAt = options?.updatedAt ?? new Date().toISOString();
  const meta: CmsfnWorkflowMetadata = {
    workflow: workflowName,
    state,
    updatedAt,
  };
  if (options?.assignees?.length) {
    meta.assignees = [...options.assignees];
  }
  return meta;
}

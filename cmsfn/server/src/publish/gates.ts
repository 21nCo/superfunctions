/**
 * Deterministic workflow gates: when publish/unpublish are allowed.
 * WF-001: in_review requires role override (doc.publish) to publish.
 */

import type { CmsfnWorkflowState } from "@cmsfn/core";

/**
 * Allow publish only when state is approved or published, or in_review with override.
 * Draft state is never publishable (must move to in_review then approved first).
 */
export function canPublish(
  state: CmsfnWorkflowState | undefined,
  hasDocPublishOverride: boolean
): boolean {
  if (!state) return false;
  if (state === "approved" || state === "published") return true;
  if (state === "in_review") return hasDocPublishOverride;
  return false; // draft
}

/**
 * Unpublish has no workflow gate; permission (doc.unpublish) is the only check.
 */
export function canUnpublish(): boolean {
  return true;
}

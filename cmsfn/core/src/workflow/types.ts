/**
 * CmsFn workflow metadata stored in draft documents under reserved _cms (SPEC.md).
 */

export type CmsfnWorkflowState =
  | "draft"
  | "in_review"
  | "approved"
  | "published";

export interface CmsfnWorkflowMetadata {
  workflow: string;
  state: CmsfnWorkflowState;
  assignees?: string[];
  updatedAt: string; // ISO 8601
}

/**
 * Reserved field key in ContentFn draft documents for workflow metadata.
 */
export const CMS_RESERVED_FIELD = "_cms";

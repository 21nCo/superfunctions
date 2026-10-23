/**
 * CmsFn release model types (SPEC.md).
 */

export interface CmsfnRelease {
  releaseId: string;
  dataset: string;
  name: string;
  publishAt?: string | null; // ISO 8601 or null
  docIds: string[];
  createdAt: string; // ISO 8601
  updatedAt: string; // ISO 8601
}

export interface CmsfnReleasePublishResult {
  releaseId: string;
  published: string[]; // doc IDs
  failures: Array<{ docId: string; code: string; message: string }>;
}

/**
 * CmsFn release model types (SPEC.md).
 */

export interface CmsfnRelease {
  releaseId: string;
  dataset: string;
  name: string;
  publishAt?: string | null; // ISO 8601 or null
  execution?: {
    runId: string;
    state: "running" | "complete" | "uncertain" | "blocked";
    published: string[];
    pending: string[];
    failures: Array<{ docId: string; code: string; message: string }>;
  };
  docIds: string[];
  createdAt: string; // ISO 8601
  updatedAt: string; // ISO 8601
}

export interface CmsfnReleasePublishResult {
  releaseId: string;
  published: string[]; // doc IDs
  /** Absent only after all captured documents have definitive outcomes. */
  execution?: { runId: string; state: "running" | "uncertain" | "blocked"; pending: string[] };
  failures: Array<{ docId: string; code: string; message: string }>;
}

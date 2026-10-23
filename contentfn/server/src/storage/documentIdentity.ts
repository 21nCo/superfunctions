import { createHash } from "node:crypto";
/** Bounded physical keys preserve unrestricted public IDs across SQL index limits. */
export function documentStorageId(dataset: string, documentId: string): string {
  return createHash("sha256").update(JSON.stringify([dataset, documentId])).digest("hex");
}
export function revisionStorageId(dataset: string, documentId: string, perspective: string, rev: string): string {
  return createHash("sha256").update(JSON.stringify([dataset, documentId, perspective, rev])).digest("hex");
}

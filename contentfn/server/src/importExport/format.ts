import type { ContentfnSchema, ContentfnDocument } from "@contentfn/core";

export const ARTIFACT_FORMAT_VERSION = 1;

export interface ContentfnExportArtifact {
  formatVersion: number;
  dataset: string;
  exportedAt: string;
  schema: {
    version: number;
    schemaHash: string;
    schemaJson: ContentfnSchema;
  } | null;
  publishedDocs: ContentfnDocument[];
  draftDocs: ContentfnDocument[];
  assets: AssetMetadataRecord[];
  revisions: RevisionRecord[];
}

export interface AssetMetadataRecord {
  assetId: string;
  contentType: string;
  filename: string;
  size: number;
  width: number | null;
  height: number | null;
  url: string;
  createdAt: string;
}

export interface RevisionRecord {
  docId: string;
  perspective: string;
  rev: string;
  timestamp: string;
  docJson: ContentfnDocument;
}

export function validateArtifact(artifact: unknown): artifact is ContentfnExportArtifact {
  if (artifact === null || typeof artifact !== "object") return false;
  const a = artifact as Record<string, unknown>;
  if (typeof a.formatVersion !== "number") return false;
  if (typeof a.dataset !== "string") return false;
  if (typeof a.exportedAt !== "string") return false;
  if (!Array.isArray(a.publishedDocs)) return false;
  if (!Array.isArray(a.draftDocs)) return false;
  if (!Array.isArray(a.assets)) return false;
  if (!Array.isArray(a.revisions)) return false;
  if (a.schema !== null && typeof a.schema !== "object") return false;
  return true;
}

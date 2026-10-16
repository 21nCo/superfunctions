import type { ContentfnSchema, ContentfnDocument } from "@contentfn/core";
import { isValidDatasetName, validateSchema } from "@contentfn/core";
import { jsonValue } from "../storage/document-validation.js";
import { schemaHash } from "../hash/schemaHash.js";

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

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
function timestamp(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value.slice(0, 10);
}
function document(value: unknown, perspective: "draft" | "published"): value is ContentfnDocument {
  if (!object(value) || !text(value._id) || !text(value._type) || !text(value._rev)
    || !timestamp(value._createdAt) || !timestamp(value._updatedAt)
    || (value._publishedAt !== undefined && !timestamp(value._publishedAt))) return false;
  if (perspective === "draft") return value._id.startsWith("drafts.") && value._id.length > 7;
  return !value._id.startsWith("drafts.");
}
function validateArtifactInternal(artifact: unknown): boolean {
  if (!object(artifact) || !jsonValue(artifact)) return false;
  const a = artifact;
  if (a.formatVersion !== ARTIFACT_FORMAT_VERSION || !isValidDatasetName(a.dataset as string) || !timestamp(a.exportedAt)) return false;
  if (!Array.isArray(a.publishedDocs) || !Array.isArray(a.draftDocs) || !Array.isArray(a.assets) || !Array.isArray(a.revisions)) return false;
  let schema: ContentfnSchema | undefined;
  if (a.schema !== null) {
    if (!object(a.schema)) return false;
    const checked = validateSchema(a.schema.schemaJson);
    if (!checked.ok || a.schema.version !== checked.result.version || a.schema.schemaHash !== schemaHash(checked.result)) return false;
    schema = checked.result;
  }
  if (!schema && (a.publishedDocs.length || a.draftDocs.length || a.revisions.length)) return false;
  const ids = new Set<string>();
  for (const perspective of ["published", "draft"] as const) {
    for (const value of (perspective === "published" ? a.publishedDocs : a.draftDocs)) {
      if (!document(value, perspective) || ids.has(value._id)) return false;
      ids.add(value._id);
      // Schema changes do not retroactively revalidate stored documents. An export
      // carries only the latest schema, not the schema version of each snapshot.
    }
  }
  const assets = new Set<string>();
  for (const value of a.assets) {
    if (!object(value) || !text(value.assetId) || assets.has(value.assetId) || !text(value.contentType)
      || !text(value.filename) || !text(value.url) || !Number.isSafeInteger(value.size) || (value.size as number) < 0
      || !timestamp(value.createdAt)) return false;
    for (const key of ["width", "height"] as const) {
      if (value[key] !== null && (!Number.isSafeInteger(value[key]) || (value[key] as number) <= 0)) return false;
    }
    assets.add(value.assetId);
  }
  const revisions = new Set<string>();
  for (const value of a.revisions) {
    if (!object(value) || !text(value.docId) || !text(value.rev) || !timestamp(value.timestamp)
      || (value.perspective !== "draft" && value.perspective !== "published")
      || !document(value.docJson, value.perspective) || value.docJson._id !== value.docId || value.docJson._rev !== value.rev) return false;
    const key = JSON.stringify([value.docId, value.perspective, value.rev]);
    if (revisions.has(key)) return false;
    revisions.add(key);
    // Historical snapshots may precede the current schema; do not revalidate old fields against it.
  }
  return true;
}
/** Deterministic predicate; rejects malformed import data without throwing or mutating it. */
export function validateArtifact(artifact: unknown): artifact is ContentfnExportArtifact {
  try { return validateArtifactInternal(artifact); } catch { return false; }
}

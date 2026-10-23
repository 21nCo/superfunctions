import { atomicMutation } from "./database.js";
/**
 * Document storage: create/get/delete with draft vs published perspectives.
 * Implements schema validation, system fields, and draft ID mapping.
 */

import type { ContentfnDatabase as Adapter } from "./database.js";
import type {
  ContentfnEnvelope,
  ContentfnDocument,
  ContentfnPatchOp,
} from "@contentfn/core";
import { ok, err, validatePatch } from "@contentfn/core";
import { nowISO } from "../time/clock.js";
import { generateRev } from "../rev/rev.js";
import { CONTENTFN_TABLE_NAMES } from "./schema.js";
import { datasetExists } from "./datasets.js";
import { schemaGet } from "./schemaStorage.js";
import { applyPatch } from "../patch/applyPatch.js";
import { appendEvent } from "./events.js";
import { appendRevision, appendRemovalRevision } from "./revisions.js";
import { documentStorageId } from "./documentIdentity.js";
import { validateDocumentAgainstSchema, normalizeMarkdownFields, validateReferences } from "./document-validation.js";

export interface DocsStorageConfig {
  maxRichtextBlocks?: number;
  db: Adapter;
  actor?: { subject: string };
}

/**
 * Normalize draft ID: if asDraft=true and id doesn't start with "drafts.", prepend it.
 */
function normalizeDraftId(id: string | undefined, asDraft: boolean): string {
  if (!asDraft) {
    // Published doc: if id starts with "drafts.", strip it (though API should enforce this at caller level)
    if (id && id.startsWith("drafts.")) {
      return id.substring(7);
    }
    return id || `doc_${Date.now()}_${Math.random().toString(36).substring(2, 10)}`;
  }

  // Draft doc: ensure "drafts." prefix
  const base = id || `doc_${Date.now()}_${Math.random().toString(36).substring(2, 10)}`;
  return base.startsWith("drafts.") ? base : `drafts.${base}`;
}

/**
 * Create a document.
 * - asDraft=true creates in drafts perspective (ID prefixed with "drafts.")
 * - asDraft=false creates in published perspective
 * - Validates required fields against schema
 * - Returns DOCUMENT_ALREADY_EXISTS if ID exists in target perspective
 */
export async function docCreate(
  config: DocsStorageConfig,
  input: {
    dataset: string;
    id?: string;
    type: string;
    doc: Record<string, unknown>;
    asDraft?: boolean;
  }
): Promise<ContentfnEnvelope<ContentfnDocument>> {
  if ("transaction" in config.db) return atomicMutation(config.db, db => docCreate({ ...config, db }, input));
  const exists = await datasetExists({ db: config.db }, input.dataset);
  if (!exists) {
    return err("DATASET_NOT_FOUND", "Dataset not found", { dataset: input.dataset });
  }

  const schemaRes = await schemaGet({ db: config.db }, { dataset: input.dataset });
  if (!schemaRes.ok) {
    return schemaRes as ContentfnEnvelope<ContentfnDocument>;
  }
  const schema = schemaRes.result;

  const normalized = normalizeMarkdownFields(schema, input.type, input.doc);
  if (!normalized.ok) return err("VALIDATION_FAILED", `Field "${normalized.field}" has invalid type: ${normalized.error}`, { path: normalized.field });
  // Validate document against schema
  const validation = validateDocumentAgainstSchema(schema, input.type, normalized.value, config.maxRichtextBlocks);
  if (!validation.ok) {
    return validation as ContentfnEnvelope<ContentfnDocument>;
  }

  const asDraft = input.asDraft ?? false;
  const docId = normalizeDraftId(input.id, asDraft);
  const table = asDraft ? CONTENTFN_TABLE_NAMES.docsDrafts : CONTENTFN_TABLE_NAMES.docsPublished;

  const references = await validateReferences(config.db, schema, input.dataset, asDraft ? "draft" : "published", input.type, normalized.value, docId);
  if (!references.ok) return references as ContentfnEnvelope<ContentfnDocument>;

  // Check if document already exists in target perspective
  const existing = await config.db.findOne({
    model: table,
    where: [
      { field: "dataset", operator: "eq" as const, value: input.dataset },
      { field: "id", operator: "eq" as const, value: documentStorageId(input.dataset, docId) },
    ],
  });

  if (existing) {
    return err("DOCUMENT_ALREADY_EXISTS", "Document already exists", { id: docId });
  }

  const now = nowISO();
  const rev = generateRev();

  const fullDoc: ContentfnDocument = {
    ...normalized.value,
    _id: docId,
    _type: input.type,
    _rev: rev,
    _createdAt: now,
    _updatedAt: now,
  };

  delete fullDoc._publishedAt;
  // If published, may have _publishedAt
  if (!asDraft) {
    fullDoc._publishedAt = now;
  }

  await config.db.create({
    model: table,
    data: {
      dataset: input.dataset,
      id: documentStorageId(input.dataset, docId),
      documentId: docId,
      type: input.type,
      docJson: fullDoc,
      rev,
      createdAt: now,
      updatedAt: now,
      ...(asDraft ? {} : { publishedAt: now }),
    },
  });

  await appendRevision(
    { db: config.db },
    {
      dataset: input.dataset,
      docId,
      perspective: asDraft ? "draft" : "published",
      rev,
      docJson: fullDoc,
    }
  );

  await appendEvent(config, { dataset: input.dataset, type: "doc.created", docId, rev, changedPaths: Object.keys(normalized.value) });
  return ok(fullDoc);
}

/** Create a new draft from the exact published revision; never replace an existing draft. */
export async function docFork(
  config: DocsStorageConfig,
  input: { dataset: string; id: string; ifRev: string },
): Promise<ContentfnEnvelope<ContentfnDocument>> {
  if ("transaction" in config.db) return atomicMutation(config.db, db => docFork({ ...config, db }, input));
  const id = input.id.replace(/^drafts\./, "");
  const source = await docGet(config, { dataset: input.dataset, id, perspective: "published" });
  if (!source.ok) return source;
  if (source.result._rev !== input.ifRev) return err("REV_CONFLICT", "Published document changed before draft creation", { expectedRev: input.ifRev, actualRev: source.result._rev });
  // Conditional write acquires the source row lock until the surrounding insertion commits.
  // Preserve the published revision and content: taking a draft copy is not a published edit.
  const locked = await config.db.updateMany({ model: CONTENTFN_TABLE_NAMES.docsPublished, where: [
    { field: "dataset", operator: "eq", value: input.dataset },
    { field: "id", operator: "eq", value: documentStorageId(input.dataset, id) },
    { field: "rev", operator: "eq", value: input.ifRev },
  ], data: { rev: input.ifRev } });
  if (locked !== 1) return err("REV_CONFLICT", "Published document changed during draft creation", { expectedRev: input.ifRev });
  const systemFields = new Set(["_id", "_type", "_rev", "_createdAt", "_updatedAt", "_publishedAt"]);
  const doc = Object.fromEntries(Object.entries(source.result).filter(([key]) => !systemFields.has(key)));
  return docCreate(config, { dataset: input.dataset, id, type: source.result._type, doc, asDraft: true });
}

/**
 * Get a document.
 * - perspective="published" returns only published docs
 * - perspective="draft" returns only draft docs
 * - perspective="raw" is not supported in PHASE_02 (returns QUERY_INVALID)
 * Returns DOCUMENT_NOT_FOUND if not present in requested perspective.
 */
export async function docGet(
  config: DocsStorageConfig,
  input: {
    dataset: string;
    id: string;
    perspective?: "published" | "draft" | "raw";
  }
): Promise<ContentfnEnvelope<ContentfnDocument>> {
  const exists = await datasetExists({ db: config.db }, input.dataset);
  if (!exists) {
    return err("DATASET_NOT_FOUND", "Dataset not found", { dataset: input.dataset });
  }

  const perspective = input.perspective ?? "published";
  if (perspective === "raw") {
    return err("QUERY_INVALID", "Perspective 'raw' is not supported in this phase", { perspective: "raw" });
  }

  const table = perspective === "draft" ? CONTENTFN_TABLE_NAMES.docsDrafts : CONTENTFN_TABLE_NAMES.docsPublished;

  const row = await config.db.findOne({
    model: table,
    where: [
      { field: "dataset", operator: "eq" as const, value: input.dataset },
      { field: "id", operator: "eq" as const, value: documentStorageId(input.dataset, perspective === "draft" && !input.id.startsWith("drafts.") ? `drafts.${input.id}` : input.id) },
    ],
  });

  if (!row) {
    return err("DOCUMENT_NOT_FOUND", "Document not found", { id: input.id });
  }

  const r = row as { docJson: ContentfnDocument };
  const schemaRes = await schemaGet({ db: config.db }, { dataset: input.dataset });
  if (!schemaRes.ok) return schemaRes as ContentfnEnvelope<ContentfnDocument>;
  const normalized = normalizeMarkdownFields(schemaRes.result, r.docJson._type, r.docJson);
  return normalized.ok ? ok(normalized.value as ContentfnDocument) : err("VALIDATION_FAILED", normalized.error, { path: normalized.field });
}

/**
 * Delete a document.
 * - purge=true removes from both draft and published perspectives
 * - purge=false removes from published only (default)
 */
export async function docDelete(
  config: DocsStorageConfig,
  input: {
    dataset: string;
    id: string;
    purge?: boolean;
  }
): Promise<ContentfnEnvelope<Record<string, never>>> {
  if ("transaction" in config.db) return atomicMutation(config.db, db => docDelete({ ...config, db }, input));
  const exists = await datasetExists({ db: config.db }, input.dataset);
  if (!exists) {
    return err("DATASET_NOT_FOUND", "Dataset not found", { dataset: input.dataset });
  }

  const purge = input.purge ?? false;
  const publishedId = input.id.startsWith("drafts.") ? input.id.substring(7) : input.id;

  let removedRev: string | undefined;
  for (const [model, documentId] of [
    [CONTENTFN_TABLE_NAMES.docsPublished, publishedId],
    ...(purge ? [[CONTENTFN_TABLE_NAMES.docsDrafts, `drafts.${publishedId}`]] : []),
  ]) {
    const row = await config.db.findOne({ model, where: [{ field: "dataset", operator: "eq", value: input.dataset }, { field: "id", operator: "eq", value: documentStorageId(input.dataset, documentId) }] });
    if (row) removedRev = await appendRemovalRevision(config, input.dataset, row.docJson as ContentfnDocument);
  }

  if (purge) {
    // Delete from both perspectives
    // Published doc uses the base ID
    await config.db.deleteMany({
      model: CONTENTFN_TABLE_NAMES.docsPublished,
      where: [
        { field: "dataset", operator: "eq" as const, value: input.dataset },
        { field: "id", operator: "eq" as const, value: documentStorageId(input.dataset, publishedId) },
      ],
    });
    // Draft doc uses "drafts." prefix
    const draftId = input.id.startsWith("drafts.") ? input.id : `drafts.${input.id}`;
    await config.db.deleteMany({
      model: CONTENTFN_TABLE_NAMES.docsDrafts,
      where: [
        { field: "dataset", operator: "eq" as const, value: input.dataset },
        { field: "id", operator: "eq" as const, value: documentStorageId(input.dataset, draftId) },
      ],
    });
  } else {
    // Delete from published only
    await config.db.deleteMany({
      model: CONTENTFN_TABLE_NAMES.docsPublished,
      where: [
        { field: "dataset", operator: "eq" as const, value: input.dataset },
        { field: "id", operator: "eq" as const, value: documentStorageId(input.dataset, publishedId) },
      ],
    });
  }

  await appendEvent(config, { dataset: input.dataset, type: "doc.deleted", docId: publishedId, rev: removedRev });
  return ok({});
}

/**
 * Patch a document with optimistic concurrency control.
 * - Loads the target document (draft if ID starts with "drafts.", else published)
 * - Checks ifRev for REV_CONFLICT if provided
 * - Applies patch operations in order
 * - Persists updated document with new _rev and _updatedAt
 * - Appends revision record
 * Implements PATCH-001, REV-001, and partial HIST-001.
 */
export async function docPatch(
  config: DocsStorageConfig,
  input: {
    dataset: string;
    id: string;
    ifRev?: string;
    ops: ContentfnPatchOp[];
  }
): Promise<ContentfnEnvelope<ContentfnDocument>> {
  if ("transaction" in config.db) return atomicMutation(config.db, db => docPatch({ ...config, db }, input));
  const exists = await datasetExists({ db: config.db }, input.dataset);
  if (!exists) {
    return err("DATASET_NOT_FOUND", "Dataset not found", { dataset: input.dataset });
  }

  const validatedPatch = validatePatch(input);
  if (!validatedPatch.ok) return validatedPatch as ContentfnEnvelope<ContentfnDocument>;
  for (const op of validatedPatch.result.ops) {
    if (["_id", "_type", "_rev", "_createdAt", "_updatedAt", "_publishedAt"].includes(op.path.split(".")[0])) {
      return err("PATCH_INVALID", "System fields cannot be modified", { path: op.path });
    }
  }
  // Determine perspective from ID
  const isDraft = input.id.startsWith("drafts.");
  const table = isDraft ? CONTENTFN_TABLE_NAMES.docsDrafts : CONTENTFN_TABLE_NAMES.docsPublished;
  const perspective = isDraft ? "draft" : "published";

  // Load current document
  const row = await config.db.findOne({
    model: table,
    where: [
      { field: "dataset", operator: "eq" as const, value: input.dataset },
      { field: "id", operator: "eq" as const, value: documentStorageId(input.dataset, input.id) },
    ],
  });

  if (!row) {
    return err("DOCUMENT_NOT_FOUND", "Document not found", { id: input.id });
  }

  const currentDoc = (row as { docJson: ContentfnDocument }).docJson;
  const currentRev = currentDoc._rev;

  // Optimistic concurrency check
  if (input.ifRev !== undefined && input.ifRev !== currentRev) {
    return err("REV_CONFLICT", "Revision conflict: document was modified", {
      expectedRev: input.ifRev,
      actualRev: currentRev,
    });
  }

  // Clone document to avoid mutation side effects during patch application
  const docCopy = JSON.parse(JSON.stringify(currentDoc)) as Record<string, unknown>;

  // Apply patch operations
  const patchResult = applyPatch(docCopy, input.ops);
  if (!patchResult.ok) {
    return patchResult as ContentfnEnvelope<ContentfnDocument>;
  }

  // Generate new revision and update system fields
  const newRev = generateRev();
  const now = nowISO();
  const updatedDoc: ContentfnDocument = {
    ...patchResult.result,
    _rev: newRev,
    _updatedAt: now,
  } as ContentfnDocument;

  const schemaRes = await schemaGet({ db: config.db }, { dataset: input.dataset });
  if (!schemaRes.ok) return schemaRes as ContentfnEnvelope<ContentfnDocument>;
  const normalized = normalizeMarkdownFields(schemaRes.result, currentDoc._type, updatedDoc);
  if (!normalized.ok) return err("VALIDATION_FAILED", normalized.error, { path: normalized.field });
  const validation = validateDocumentAgainstSchema(schemaRes.result, currentDoc._type, normalized.value, config.maxRichtextBlocks);
  if (!validation.ok) return validation as ContentfnEnvelope<ContentfnDocument>;
  const references = await validateReferences(config.db, schemaRes.result, input.dataset, perspective, currentDoc._type, normalized.value, input.id);
  if (!references.ok) return references as ContentfnEnvelope<ContentfnDocument>;
  const persistedDoc = normalized.value as ContentfnDocument;

  // Compare-and-swap is enforced by the database even across server processes.
  const updated = await config.db.updateMany({
    model: table,
    where: [
      { field: "dataset", operator: "eq", value: input.dataset },
      { field: "id", operator: "eq", value: documentStorageId(input.dataset, input.id) },
      { field: "rev", operator: "eq", value: currentRev },
    ],
    data: { docJson: persistedDoc, rev: newRev, updatedAt: now },
  });
  if (updated !== 1) return err("REV_CONFLICT", "Document changed during mutation", { expectedRev: currentRev });

  // Append revision record
  await appendRevision(
    { db: config.db },
    {
      dataset: input.dataset,
      docId: input.id,
      perspective,
      rev: newRev,
      docJson: persistedDoc,
    }
  );

  await appendEvent(config, { dataset: input.dataset, type: "doc.updated", docId: input.id, rev: newRev, changedPaths: input.ops.map(op => op.path) });
  return ok(persistedDoc);
}

/**
 * Document storage: create/get/delete with draft vs published perspectives.
 * Implements schema validation, system fields, and draft ID mapping.
 */

import type { Adapter } from "@superfunctions/db";
import type {
  ContentfnEnvelope,
  ContentfnDocument,
  ContentfnSchema,
  ContentfnDocumentType,
  ContentfnField,
  ContentfnFieldType,
  ContentfnPatchOp,
} from "@contentfn/core";
import { ok, err } from "@contentfn/core";
import { nowISO } from "../time/clock.js";
import { generateRev } from "../rev/rev.js";
import { CONTENTFN_TABLE_NAMES } from "./schema.js";
import { datasetExists } from "./datasets.js";
import { schemaGet } from "./schemaStorage.js";
import { applyPatch } from "../patch/applyPatch.js";
import { appendRevision } from "./revisions.js";
import { documentStorageId } from "./documentIdentity.js";
import { parseMarkdown } from "@mdfn/markdown";
import { calloutExtension, commonmarkExtension, diagramExtension, gfmExtension } from "@mdfn/extensions";
import { isMarkdownContent, markdownContent, type MarkdownContent, type MarkdownContentProfile } from "@mdfn/contentfn";

const markdownExtensionByName = {
  callout: calloutExtension,
  "directive/callout": calloutExtension,
  diagram: diagramExtension,
  "directive/diagram": diagramExtension,
} as const;

export interface DocsStorageConfig {
  db: Adapter;
}

/**
 * Validate document against schema.
 * Returns VALIDATION_FAILED if required fields missing or type mismatches.
 */
function validateDocumentAgainstSchema(
  schema: ContentfnSchema,
  docType: string,
  doc: Record<string, unknown>
): ContentfnEnvelope<void> {
  const type = schema.documentTypes.find((t) => t.name === docType);
  if (!type) {
    return err("VALIDATION_FAILED", `Document type "${docType}" not found in schema`, { type: docType });
  }

  // Validate required fields
  for (const field of type.fields) {
    if (field.required && !(field.name in doc)) {
      return err("VALIDATION_FAILED", `Required field "${field.name}" is missing`, { path: field.name });
    }
  }

  // Basic type validation (simplified for PHASE_02; full validation in later phases)
  for (const field of type.fields) {
    if (field.name in doc) {
      const value = doc[field.name];
      const valid = validateFieldType(field.type, value);
      if (!valid.ok) {
        return err("VALIDATION_FAILED", `Field "${field.name}" has invalid type: ${valid.error}`, {
          path: field.name,
        });
      }
    }
  }

  return ok(undefined);
}

function markdownProfile(fieldType: Extract<ContentfnFieldType, { kind: "markdown" }>): MarkdownContentProfile {
  const dialect = fieldType.dialect ?? "gfm";
  return {
    id: `mdfn:${dialect}`,
    dialect,
    allowRawHtml: fieldType.allowRawHtml ?? false,
    extensions: [...(fieldType.extensions ?? [])],
    schemaVersion: fieldType.schemaVersion ?? 1,
  };
}

function markdownProfilesEqual(left: MarkdownContentProfile, right: MarkdownContentProfile): boolean {
  return left.id === right.id
    && left.dialect === right.dialect
    && left.allowRawHtml === right.allowRawHtml
    && left.schemaVersion === right.schemaVersion
    && left.extensions.length === right.extensions.length
    && left.extensions.every((extension, index) => extension === right.extensions[index]);
}

function normalizeMarkdownFields(schema: ContentfnSchema, docType: string, doc: Record<string, unknown>): { ok: true; value: Record<string, unknown> } | { ok: false; field: string; error: string } {
  const type = schema.documentTypes.find((candidate) => candidate.name === docType);
  if (!type) return { ok: false, field: "_type", error: `document type ${docType} not found` };
  const value = { ...doc };
  for (const field of type.fields) {
    if (field.type.kind !== "markdown" || !(field.name in value) || value[field.name] == null) continue;
    const current = value[field.name];
    const expectedProfile = markdownProfile(field.type);
    if (typeof current === "string") value[field.name] = markdownContent(current, { profile: expectedProfile });
    else if (!isMarkdownContent(current)) return { ok: false, field: field.name, error: "expected a versioned Markdown value or legacy string" };
    else if (!markdownProfilesEqual(current.profile, expectedProfile)) return { ok: false, field: field.name, error: "markdown profile does not match the field schema" };
  }
  return { ok: true, value };
}

/**
 * Basic field type validation.
 */
function validateFieldType(
  fieldType: ContentfnFieldType,
  value: unknown
): { ok: true } | { ok: false; error: string } {
  if (value === null || value === undefined) {
    return { ok: true }; // nullable fields are handled by required check
  }

  switch (fieldType.kind) {
    case "primitive": {
      const { type } = fieldType;
      if (type === "string" || type === "text") {
        if (typeof value !== "string") return { ok: false, error: `expected string, got ${typeof value}` };
      } else if (type === "number") {
        if (typeof value !== "number") return { ok: false, error: `expected number, got ${typeof value}` };
      } else if (type === "boolean") {
        if (typeof value !== "boolean") return { ok: false, error: `expected boolean, got ${typeof value}` };
      } else if (type === "date" || type === "datetime") {
        if (typeof value !== "string") return { ok: false, error: `expected ISO string, got ${typeof value}` };
      } else if (type === "json") {
        // any JSON-serializable value is ok
      }
      return { ok: true };
    }
    case "reference": {
      // Reference must be canonical shape: { _type: "reference", _ref: string, _weak?: boolean }
      if (typeof value !== "object" || value === null) {
        return { ok: false, error: "reference must be object" };
      }
      const ref = value as Record<string, unknown>;
      if (ref._type !== "reference" || typeof ref._ref !== "string") {
        return { ok: false, error: 'reference must have _type="reference" and _ref as string' };
      }
      return { ok: true };
    }
    case "asset": {
      // Asset must be canonical shape: { _type: "asset", _ref: string, assetType: "file" | "image" }
      if (typeof value !== "object" || value === null) {
        return { ok: false, error: "asset must be object" };
      }
      const asset = value as Record<string, unknown>;
      if (asset._type !== "asset" || typeof asset._ref !== "string") {
        return { ok: false, error: 'asset must have _type="asset" and _ref as string' };
      }
      return { ok: true };
    }
    case "array": {
      if (!Array.isArray(value)) {
        return { ok: false, error: `expected array, got ${typeof value}` };
      }
      // Array element validation deferred to later phases
      return { ok: true };
    }
    case "object": {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return { ok: false, error: `expected object, got ${typeof value}` };
      }
      // Object field validation deferred to later phases
      return { ok: true };
    }
    case "richtext": {
      // Richtext is array of blocks (simplified validation for PHASE_02)
      if (!Array.isArray(value)) {
        return { ok: false, error: `expected richtext array, got ${typeof value}` };
      }
      return { ok: true };
    }
    case "markdown": {
      if (!isMarkdownContent(value)) return { ok: false, error: "expected versioned Markdown value" };
      try {
        const content = value as MarkdownContent;
        const dialect = content.profile.dialect;
        const configured = content.profile.extensions.map((name) => markdownExtensionByName[name as keyof typeof markdownExtensionByName]);
        if (configured.some((extension) => !extension)) return { ok: false, error: "unknown markdown extension" };
        parseMarkdown(content.markdown, { dialect, allowRawHtml: content.profile.allowRawHtml, schemaVersion: content.profile.schemaVersion, extensions: [commonmarkExtension, ...(dialect === "gfm" ? [gfmExtension] : []), ...configured] });
        return { ok: true };
      } catch (error) {
        return { ok: false, error: `invalid markdown: ${error instanceof Error ? error.message : String(error)}` };
      }
    }
    default:
      return { ok: false, error: `unknown field kind` };
  }
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
  const validation = validateDocumentAgainstSchema(schema, input.type, normalized.value);
  if (!validation.ok) {
    return validation as ContentfnEnvelope<ContentfnDocument>;
  }

  const asDraft = input.asDraft ?? false;
  const docId = normalizeDraftId(input.id, asDraft);
  const table = asDraft ? CONTENTFN_TABLE_NAMES.docsDrafts : CONTENTFN_TABLE_NAMES.docsPublished;

  // Check if document already exists in target perspective
  const existing = await config.db.findOne({
    model: table,
    where: [
      { field: "dataset", operator: "eq" as const, value: input.dataset },
      { field: "documentId", operator: "eq" as const, value: docId },
    ],
  });

  if (existing) {
    return err("DOCUMENT_ALREADY_EXISTS", "Document already exists", { id: docId });
  }

  const now = nowISO();
  const rev = generateRev();

  const fullDoc: ContentfnDocument = {
    _id: docId,
    _type: input.type,
    _rev: rev,
    _createdAt: now,
    _updatedAt: now,
    ...normalized.value,
  };

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

  return ok(fullDoc);
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
      { field: "documentId", operator: "eq" as const, value: input.id },
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
  const exists = await datasetExists({ db: config.db }, input.dataset);
  if (!exists) {
    return err("DATASET_NOT_FOUND", "Dataset not found", { dataset: input.dataset });
  }

  const purge = input.purge ?? false;

  if (purge) {
    // Delete from both perspectives
    // Published doc uses the base ID
    await config.db.deleteMany({
      model: CONTENTFN_TABLE_NAMES.docsPublished,
      where: [
        { field: "dataset", operator: "eq" as const, value: input.dataset },
        { field: "documentId", operator: "eq" as const, value: input.id },
      ],
    });
    // Draft doc uses "drafts." prefix
    const draftId = input.id.startsWith("drafts.") ? input.id : `drafts.${input.id}`;
    await config.db.deleteMany({
      model: CONTENTFN_TABLE_NAMES.docsDrafts,
      where: [
        { field: "dataset", operator: "eq" as const, value: input.dataset },
        { field: "documentId", operator: "eq" as const, value: draftId },
      ],
    });
  } else {
    // Delete from published only
    await config.db.deleteMany({
      model: CONTENTFN_TABLE_NAMES.docsPublished,
      where: [
        { field: "dataset", operator: "eq" as const, value: input.dataset },
        { field: "documentId", operator: "eq" as const, value: input.id },
      ],
    });
  }

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
  const exists = await datasetExists({ db: config.db }, input.dataset);
  if (!exists) {
    return err("DATASET_NOT_FOUND", "Dataset not found", { dataset: input.dataset });
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
      { field: "documentId", operator: "eq" as const, value: input.id },
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
  const validation = validateDocumentAgainstSchema(schemaRes.result, currentDoc._type, normalized.value);
  if (!validation.ok) return validation as ContentfnEnvelope<ContentfnDocument>;
  const persistedDoc = normalized.value as ContentfnDocument;

  // Persist updated document (delete old, create new with updated data)
  await config.db.deleteMany({
    model: table,
    where: [
      { field: "dataset", operator: "eq" as const, value: input.dataset },
      { field: "documentId", operator: "eq" as const, value: input.id },
    ],
  });

  await config.db.create({
    model: table,
    data: {
      dataset: input.dataset,
      id: documentStorageId(input.dataset, input.id),
      documentId: input.id,
      type: currentDoc._type,
      docJson: persistedDoc,
      rev: newRev,
      createdAt: currentDoc._createdAt,
      updatedAt: now,
      ...(isDraft ? {} : { publishedAt: currentDoc._publishedAt || now }),
    },
  });

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

  return ok(persistedDoc);
}

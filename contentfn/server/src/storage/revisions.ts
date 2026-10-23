import { datasetExists } from "./datasets.js";
import { schemaGet } from "./schemaStorage.js";
import { validateDocumentAgainstSchema, normalizeMarkdownFields, validateReferences } from "./document-validation.js";
import { appendEvent } from "./events.js";
import { atomicMutation } from "./database.js";
/**
 * Revision history storage (HIST-001).
 * Records immutable snapshots of document states after successful mutations.
 * For PHASE_03–05, we store full document snapshots; future phases may optimize with deltas.
 */

import type { WhereClause } from "@superfunctions/db";
import type { ContentfnDatabase as Adapter } from "./database.js";
import type { ContentfnDocument, ContentfnEnvelope } from "@contentfn/core";
import { ok, err } from "@contentfn/core";
import { nowISO } from "../time/clock.js";
import { generateRev } from "../rev/rev.js";
import { CONTENTFN_TABLE_NAMES } from "./schema.js";
import { documentStorageId, revisionStorageId } from "./documentIdentity.js";

export interface RevisionsStorageConfig {
  db: Adapter;
  actor?: { subject: string };
}

/**
 * Append a revision record for a document mutation.
 * Stores the full document snapshot at the given revision.
 *
 * @param config - Storage configuration
 * @param input - Revision details
 */
export async function appendRevision(
  config: RevisionsStorageConfig,
  input: {
    dataset: string;
    docId: string;
    perspective: "published" | "draft";
    rev: string;
    docJson: ContentfnDocument;
  }
): Promise<void> {
  const timestamp = nowISO();

  await config.db.create({
    model: CONTENTFN_TABLE_NAMES.revisions,
    data: {
      id: revisionStorageId(input.dataset, input.docId, input.perspective, input.rev),
      dataset: input.dataset,
      docId: input.docId,
      perspective: input.perspective,
      rev: input.rev,
      timestamp,
      docJson: input.docJson,
    },
  });
}

/**
 * List revision history for a document in reverse chronological order.
 * Returns revisions ordered by timestamp DESC, then rev ASC and storage identity ASC as tie-breakers.
 * Supports cursor-based pagination.
 *
 * TV-HIST-LIST-001
 */
export async function listHistory(
  config: RevisionsStorageConfig,
  input: {
    dataset: string;
    id: string;
    limit?: number;
    cursor?: string | null;
  }
): Promise<
  ContentfnEnvelope<{
    revisions: ContentfnDocument[];
    nextCursor: string | null;
  }>
> {
  const limit = input.limit ?? 10;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) return err("VALIDATION_FAILED", "History limit must be an integer from 1 to 1000", { path: "limit" });
  if (typeof input.dataset !== "string" || !input.dataset || typeof input.id !== "string" || !input.id || input.id === "drafts.") return err("VALIDATION_FAILED", "Dataset and document identity are required", {});
  const docId = input.id.replace(/^drafts\./, "");
  let cursor: { timestamp: string; rev: string; rowId: string } | undefined;
  if (input.cursor !== undefined && input.cursor !== null) {
    try {
      if (typeof input.cursor !== "string" || !input.cursor || input.cursor.length > 16384) throw Error();
      const value: unknown = JSON.parse(Buffer.from(input.cursor, "base64").toString("utf8"));
      if (!value || typeof value !== "object" || Array.isArray(value)) throw Error();
      const c = value as Record<string, unknown>;
      const sameScope = c.version === 2 ? c.scope === documentStorageId(input.dataset, docId) : c.version === 1 && c.dataset === input.dataset && c.docId === docId;
      if (!sameScope || typeof c.timestamp !== "string" || !c.timestamp || typeof c.rev !== "string" || !c.rev || typeof c.rowId !== "string" || !c.rowId) throw Error();
      cursor = { timestamp: c.timestamp, rev: c.rev, rowId: c.rowId };
    } catch { return err("VALIDATION_FAILED", "Invalid history cursor; restart pagination", { path: "cursor" }); }
  }
  if (!await datasetExists(config, input.dataset)) return err("DATASET_NOT_FOUND", "Dataset not found", { dataset: input.dataset });
  const scope: WhereClause[] = [
    { field: "dataset", operator: "eq", value: input.dataset },
  ];
  // The shared adapter expresses flat predicates. Three disjoint bounded ranges
  // per exact document identity implement keyset pagination without nested SQL.
  // Separate perspectives let a directional composite index satisfy ordering.
  const ranges: WhereClause[][] = cursor ? [
    [{ field: "timestamp", operator: "lt", value: cursor.timestamp }],
    [{ field: "timestamp", operator: "eq", value: cursor.timestamp }, { field: "rev", operator: "gt", value: cursor.rev }],
    [{ field: "timestamp", operator: "eq", value: cursor.timestamp }, { field: "rev", operator: "eq", value: cursor.rev }, { field: "id", operator: "gt", value: cursor.rowId }],
  ] : [[]];
  type Row = { id: string; timestamp: string; rev: string; docJson: ContentfnDocument };
  const rows: Row[] = [];
  for (const identity of [docId, `drafts.${docId}`]) for (const range of ranges) rows.push(...await config.db.findMany<Row>({
    model: CONTENTFN_TABLE_NAMES.revisions, where: [...scope, { field: "docId", operator: "eq", value: identity }, ...range],
    orderBy: [{ field: "timestamp", direction: "desc" }, { field: "rev", direction: "asc" }, { field: "id", direction: "asc" }],
    select: ["id", "timestamp", "rev", "docJson"], limit: limit + 1,
  }));
  const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
  rows.sort((a, b) => compare(b.timestamp, a.timestamp) || compare(a.rev, b.rev) || compare(a.id, b.id));
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  const nextCursor = rows.length > limit && last ? Buffer.from(JSON.stringify({ version: 2, scope: documentStorageId(input.dataset, docId), timestamp: last.timestamp, rev: last.rev, rowId: last.id })).toString("base64") : null;
  return ok({ revisions: page.map(row => structuredClone(row.docJson)), nextCursor });
}

/**
 * Restore a document revision to draft perspective.
 * Validates that the revision exists, then writes the restored content to drafts.{id}.
 * Generates a new _rev for the draft and appends a new revision record.
 *
 * TV-RESTORE-001, TV-RESTORE-002
 */
export async function restoreRevision(
  config: RevisionsStorageConfig,
  input: {
    dataset: string;
    id: string;
    rev: string;
  }
): Promise<ContentfnEnvelope<ContentfnDocument>> {
  if ("transaction" in config.db) return atomicMutation(config.db, db => restoreRevision({ ...config, db }, input));
  const docId = input.id.startsWith("drafts.") ? input.id.substring(7) : input.id;

  const revisions = await config.db.findMany({
    model: CONTENTFN_TABLE_NAMES.revisions,
    where: [
      { field: "dataset", operator: "eq" as const, value: input.dataset },
      { field: "rev", operator: "eq" as const, value: input.rev },
    ],
  });

  const matchingRev = revisions.find(
    (r: any) =>
      (r.docId === docId || r.docId === `drafts.${docId}`) && r.rev === input.rev
  );

  if (!matchingRev) {
    return err("VALIDATION_FAILED", "Revision not found", {
      dataset: input.dataset,
      id: input.id,
      rev: input.rev,
    });
  }

  const restoredDoc = (matchingRev as any).docJson as ContentfnDocument;
  const schema = await schemaGet(config, { dataset: input.dataset });
  if (!schema.ok) return schema;
  const normalized = normalizeMarkdownFields(schema.result, restoredDoc._type, restoredDoc);
  if (!normalized.ok) return err("VALIDATION_FAILED", normalized.error, { path: normalized.field });
  const validation = validateDocumentAgainstSchema(schema.result, restoredDoc._type, normalized.value);
  if (!validation.ok) return validation as ContentfnEnvelope<ContentfnDocument>;
  const references = await validateReferences(config.db, schema.result, input.dataset, "draft", restoredDoc._type, normalized.value, `drafts.${docId}`);
  if (!references.ok) return references as ContentfnEnvelope<ContentfnDocument>;
  const newRev = generateRev();
  const timestamp = nowISO();

  const draftId = `drafts.${docId}`;
  const draftDoc: ContentfnDocument = {
    ...restoredDoc,
    ...normalized.value,
    _id: draftId,
    _rev: newRev,
    _updatedAt: timestamp,
  };

  const existingDraft = await config.db.findOne({
    model: CONTENTFN_TABLE_NAMES.docsDrafts,
    where: [
      { field: "dataset", operator: "eq" as const, value: input.dataset },
      { field: "id", operator: "eq" as const, value: documentStorageId(input.dataset, draftId) },
    ],
  });

  if (existingDraft) {
    await config.db.update({
      model: CONTENTFN_TABLE_NAMES.docsDrafts,
      where: [
        { field: "dataset", operator: "eq" as const, value: input.dataset },
        { field: "id", operator: "eq" as const, value: documentStorageId(input.dataset, draftId) },
      ],
      data: {
        docJson: draftDoc,
        rev: newRev,
        updatedAt: timestamp,
      },
    });
  } else {
    await config.db.create({
      model: CONTENTFN_TABLE_NAMES.docsDrafts,
      data: {
        dataset: input.dataset,
        id: documentStorageId(input.dataset, draftId),
        documentId: draftId,
        type: restoredDoc._type,
        docJson: draftDoc,
        rev: newRev,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    });
  }

  await appendRevision(config, {
    dataset: input.dataset,
    docId: draftId,
    perspective: "draft",
    rev: newRev,
    docJson: draftDoc,
  });

  await appendEvent(config, { dataset: input.dataset, type: "doc.updated", docId: draftId, rev: newRev, changedPaths: Object.keys(draftDoc) });
  return ok(draftDoc);
}

/** Retain a new snapshot for document removal/unpublication so it can be restored. */
export async function appendRemovalRevision(config: RevisionsStorageConfig, dataset: string, document: ContentfnDocument): Promise<string> {
  const rev = generateRev();
  const snapshot = { ...document, _rev: rev, _updatedAt: nowISO() };
  await appendRevision(config, { dataset, docId: document._id, perspective: document._id.startsWith("drafts.") ? "draft" : "published", rev, docJson: snapshot });
  return rev;
}

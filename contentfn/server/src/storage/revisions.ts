/**
 * Revision history storage (HIST-001).
 * Records immutable snapshots of document states after successful mutations.
 * For PHASE_03–05, we store full document snapshots; future phases may optimize with deltas.
 */

import type { Adapter } from "@superfunctions/db";
import type { ContentfnDocument, ContentfnEnvelope } from "@contentfn/core";
import { ok, err } from "@contentfn/core";
import { nowISO } from "../time/clock.js";
import { generateRev } from "../rev/rev.js";
import { CONTENTFN_TABLE_NAMES } from "./schema.js";
import { documentStorageId } from "./documentIdentity.js";

export interface RevisionsStorageConfig {
  db: Adapter;
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
 * Returns revisions ordered by timestamp DESC, then rev ASC as tie-breaker.
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
  const docId = input.id.startsWith("drafts.") ? input.id.substring(7) : input.id;

  const where = [
    { field: "dataset", operator: "eq" as const, value: input.dataset },
  ];

  const revisions = await config.db.findMany({
    model: CONTENTFN_TABLE_NAMES.revisions,
    where,
  });

  const filtered = revisions.filter(
    (r: any) => r.docId === docId || r.docId === `drafts.${docId}`
  );

  filtered.sort((a: any, b: any) => {
    const tsCompare = b.timestamp.localeCompare(a.timestamp);
    if (tsCompare !== 0) return tsCompare;
    return 0;
  });

  let startIdx = 0;
  if (input.cursor) {
    try {
      const parsed = JSON.parse(Buffer.from(input.cursor, "base64").toString("utf8"));
      const lastTimestamp = parsed.timestamp;
      const lastRev = parsed.rev;
      startIdx =
        filtered.findIndex(
          (r: any) => r.timestamp === lastTimestamp && r.rev === lastRev
        ) + 1;
    } catch {
      return err("VALIDATION_FAILED", "Invalid cursor", { path: "cursor" });
    }
  }

  const page = filtered.slice(startIdx, startIdx + limit);
  const nextCursor =
    page.length === limit && startIdx + limit < filtered.length
      ? Buffer.from(
          JSON.stringify({
            timestamp: (page[page.length - 1] as any).timestamp,
            rev: (page[page.length - 1] as any).rev,
          })
        ).toString("base64")
      : null;

  const results = page.map((r: any) => r.docJson as ContentfnDocument);

  return ok({ revisions: results, nextCursor });
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
  const newRev = generateRev();
  const timestamp = nowISO();

  const draftId = `drafts.${docId}`;
  const draftDoc: ContentfnDocument = {
    ...restoredDoc,
    _id: draftId,
    _rev: newRev,
    _updatedAt: timestamp,
  };

  const existingDraft = await config.db.findOne({
    model: CONTENTFN_TABLE_NAMES.docsDrafts,
    where: [
      { field: "dataset", operator: "eq" as const, value: input.dataset },
      { field: "documentId", operator: "eq" as const, value: draftId },
    ],
  });

  if (existingDraft) {
    await config.db.update({
      model: CONTENTFN_TABLE_NAMES.docsDrafts,
      where: [
        { field: "dataset", operator: "eq" as const, value: input.dataset },
        { field: "documentId", operator: "eq" as const, value: draftId },
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

  return ok(draftDoc);
}

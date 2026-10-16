import { schemaGet } from "./schemaStorage.js";
import { normalizeMarkdownFields, validateDocumentAgainstSchema, validateReferences } from "./document-validation.js";
import { atomicMutation } from "./database.js";
import type { ContentfnDatabase as Adapter } from "./database.js";
import type { ContentfnEnvelope, ContentfnDocument } from "@contentfn/core";
import { ok, err } from "@contentfn/core";
import { nowISO } from "../time/clock.js";
import { generateRev } from "../rev/rev.js";
import { CONTENTFN_TABLE_NAMES } from "./schema.js";
import { datasetExists } from "./datasets.js";
import { appendEvent } from "./events.js";
import { appendRevision, appendRemovalRevision } from "./revisions.js";
import { documentStorageId } from "./documentIdentity.js";

export interface PublishStorageConfig {
  db: Adapter;
  actor?: { subject: string };
}

export async function docPublish(
  config: PublishStorageConfig,
  input: {
    dataset: string;
    id: string;
    ifRev?: string;
  }
): Promise<ContentfnEnvelope<ContentfnDocument>> {
  if ("transaction" in config.db) return atomicMutation(config.db, db => docPublish({ ...config, db }, input));
  const exists = await datasetExists({ db: config.db }, input.dataset);
  if (!exists) {
    return err("DATASET_NOT_FOUND", "Dataset not found", { dataset: input.dataset });
  }

  const draftId = input.id.startsWith("drafts.") ? input.id : `drafts.${input.id}`;
  const publishedId = input.id.startsWith("drafts.") ? input.id.substring(7) : input.id;

  const draftRow = await config.db.findOne({
    model: CONTENTFN_TABLE_NAMES.docsDrafts,
    where: [
      { field: "dataset", operator: "eq" as const, value: input.dataset },
      { field: "documentId", operator: "eq" as const, value: draftId },
    ],
  });

  if (!draftRow) {
    return err("DOCUMENT_NOT_FOUND", "Draft document not found", { id: draftId });
  }

  const draftDoc = (draftRow as { docJson: ContentfnDocument }).docJson;

  if (input.ifRev !== undefined && input.ifRev !== draftDoc._rev) {
    return err("REV_CONFLICT", "Revision conflict: draft was modified", {
      expectedRev: input.ifRev,
      actualRev: draftDoc._rev,
    });
  }

  const schema = await schemaGet(config, { dataset: input.dataset });
  if (!schema.ok) return schema;
  const normalized = normalizeMarkdownFields(schema.result, draftDoc._type, draftDoc);
  if (!normalized.ok) return err("VALIDATION_FAILED", normalized.error, { path: normalized.field });
  const validation = validateDocumentAgainstSchema(schema.result, draftDoc._type, normalized.value);
  if (!validation.ok) return validation as ContentfnEnvelope<ContentfnDocument>;
  const references = await validateReferences(config.db, schema.result, input.dataset, "published", draftDoc._type, normalized.value, publishedId);
  if (!references.ok) return references as ContentfnEnvelope<ContentfnDocument>;
  // Lock the captured draft revision through a conditional update before publication.
  const nextDraftRev = generateRev();
  const updatedDraft: ContentfnDocument = { ...draftDoc, _rev: nextDraftRev, _updatedAt: nowISO() };
  const locked = await config.db.updateMany({ model: CONTENTFN_TABLE_NAMES.docsDrafts, where: [
    { field: "dataset", operator: "eq", value: input.dataset },
    { field: "documentId", operator: "eq", value: draftId },
    { field: "rev", operator: "eq", value: draftDoc._rev },
  ], data: { rev: nextDraftRev, docJson: updatedDraft, updatedAt: updatedDraft._updatedAt } });
  if (locked !== 1) return err("REV_CONFLICT", "Draft changed during publication", { expectedRev: draftDoc._rev });
  await appendRevision(config, { dataset: input.dataset, docId: draftId, perspective: "draft", rev: nextDraftRev, docJson: updatedDraft });
  const now = nowISO();
  const newRev = generateRev();

  const publishedDoc: ContentfnDocument = {
    ...draftDoc,
    ...normalized.value,
    _id: publishedId,
    _rev: newRev,
    _updatedAt: now,
    _publishedAt: now,
  };

  const existingPublished = await config.db.findOne({
    model: CONTENTFN_TABLE_NAMES.docsPublished,
    where: [
      { field: "dataset", operator: "eq" as const, value: input.dataset },
      { field: "documentId", operator: "eq" as const, value: publishedId },
    ],
  });

  if (existingPublished) {
    await config.db.deleteMany({
      model: CONTENTFN_TABLE_NAMES.docsPublished,
      where: [
        { field: "dataset", operator: "eq" as const, value: input.dataset },
        { field: "documentId", operator: "eq" as const, value: publishedId },
      ],
    });
  }

  await config.db.create({
    model: CONTENTFN_TABLE_NAMES.docsPublished,
    data: {
      dataset: input.dataset,
      id: documentStorageId(input.dataset, publishedId),
      documentId: publishedId,
      type: publishedDoc._type,
      docJson: publishedDoc,
      rev: newRev,
      createdAt: publishedDoc._createdAt,
      updatedAt: now,
      publishedAt: now,
    },
  });

  await appendRevision(
    { db: config.db },
    {
      dataset: input.dataset,
      docId: publishedId,
      perspective: "published",
      rev: newRev,
      docJson: publishedDoc,
    }
  );

  await appendEvent(
    config,
    {
      dataset: input.dataset,
      type: "doc.published",
      docId: publishedId,
      rev: newRev,
      changedPaths: [],
    }
  );

  return ok(publishedDoc);
}

export async function docUnpublish(
  config: PublishStorageConfig,
  input: {
    dataset: string;
    id: string;
    ifRev?: string;
  }
): Promise<ContentfnEnvelope<Record<string, never>>> {
  if ("transaction" in config.db) return atomicMutation(config.db, db => docUnpublish({ ...config, db }, input));
  const exists = await datasetExists({ db: config.db }, input.dataset);
  if (!exists) {
    return err("DATASET_NOT_FOUND", "Dataset not found", { dataset: input.dataset });
  }

  const publishedId = input.id.startsWith("drafts.") ? input.id.substring(7) : input.id;

  const publishedRow = await config.db.findOne({
    model: CONTENTFN_TABLE_NAMES.docsPublished,
    where: [
      { field: "dataset", operator: "eq" as const, value: input.dataset },
      { field: "documentId", operator: "eq" as const, value: publishedId },
    ],
  });

  if (publishedRow && input.ifRev !== undefined) {
    const publishedDoc = (publishedRow as { docJson: ContentfnDocument }).docJson;
    if (input.ifRev !== publishedDoc._rev) {
      return err("REV_CONFLICT", "Revision conflict: published document was modified", {
        expectedRev: input.ifRev,
        actualRev: publishedDoc._rev,
      });
    }
  }

  const removedRev = publishedRow ? await appendRemovalRevision(config, input.dataset, (publishedRow as { docJson: ContentfnDocument }).docJson) : undefined;

  await config.db.deleteMany({
    model: CONTENTFN_TABLE_NAMES.docsPublished,
    where: [
      { field: "dataset", operator: "eq" as const, value: input.dataset },
      { field: "documentId", operator: "eq" as const, value: publishedId },
    ],
  });

  await appendEvent(
    config,
    {
      dataset: input.dataset,
      type: "doc.unpublished",
      rev: removedRev,
      docId: publishedId,
      changedPaths: [],
    }
  );

  return ok({});
}

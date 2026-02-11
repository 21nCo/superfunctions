import type { Adapter } from "@superfunctions/db";
import type { ContentfnEnvelope, ContentfnDocument } from "@contentfn/core";
import { ok, err } from "@contentfn/core";
import { nowISO } from "../time/clock.js";
import { generateRev } from "../rev/rev.js";
import { CONTENTFN_TABLE_NAMES } from "./schema.js";
import { datasetExists } from "./datasets.js";
import { appendEvent } from "./events.js";
import { appendRevision } from "./revisions.js";

export interface PublishStorageConfig {
  db: Adapter;
}

export async function docPublish(
  config: PublishStorageConfig,
  input: {
    dataset: string;
    id: string;
    ifRev?: string;
  }
): Promise<ContentfnEnvelope<ContentfnDocument>> {
  const exists = await datasetExists({ db: config.db }, input.dataset);
  if (!exists) {
    return err("DATASET_NOT_FOUND", "Dataset not found", { dataset: input.dataset });
  }

  const draftId = input.id.startsWith("drafts.") ? input.id : `drafts.${input.id}`;
  const publishedId = input.id.startsWith("drafts.") ? input.id.substring(7) : input.id;

  const draftRow = await config.db.findOne({
    model: CONTENTFN_TABLE_NAMES.docsDrafts,
    where: [
      { field: "dataset", operator: "eq", value: input.dataset },
      { field: "id", operator: "eq", value: draftId },
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

  const now = nowISO();
  const newRev = generateRev();

  const publishedDoc: ContentfnDocument = {
    ...draftDoc,
    _id: publishedId,
    _rev: newRev,
    _updatedAt: now,
    _publishedAt: now,
  };

  const existingPublished = await config.db.findOne({
    model: CONTENTFN_TABLE_NAMES.docsPublished,
    where: [
      { field: "dataset", operator: "eq", value: input.dataset },
      { field: "id", operator: "eq", value: publishedId },
    ],
  });

  if (existingPublished) {
    await config.db.deleteMany({
      model: CONTENTFN_TABLE_NAMES.docsPublished,
      where: [
        { field: "dataset", operator: "eq", value: input.dataset },
        { field: "id", operator: "eq", value: publishedId },
      ],
    });
  }

  await config.db.create({
    model: CONTENTFN_TABLE_NAMES.docsPublished,
    data: {
      dataset: input.dataset,
      id: publishedId,
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
    { db: config.db },
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
  const exists = await datasetExists({ db: config.db }, input.dataset);
  if (!exists) {
    return err("DATASET_NOT_FOUND", "Dataset not found", { dataset: input.dataset });
  }

  const publishedId = input.id.startsWith("drafts.") ? input.id.substring(7) : input.id;

  const publishedRow = await config.db.findOne({
    model: CONTENTFN_TABLE_NAMES.docsPublished,
    where: [
      { field: "dataset", operator: "eq", value: input.dataset },
      { field: "id", operator: "eq", value: publishedId },
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

  await config.db.deleteMany({
    model: CONTENTFN_TABLE_NAMES.docsPublished,
    where: [
      { field: "dataset", operator: "eq", value: input.dataset },
      { field: "id", operator: "eq", value: publishedId },
    ],
  });

  await appendEvent(
    { db: config.db },
    {
      dataset: input.dataset,
      type: "doc.unpublished",
      docId: publishedId,
      changedPaths: [],
    }
  );

  return ok({});
}

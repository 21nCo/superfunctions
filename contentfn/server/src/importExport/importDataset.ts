import type { Adapter } from "@superfunctions/db";
import type { ContentfnEnvelope } from "@contentfn/core";
import { ok, err } from "@contentfn/core";
import { CONTENTFN_TABLE_NAMES } from "../storage/schema.js";
import { datasetExists } from "../storage/datasets.js";
import { datasetCreate } from "../storage/datasets.js";
import { schemaHash } from "../hash/schemaHash.js";
import { nowISO } from "../time/clock.js";
import { validateArtifact, type ContentfnExportArtifact } from "./format.js";

export interface ImportConfig {
  db: Adapter;
}

export async function importDataset(
  config: ImportConfig,
  input: { dataset: string; artifact: unknown }
): Promise<ContentfnEnvelope<Record<string, never>>> {
  if (!validateArtifact(input.artifact)) {
    return err("VALIDATION_FAILED", "Malformed import artifact", { path: "artifact" });
  }

  const artifact = input.artifact;

  const exists = await datasetExists({ db: config.db }, input.dataset);
  if (!exists) {
    const createResult = await datasetCreate({ db: config.db }, { dataset: input.dataset });
    if (!createResult.ok) {
      return createResult as ContentfnEnvelope<Record<string, never>>;
    }
  }

  if (artifact.schema) {
    const hash = schemaHash(artifact.schema.schemaJson);
    const now = nowISO();

    const existingSchema = await config.db.findOne({
      model: CONTENTFN_TABLE_NAMES.schema,
      where: [{ field: "dataset", operator: "eq", value: input.dataset }],
    });

    if (existingSchema) {
      const cur = existingSchema as { version: number };
      if (artifact.schema.version < cur.version) {
        return err("SCHEMA_VERSION_CONFLICT", "Import schema version is older than current", {
          dataset: input.dataset,
        });
      }
      await config.db.update({
        model: CONTENTFN_TABLE_NAMES.schema,
        where: [{ field: "dataset", operator: "eq", value: input.dataset }],
        data: {
          version: artifact.schema.version,
          schemaJson: artifact.schema.schemaJson,
          schemaHash: hash,
          updatedAt: now,
        },
      });
    } else {
      await config.db.create({
        model: CONTENTFN_TABLE_NAMES.schema,
        data: {
          id: input.dataset,
          dataset: input.dataset,
          version: artifact.schema.version,
          schemaJson: artifact.schema.schemaJson,
          schemaHash: hash,
          updatedAt: now,
        },
      });
    }
  }

  for (const doc of artifact.publishedDocs) {
    const existing = await config.db.findOne({
      model: CONTENTFN_TABLE_NAMES.docsPublished,
      where: [
        { field: "dataset", operator: "eq", value: input.dataset },
        { field: "id", operator: "eq", value: doc._id },
      ],
    });
    if (existing) {
      await config.db.update({
        model: CONTENTFN_TABLE_NAMES.docsPublished,
        where: [
          { field: "dataset", operator: "eq", value: input.dataset },
          { field: "id", operator: "eq", value: doc._id },
        ],
        data: {
          type: doc._type,
          docJson: doc,
          rev: doc._rev,
          updatedAt: doc._updatedAt,
          publishedAt: doc._publishedAt ?? null,
        },
      });
    } else {
      await config.db.create({
        model: CONTENTFN_TABLE_NAMES.docsPublished,
        data: {
          dataset: input.dataset,
          id: doc._id,
          type: doc._type,
          docJson: doc,
          rev: doc._rev,
          createdAt: doc._createdAt,
          updatedAt: doc._updatedAt,
          publishedAt: doc._publishedAt ?? null,
        },
      });
    }
  }

  for (const doc of artifact.draftDocs) {
    const existing = await config.db.findOne({
      model: CONTENTFN_TABLE_NAMES.docsDrafts,
      where: [
        { field: "dataset", operator: "eq", value: input.dataset },
        { field: "id", operator: "eq", value: doc._id },
      ],
    });
    if (existing) {
      await config.db.update({
        model: CONTENTFN_TABLE_NAMES.docsDrafts,
        where: [
          { field: "dataset", operator: "eq", value: input.dataset },
          { field: "id", operator: "eq", value: doc._id },
        ],
        data: {
          type: doc._type,
          docJson: doc,
          rev: doc._rev,
          updatedAt: doc._updatedAt,
        },
      });
    } else {
      await config.db.create({
        model: CONTENTFN_TABLE_NAMES.docsDrafts,
        data: {
          dataset: input.dataset,
          id: doc._id,
          type: doc._type,
          docJson: doc,
          rev: doc._rev,
          createdAt: doc._createdAt,
          updatedAt: doc._updatedAt,
        },
      });
    }
  }

  for (const asset of artifact.assets) {
    const existing = await config.db.findOne({
      model: CONTENTFN_TABLE_NAMES.assets,
      where: [
        { field: "dataset", operator: "eq", value: input.dataset },
        { field: "assetId", operator: "eq", value: asset.assetId },
      ],
    });
    if (!existing) {
      await config.db.create({
        model: CONTENTFN_TABLE_NAMES.assets,
        data: {
          dataset: input.dataset,
          assetId: asset.assetId,
          contentType: asset.contentType,
          filename: asset.filename,
          size: asset.size,
          width: asset.width,
          height: asset.height,
          url: asset.url,
          createdAt: asset.createdAt,
        },
      });
    }
  }

  for (const rev of artifact.revisions) {
    const existing = await config.db.findOne({
      model: CONTENTFN_TABLE_NAMES.revisions,
      where: [
        { field: "dataset", operator: "eq", value: input.dataset },
        { field: "docId", operator: "eq", value: rev.docId },
        { field: "rev", operator: "eq", value: rev.rev },
      ],
    });
    if (!existing) {
      await config.db.create({
        model: CONTENTFN_TABLE_NAMES.revisions,
        data: {
          dataset: input.dataset,
          docId: rev.docId,
          perspective: rev.perspective,
          rev: rev.rev,
          timestamp: rev.timestamp,
          docJson: rev.docJson,
        },
      });
    }
  }

  return ok({});
}

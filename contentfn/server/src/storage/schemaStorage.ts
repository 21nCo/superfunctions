import { validateDocumentAgainstSchema } from "./document-validation.js";
import { atomicMutation } from "./database.js";
/**
 * Schema storage: read/write schema records per dataset.
 * Enforces monotonic versioning and deterministic schemaHash.
 */

import type { ContentfnDatabase as Adapter } from "./database.js";
import type { ContentfnSchema, ContentfnEnvelope } from "@contentfn/core";
import { ok, err, validateSchema } from "@contentfn/core";
import { nowISO } from "@contentfn/core";
import { CONTENTFN_TABLE_NAMES } from "./schema.js";
import { schemaHash } from "../hash/schemaHash.js";
import { datasetExists } from "./datasets.js";

export interface SchemaStorageConfig {
  db: Adapter;
}

/**
 * Get schema for a dataset. Returns DATASET_NOT_FOUND when dataset missing, SCHEMA_NOT_FOUND when no schema yet.
 */
export async function schemaGet(
  config: SchemaStorageConfig,
  input: { dataset: string }
): Promise<ContentfnEnvelope<ContentfnSchema>> {
  const exists = await datasetExists({ db: config.db }, input.dataset);
  if (!exists) {
    return err("DATASET_NOT_FOUND", "Dataset not found", { dataset: input.dataset });
  }

  const row = await config.db.findOne({
    model: CONTENTFN_TABLE_NAMES.schema,
    where: [{ field: "dataset", operator: "eq" as const, value: input.dataset }],
  });
  if (!row) {
    return err("SCHEMA_NOT_FOUND", "Schema not found for dataset", { dataset: input.dataset });
  }

  const r = row as { schemaJson: ContentfnSchema };
  return ok(r.schemaJson);
}

/**
 * Upsert schema: validate, enforce monotonic version, compute hash, write.
 * Returns SCHEMA_INVALID, SCHEMA_VERSION_CONFLICT, DATASET_NOT_FOUND as appropriate.
 */
export async function schemaUpsert(
  config: SchemaStorageConfig,
  input: { dataset: string; schema: ContentfnSchema; migration?: { description: string } }
): Promise<ContentfnEnvelope<{ schemaHash: string }>> {
  if ("transaction" in config.db) return atomicMutation(config.db, db => schemaUpsert({ ...config, db }, input));
  const exists = await datasetExists({ db: config.db }, input.dataset);
  if (!exists) {
    return err("DATASET_NOT_FOUND", "Dataset not found", { dataset: input.dataset });
  }

  const validated = validateSchema(input.schema);
  if (!validated.ok) {
    return validated;
  }
  const schema = validated.result;
  const hash = schemaHash(schema);

  const existing = await config.db.findOne({
    model: CONTENTFN_TABLE_NAMES.schema,
    where: [{ field: "dataset", operator: "eq" as const, value: input.dataset }],
  });

  const now = nowISO();
  if (!existing) {
    await config.db.create({
      model: CONTENTFN_TABLE_NAMES.schema,
      data: {
        id: input.dataset,
        dataset: input.dataset,
        version: schema.version,
        schemaJson: schema,
        schemaHash: hash,
        updatedAt: now,
      },
    });
    return ok({ schemaHash: hash });
  }

  const cur = existing as { version: number; schemaHash: string; schemaJson: ContentfnSchema };
  if (schema.version < cur.version) {
    return err("SCHEMA_VERSION_CONFLICT", "Schema version must be monotonic", {
      dataset: input.dataset,
    });
  }
  if (schema.version === cur.version && JSON.stringify(schema) !== JSON.stringify(cur.schemaJson)) {
    return err("SCHEMA_VERSION_CONFLICT", "Same version with different content", {
      dataset: input.dataset,
    });
  }
  if (schema.version === cur.version && hash === cur.schemaHash) {
    return ok({ schemaHash: hash });
  }

  if (input.migration !== undefined && (!input.migration || typeof input.migration.description !== "string" || !input.migration.description.trim() || input.migration.description.length > 2000)) return err("VALIDATION_FAILED", "migration.description must document the explicit migration steps", { path: "migration.description" });
  if (!input.migration) {
    for (const model of [CONTENTFN_TABLE_NAMES.docsDrafts, CONTENTFN_TABLE_NAMES.docsPublished]) {
      const documents = await config.db.findMany({ model, where: [{ field: "dataset", operator: "eq", value: input.dataset }] });
      for (const row of documents) {
        const document = row.docJson as import("@contentfn/core").ContentfnDocument;
        const compatible = validateDocumentAgainstSchema(schema, document._type, document);
        if (!compatible.ok) return err("SCHEMA_INVALID", "Schema would invalidate existing content; migrate it first or provide migration.description", { id: document._id, path: compatible.error.details.path });
      }
    }
  }
  await config.db.update({
    model: CONTENTFN_TABLE_NAMES.schema,
    where: [{ field: "dataset", operator: "eq" as const, value: input.dataset }],
    data: {
      version: schema.version,
      schemaJson: schema,
      schemaHash: hash,
      updatedAt: now,
    },
  });
  return ok({ schemaHash: hash });
}

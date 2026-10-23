/**
 * Dataset lifecycle: create, list, delete.
 * Uses @superfunctions/db adapter; table contentfn_datasets.
 */

import type { Adapter } from "@superfunctions/db";
import type { ContentfnEnvelope } from "@contentfn/core";
import { ok, err } from "@contentfn/core";
import { validateDatasetName } from "@contentfn/core";
import { nowISO } from "@contentfn/core";
import { CONTENTFN_TABLE_NAMES } from "./schema.js";

export interface DatasetsStorageConfig {
  db: Adapter;
}

/** Check if dataset exists (has a non-deleted row). */
export async function datasetExists(
  config: DatasetsStorageConfig,
  name: string
): Promise<boolean> {
  const row = await config.db.findOne({
    model: CONTENTFN_TABLE_NAMES.datasets,
    where: [
      { field: "name", operator: "eq" as const, value: name },
      { field: "deletedAt", operator: "eq" as const, value: null },
    ],
  });
  return row != null;
}

/**
 * Create a dataset. Returns VALIDATION_FAILED for invalid name, DATASET_ALREADY_EXISTS for duplicate.
 */
export async function datasetCreate(
  config: DatasetsStorageConfig,
  input: { dataset: string }
): Promise<ContentfnEnvelope<{ dataset: string }>> {
  const v = validateDatasetName(input.dataset);
  if (!v.ok) {
    return err("VALIDATION_FAILED", "Dataset name is invalid", { path: "dataset" });
  }
  const name = v.name;

  const existing = await config.db.findOne({
    model: CONTENTFN_TABLE_NAMES.datasets,
    where: [{ field: "name", operator: "eq" as const, value: name }],
  });
  if (existing) {
    return err("DATASET_ALREADY_EXISTS", "Dataset already exists", { dataset: name });
  }

  const now = nowISO();
  await config.db.create({
    model: CONTENTFN_TABLE_NAMES.datasets,
    data: {
      id: name,
      name,
      createdAt: now,
      deletedAt: null,
    },
  });
  return ok({ dataset: name });
}

/**
 * List all dataset names (non-deleted). Returns empty array when none.
 */
export async function datasetList(
  config: DatasetsStorageConfig,
  _input: Record<string, never>
): Promise<ContentfnEnvelope<{ datasets: string[] }>> {
  const rows = await config.db.findMany({
    model: CONTENTFN_TABLE_NAMES.datasets,
    where: [{ field: "deletedAt", operator: "eq" as const, value: null }],
    orderBy: [{ field: "name", direction: "asc" }],
  });
  const datasets = (rows as { name: string }[]).map((r) => r.name);
  return ok({ datasets });
}

/**
 * Delete a dataset. Idempotent for non-existent (ok). After delete, schema/get etc. return DATASET_NOT_FOUND.
 */
export async function datasetDelete(
  config: DatasetsStorageConfig,
  input: { dataset: string }
): Promise<ContentfnEnvelope<Record<string, never>>> {
  const v = validateDatasetName(input.dataset);
  if (!v.ok) {
    return err("VALIDATION_FAILED", "Dataset name is invalid", { path: "dataset" });
  }
  const name = v.name;

  await config.db.deleteMany({
    model: CONTENTFN_TABLE_NAMES.datasets,
    where: [{ field: "name", operator: "eq" as const, value: name }],
  });
  await config.db.deleteMany({
    model: CONTENTFN_TABLE_NAMES.schema,
    where: [{ field: "dataset", operator: "eq" as const, value: name }],
  });
  return ok({});
}

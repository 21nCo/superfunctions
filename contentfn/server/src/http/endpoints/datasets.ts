/**
 * HTTP handlers for dataset create/list/delete.
 */

import type { ContentfnEnvelope } from "@contentfn/core";
import { datasetCreate, datasetList, datasetDelete } from "../../storage/datasets.js";
import type { DatasetsStorageConfig } from "../../storage/datasets.js";

export interface DatasetsEndpointsConfig extends DatasetsStorageConfig {}

export async function handleDatasetsCreate(
  config: DatasetsEndpointsConfig,
  body: unknown
): Promise<ContentfnEnvelope<{ dataset: string }>> {
  if (body === null || typeof body !== "object" || !("dataset" in body)) {
    return {
      ok: false,
      error: {
        code: "VALIDATION_FAILED",
        message: "Request body must be { dataset: string }",
        details: { path: "dataset" },
      },
    };
  }
  return datasetCreate(config, { dataset: String((body as { dataset: unknown }).dataset) });
}

export async function handleDatasetsList(
  config: DatasetsEndpointsConfig,
  _body: unknown
): Promise<ContentfnEnvelope<{ datasets: string[] }>> {
  return datasetList(config, {});
}

export async function handleDatasetsDelete(
  config: DatasetsEndpointsConfig,
  body: unknown
): Promise<ContentfnEnvelope<Record<string, never>>> {
  if (body === null || typeof body !== "object" || !("dataset" in body)) {
    return {
      ok: false,
      error: {
        code: "VALIDATION_FAILED",
        message: "Request body must be { dataset: string }",
        details: { path: "dataset" },
      },
    };
  }
  return datasetDelete(config, { dataset: String((body as { dataset: unknown }).dataset) });
}

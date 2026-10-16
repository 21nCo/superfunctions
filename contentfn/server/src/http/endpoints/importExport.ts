import type { ContentfnEnvelope } from "@contentfn/core";
import { err } from "@contentfn/core";
import { exportDataset, type ExportConfig } from "../../importExport/exportDataset.js";
import { importDataset, type ImportConfig } from "../../importExport/importDataset.js";
import type { ContentfnExportArtifact } from "../../importExport/format.js";

export interface ImportExportEndpointsConfig extends ExportConfig, ImportConfig {}

export async function handleDatasetsExport(
  config: ImportExportEndpointsConfig,
  body: unknown
): Promise<ContentfnEnvelope<{ artifact: ContentfnExportArtifact }>> {
  if (body === null || typeof body !== "object") {
    return err("VALIDATION_FAILED", "Request body must be an object", { path: "body" });
  }

  const b = body as Record<string, unknown>;
  if (typeof b.dataset !== "string") {
    return err("VALIDATION_FAILED", "dataset is required", { path: "dataset" });
  }

  return exportDataset(config, { dataset: b.dataset });
}

export async function handleDatasetsImport(
  config: ImportExportEndpointsConfig,
  body: unknown
): Promise<ContentfnEnvelope<Record<string, never>>> {
  if (body === null || typeof body !== "object") {
    return err("VALIDATION_FAILED", "Request body must be an object", { path: "body" });
  }

  const b = body as Record<string, unknown>;
  if (typeof b.dataset !== "string") {
    return err("VALIDATION_FAILED", "dataset is required", { path: "dataset" });
  }
  if (b.artifact === undefined || b.artifact === null) {
    return err("VALIDATION_FAILED", "artifact is required", { path: "artifact" });
  }

  return importDataset(config, { dataset: b.dataset, artifact: b.artifact });
}

/**
 * HTTP handlers for asset upload and get.
 */

import type { ContentfnEnvelope } from "@contentfn/core";
import { err } from "@contentfn/core";
import { assetUpload, assetGet, assetList } from "../../storage/assets.js";
import type { AssetsStorageConfig } from "../../storage/assets.js";

export interface AssetsEndpointsConfig extends AssetsStorageConfig {}

export async function handleAssetsUpload(
  config: AssetsEndpointsConfig,
  body: unknown
): Promise<ContentfnEnvelope<{ assetId: string; url: string }>> {
  if (body === null || typeof body !== "object") {
    return err("VALIDATION_FAILED", "Request body must be an object", { path: "body" });
  }

  const b = body as Record<string, unknown>;
  if (
    typeof b.dataset !== "string" ||
    typeof b.filename !== "string" ||
    typeof b.contentType !== "string" ||
    typeof b.bytesBase64 !== "string"
  ) {
    return err("VALIDATION_FAILED", "Request body must include dataset, filename, contentType, and bytesBase64 as strings", {
      path: "body",
    });
  }

  return assetUpload(config, {
    dataset: b.dataset,
    filename: b.filename,
    contentType: b.contentType,
    bytesBase64: b.bytesBase64,
  });
}

export async function handleAssetsGet(
  config: AssetsEndpointsConfig,
  body: unknown
): Promise<ContentfnEnvelope<{ assetId: string; url: string; metadata: Record<string, unknown> }>> {
  if (body === null || typeof body !== "object") {
    return err("VALIDATION_FAILED", "Request body must be an object", { path: "body" });
  }

  const b = body as Record<string, unknown>;
  if (typeof b.dataset !== "string" || typeof b.assetId !== "string") {
    return err("VALIDATION_FAILED", "Request body must include dataset and assetId as strings", { path: "dataset" });
  }

  return assetGet(config, {
    dataset: b.dataset,
    assetId: b.assetId,
  });
}

export async function handleAssetsList(
  config: AssetsEndpointsConfig,
  body: unknown
): Promise<ContentfnEnvelope<{ assets: Array<{ assetId: string; url: string; filename: string; contentType: string; size: number; createdAt: string }> }>> {
  if (body === null || typeof body !== "object") {
    return err("VALIDATION_FAILED", "Request body must be an object", { path: "body" });
  }

  const b = body as Record<string, unknown>;
  if (typeof b.dataset !== "string") {
    return err("VALIDATION_FAILED", "Request body must include dataset as string", { path: "dataset" });
  }

  return assetList(config, {
    dataset: b.dataset,
    limit: typeof b.limit === "number" ? b.limit : undefined,
    offset: typeof b.offset === "number" ? b.offset : undefined,
  });
}

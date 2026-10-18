import { documentStorageId } from "./documentIdentity.js";
/**
 * Asset storage: upload and get with metadata persistence.
 * Implements ASSET-001.
 */

import type { ContentfnDatabase as Adapter } from "./database.js";
import type { ContentfnEnvelope } from "@contentfn/core";
import { ok, err, DEFAULT_MAX_PAYLOAD_BYTES } from "@contentfn/core";
import { nowISO } from "../time/clock.js";
import { CONTENTFN_TABLE_NAMES } from "./schema.js";
import { datasetExists } from "./datasets.js";
import type { AssetStorageBackend } from "./storageBackend.js";
import { InMemoryStorageBackend } from "./storageBackend.js";
import { atomicMutation } from "./database.js";
import { appendEvent } from "./events.js";
import { probeImageDimensions } from "../assets/metadata.js";

export interface AssetsStorageConfig {
  db: Adapter;
  storage?: AssetStorageBackend;
  maxPayloadBytes?: number;
  actor?: { subject: string };
}

/**
 * Upload an asset.
 * - Validates base64 input
 * - Enforces maxPayloadBytes limit
 * - Writes bytes to storage backend
 * - Computes metadata (size, width/height for images)
 * - Persists asset record
 * - Returns assetId and url
 */
export async function assetUpload(
  config: AssetsStorageConfig,
  input: {
    dataset: string;
    filename: string;
    contentType: string;
    bytesBase64: string;
  }
): Promise<ContentfnEnvelope<{ assetId: string; url: string }>> {
  if ("transaction" in config.db) return atomicMutation(config.db, db => assetUpload({ ...config, db }, input));
  const exists = await datasetExists({ db: config.db }, input.dataset);
  if (!exists) {
    return err("DATASET_NOT_FOUND", "Dataset not found", { dataset: input.dataset });
  }

  if (typeof input.bytesBase64 !== "string" || input.bytesBase64.length === 0) {
    return err("VALIDATION_FAILED", "bytesBase64 must be a non-empty string", { path: "bytesBase64" });
  }

  const base64Regex = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
  if (!base64Regex.test(input.bytesBase64)) {
    return err("VALIDATION_FAILED", "Invalid base64 encoding", { path: "bytesBase64" });
  }

  let bytes: Buffer;
  try {
    bytes = Buffer.from(input.bytesBase64, "base64");
    if (bytes.length === 0 && input.bytesBase64.length > 0) {
      return err("VALIDATION_FAILED", "Invalid base64 encoding", { path: "bytesBase64" });
    }
  } catch {
    return err("VALIDATION_FAILED", "Invalid base64 encoding", { path: "bytesBase64" });
  }

  const maxPayload = config.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES;
  if (bytes.length > maxPayload) {
    return err("PAYLOAD_TOO_LARGE", `Asset size ${bytes.length} exceeds limit ${maxPayload}`, {
      size: bytes.length,
      limit: maxPayload,
    });
  }

  const storage = config.storage ?? new InMemoryStorageBackend();

  let url: string;
  try {
    url = await storage.writeAsset(bytes, input.filename, input.contentType);
  } catch {
    return err("ASSET_UPLOAD_FAILED", "Failed to write asset to storage", {});
  }

  const assetId = `asset_${Date.now()}_${Math.random().toString(36).substring(2, 10)}`;
  const now = nowISO();

  const metadata: Record<string, unknown> = {
    contentType: input.contentType,
    filename: input.filename,
    size: bytes.length,
  };

  const imageDims = probeImageDimensions(bytes, input.contentType);
  if (imageDims) {
    metadata.width = imageDims.width;
    metadata.height = imageDims.height;
  }

  await config.db.create({
    model: CONTENTFN_TABLE_NAMES.assets,
    data: {
      id: documentStorageId(input.dataset, assetId),
      dataset: input.dataset,
      assetId,
      contentType: input.contentType,
      filename: input.filename,
      size: bytes.length,
      width: imageDims?.width ?? null,
      height: imageDims?.height ?? null,
      url,
      createdAt: now,
    },
  });

  await appendEvent(config, { dataset: input.dataset, type: "asset.created", docId: assetId });
  return ok({ assetId, url });
}

/**
 * Get an asset.
 * Returns metadata + url.
 * Returns ASSET_NOT_FOUND if asset does not exist.
 */
export async function assetGet(
  config: AssetsStorageConfig,
  input: {
    dataset: string;
    assetId: string;
  }
): Promise<ContentfnEnvelope<{ assetId: string; url: string; metadata: Record<string, unknown> }>> {
  const exists = await datasetExists({ db: config.db }, input.dataset);
  if (!exists) {
    return err("DATASET_NOT_FOUND", "Dataset not found", { dataset: input.dataset });
  }

  const row = await config.db.findOne({
    model: CONTENTFN_TABLE_NAMES.assets,
    where: [
      { field: "dataset", operator: "eq" as const, value: input.dataset },
      { field: "assetId", operator: "eq" as const, value: input.assetId },
    ],
  });

  if (!row) {
    return err("ASSET_NOT_FOUND", "Asset not found", { assetId: input.assetId });
  }

  const asset = row as {
    assetId: string;
    url: string;
    contentType: string;
    filename: string;
    size: number;
    width: number | null;
    height: number | null;
    createdAt: string;
  };

  const metadata: Record<string, unknown> = {
    contentType: asset.contentType,
    filename: asset.filename,
    size: asset.size,
    createdAt: asset.createdAt,
  };

  if (asset.width !== null && asset.height !== null) {
    metadata.width = asset.width;
    metadata.height = asset.height;
  }

  return ok({
    assetId: asset.assetId,
    url: asset.url,
    metadata,
  });
}

export interface AssetListItem {
  assetId: string;
  url: string;
  filename: string;
  contentType: string;
  size: number;
  createdAt: string;
}

/**
 * List assets for a dataset. Deterministic order: createdAt desc, then assetId asc.
 */
export async function assetList(
  config: AssetsStorageConfig,
  input: {
    dataset: string;
    limit?: number;
    offset?: number;
  }
): Promise<ContentfnEnvelope<{ assets: AssetListItem[] }>> {
  const exists = await datasetExists({ db: config.db }, input.dataset);
  if (!exists) {
    return err("DATASET_NOT_FOUND", "Dataset not found", { dataset: input.dataset });
  }

  const limit = Math.min(input.limit ?? 50, 100);
  const offset = input.offset ?? 0;

  const rows = await config.db.findMany({
    model: CONTENTFN_TABLE_NAMES.assets,
    where: [{ field: "dataset", operator: "eq" as const, value: input.dataset }],
    orderBy: [
      { field: "createdAt", direction: "desc" },
      { field: "assetId", direction: "asc" },
    ],
    limit,
    offset,
  });

  const assets: AssetListItem[] = (rows as Array<{
    assetId: string;
    url: string;
    filename: string;
    contentType: string;
    size: number;
    createdAt: string;
  }>).map((r) => ({
    assetId: r.assetId,
    url: r.url,
    filename: r.filename,
    contentType: r.contentType,
    size: r.size,
    createdAt: r.createdAt,
  }));

  return ok({ assets });
}

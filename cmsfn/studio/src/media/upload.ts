/**
 * Asset upload with client-side size pre-check vs maxUploadBytes.
 */

import { uploadAsset } from "../contentfn/client.js";
import type { ContentfnClientConfig } from "../contentfn/client.js";

export interface UploadAssetConfig extends ContentfnClientConfig {
  /** Max size in bytes; when exceeded, reject without calling ContentFn (PAYLOAD_TOO_LARGE). */
  maxUploadBytes?: number;
}

export interface UploadAssetInput {
  dataset: string;
  filename: string;
  contentType: string;
  /** File bytes as base64. */
  bytesBase64: string;
}

export type UploadAssetResult =
  | { ok: true; assetId: string; url: string }
  | { ok: false; code: string; message: string; details?: Record<string, unknown> };

/**
 * Upload asset. Pre-checks size against maxUploadBytes; then calls ContentFn assets.upload.
 */
export async function uploadAssetWithLimit(
  config: UploadAssetConfig,
  input: UploadAssetInput
): Promise<UploadAssetResult> {
  const bytesLength = typeof input.bytesBase64 === "string"
    ? Math.floor((input.bytesBase64.length * 3) / 4)
    : 0;
  const limit = config.maxUploadBytes;
  if (limit != null && bytesLength > limit) {
    return {
      ok: false,
      code: "PAYLOAD_TOO_LARGE",
      message: `Upload size ${bytesLength} exceeds limit ${limit}`,
      details: { size: bytesLength, limit },
    };
  }

  const envelope = await uploadAsset(config, {
    dataset: input.dataset,
    filename: input.filename,
    contentType: input.contentType,
    bytesBase64: input.bytesBase64,
  });

  if (envelope.ok) {
    return { ok: true, assetId: envelope.result.assetId, url: envelope.result.url };
  }
  return {
    ok: false,
    code: envelope.error.code,
    message: envelope.error.message,
    details: envelope.error.details,
  };
}

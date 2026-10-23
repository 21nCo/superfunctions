/**
 * Asset upload with client-side size pre-check vs maxUploadBytes.
 */

import { uploadAsset } from "../contentfn/client.js";
import type { ContentfnClientConfig } from "../contentfn/client.js";

export const DEFAULT_MAX_UPLOAD_BYTES = 1_048_576;
export function uploadLimit(value?: number): number | null { return value === undefined ? DEFAULT_MAX_UPLOAD_BYTES : Number.isSafeInteger(value) && value > 0 ? value : null; }

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
  const limit = uploadLimit(config.maxUploadBytes);
  if (limit === null || !input.filename || input.filename.length > 1024 || !input.contentType || input.contentType.length > 255 || !/^[\w!#$&^.+-]+\/[\w!#$&^.+-]+$/.test(input.contentType)) return { ok: false, code: 'VALIDATION_FAILED', message: 'Invalid upload configuration or file metadata.' };
  const encoded = input.bytesBase64;
  if (typeof encoded !== 'string' || !encoded.length || encoded.length > Math.ceil(limit / 3) * 4) return { ok: false, code: 'PAYLOAD_TOO_LARGE', message: 'File exceeds the upload limit.', details: { limit } };
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) return { ok: false, code: 'VALIDATION_FAILED', message: 'Invalid file encoding.' };
  const bytesLength = encoded.length / 4 * 3 - (encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0);
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

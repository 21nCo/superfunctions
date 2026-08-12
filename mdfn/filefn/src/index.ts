import type { AssetMetadata } from "@mdfn/core";

export interface AssetUpload {
  readonly id?: string;
  readonly documentId: string;
  readonly name: string;
  readonly mediaType: string;
  readonly bytes: Uint8Array;
}

export interface StoredAsset extends AssetMetadata {
  readonly documentId: string;
  readonly url: string;
  readonly createdAt: string;
}

export interface MdfnAssetProvider {
  put(input: AssetUpload): Promise<StoredAsset>;
  get(id: string): Promise<StoredAsset | null>;
  read(id: string): Promise<Uint8Array | null>;
  list(documentId: string): Promise<readonly StoredAsset[]>;
  delete(id: string): Promise<boolean>;
}

export function createMemoryAssetProvider(options: { readonly baseUrl?: string; readonly createId?: () => string; readonly maxBytes?: number; readonly allowedMediaTypes?: readonly string[] } = {}): MdfnAssetProvider {
  const assets = new Map<string, { metadata: StoredAsset; bytes: Uint8Array }>();
  const createId = options.createId ?? (() => crypto.randomUUID());
  const baseUrl = (options.baseUrl ?? "/api/mdfn/assets").replace(/\/$/, "");
  return {
    async put(input) {
      if (!input.documentId || !input.name || !input.mediaType) throw new Error("MDFN_ASSET_METADATA_REQUIRED");
      if (input.bytes.byteLength > (options.maxBytes ?? 25 * 1024 * 1024)) throw new RangeError("MDFN_ASSET_TOO_LARGE");
      if (options.allowedMediaTypes && !options.allowedMediaTypes.includes(input.mediaType)) throw new Error("MDFN_ASSET_MEDIA_TYPE_FORBIDDEN");
      const id = input.id ?? createId();
      if (assets.has(id)) throw new Error(`MDFN_ASSET_EXISTS:${id}`);
      const metadata: StoredAsset = Object.freeze({ id, documentId: input.documentId, name: input.name, mediaType: input.mediaType, byteSize: input.bytes.byteLength, url: `${baseUrl}/${encodeURIComponent(id)}`, createdAt: new Date().toISOString() });
      assets.set(id, { metadata, bytes: input.bytes.slice() });
      return metadata;
    },
    async get(id) { return assets.get(id)?.metadata ?? null; },
    async read(id) { return assets.get(id)?.bytes.slice() ?? null; },
    async list(documentId) { return [...assets.values()].map((entry) => entry.metadata).filter((entry) => entry.documentId === documentId); },
    async delete(id) { return assets.delete(id); },
  };
}

export const MDFN_FILEFN_VERSION = "0.1.0" as const;

/**
 * Storage backend interface for assets.
 * Integrates with configured storage (e.g., local filesystem, S3, etc.)
 */

export interface AssetStorageBackend {
  /**
   * Write bytes to storage and return a stable URL.
   * @param bytes - Raw bytes as Buffer
   * @param filename - Original filename
   * @param contentType - MIME type
   * @returns Stable URL to access the asset
   */
  writeAsset(bytes: Buffer, filename: string, contentType: string): Promise<string>;
}

/**
 * Default in-memory storage backend (for testing/development).
 * In production, use a real storage backend (e.g., S3, GCS, local FS).
 */
export class InMemoryStorageBackend implements AssetStorageBackend {
  private assets: Map<string, { bytes: Buffer; contentType: string }> = new Map();

  async writeAsset(bytes: Buffer, filename: string, contentType: string): Promise<string> {
    const assetId = `asset_${Date.now()}_${Math.random().toString(36).substring(2, 10)}`;
    this.assets.set(assetId, { bytes, contentType });
    return `memory://${assetId}`;
  }

  getAsset(assetId: string): { bytes: Buffer; contentType: string } | undefined {
    return this.assets.get(assetId);
  }
}

/** Compose the shared storage abstraction without duplicating a storage driver. */
export function createAssetStorageBackend(
  adapter: import("@superfunctions/storage").StorageAdapter,
  options: { target?: string; prefix?: string; urlForKey: (key: string) => string | Promise<string> },
): AssetStorageBackend {
  if (!adapter.openUploadStream) throw new TypeError("Asset storage requires a streaming upload adapter");
  const prefix = options.prefix ?? "contentfn/assets";
  if (prefix.split("/").some(segment => segment === ".." || segment === "." || !segment) || prefix.includes("\\")) throw new TypeError("Invalid asset key prefix");
  return {
    async writeAsset(bytes, _filename, contentType) {
      const key = `${prefix}/${globalThis.crypto.randomUUID()}`;
      const stream = await adapter.openUploadStream!({ key, target: options.target, contentType });
      const writer = stream.getWriter();
      try {
        await writer.write(new Uint8Array(bytes));
        await writer.close();
        return await options.urlForKey(key);
      } catch (error) {
        await writer.abort(error).catch(() => undefined);
        await adapter.deleteObject({ key, target: options.target }).catch(() => undefined);
        throw error;
      } finally { writer.releaseLock(); }
    },
  };
}

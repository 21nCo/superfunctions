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

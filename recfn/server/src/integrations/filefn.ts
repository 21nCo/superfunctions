export interface StorageAdapter {
  upload(key: string, data: Uint8Array, options?: UploadOptions): Promise<void>;
  download(key: string): Promise<Uint8Array>;
  signedUrl(key: string, expiresIn?: number): Promise<string>;
  delete(key: string): Promise<void>;
}

export interface UploadOptions {
  contentType?: string;
  encryption?: boolean;
}

export const DEFAULT_SIGNED_URL_EXPIRY = 3600;

export class MemoryStorageAdapter implements StorageAdapter {
  private files = new Map<string, { data: Uint8Array; contentType?: string; encrypted: boolean }>();

  async upload(key: string, data: Uint8Array, options?: UploadOptions): Promise<void> {
    this.files.set(key, {
      data,
      contentType: options?.contentType,
      encrypted: options?.encryption !== false,
    });
  }

  async download(key: string): Promise<Uint8Array> {
    const file = this.files.get(key);
    if (!file) throw new Error(`File not found: ${key}`);
    return file.data;
  }

  async signedUrl(key: string, expiresIn?: number): Promise<string> {
    if (!this.files.has(key)) throw new Error(`File not found: ${key}`);
    const expiry = expiresIn ?? DEFAULT_SIGNED_URL_EXPIRY;
    const expiresAt = Date.now() + expiry * 1000;
    return `https://storage.example.com/${key}?token=signed&expires=${expiresAt}`;
  }

  async delete(key: string): Promise<void> {
    this.files.delete(key);
  }

  has(key: string): boolean {
    return this.files.has(key);
  }

  isEncrypted(key: string): boolean {
    const file = this.files.get(key);
    return file?.encrypted ?? false;
  }
}

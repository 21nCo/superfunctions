import { randomUUID } from 'node:crypto';

export interface FileEntry {
  fileId: string;
  namespace: string;
  key: string;
  data: Buffer;
  createdAt: string;
}

export interface FileFnClient {
  upload(namespace: string, key: string, data: Buffer): Promise<string>;
  download(fileId: string): Promise<Buffer | null>;
  downloadByKey(namespace: string, key: string): Promise<Buffer | null>;
  getFileId(namespace: string, key: string): string | null;
  list(namespace: string): FileEntry[];
}

export class MemoryFileFnClient implements FileFnClient {
  private files = new Map<string, FileEntry>();
  private keyIndex = new Map<string, string>();

  async upload(namespace: string, key: string, data: Buffer): Promise<string> {
    const fileId = randomUUID();
    const compositeKey = `${namespace}:${key}`;
    const entry: FileEntry = {
      fileId,
      namespace,
      key,
      data,
      createdAt: new Date().toISOString(),
    };
    this.files.set(fileId, entry);
    this.keyIndex.set(compositeKey, fileId);
    return fileId;
  }

  async download(fileId: string): Promise<Buffer | null> {
    const entry = this.files.get(fileId);
    return entry?.data ?? null;
  }

  async downloadByKey(namespace: string, key: string): Promise<Buffer | null> {
    const compositeKey = `${namespace}:${key}`;
    const fileId = this.keyIndex.get(compositeKey);
    if (!fileId) return null;
    return this.download(fileId);
  }

  getFileId(namespace: string, key: string): string | null {
    const compositeKey = `${namespace}:${key}`;
    return this.keyIndex.get(compositeKey) ?? null;
  }

  list(namespace: string): FileEntry[] {
    return Array.from(this.files.values()).filter(f => f.namespace === namespace);
  }
}

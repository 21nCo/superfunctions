import { randomUUID } from 'node:crypto';
import type { ArtifactsAdapter } from './types.js';
import type { AdapterConfig } from './config.js';

interface FileEntry {
  fileId: string;
  namespace: string;
  key: string;
  data: Buffer;
  createdAt: string;
}

export class MemoryArtifactsAdapter implements ArtifactsAdapter {
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

  list(namespace: string): Array<{ fileId: string; namespace: string; key: string; createdAt: string }> {
    return Array.from(this.files.values())
      .filter(f => f.namespace === namespace)
      .map(f => ({ fileId: f.fileId, namespace: f.namespace, key: f.key, createdAt: f.createdAt }));
  }

  async getSignedUrl(fileId: string, expiresIn?: number): Promise<string | null> {
    const entry = this.files.get(fileId);
    if (!entry) return null;
    return `memory://file/${fileId}`;
  }
}

export class FileFnArtifactsAdapter implements ArtifactsAdapter {
  constructor(private config: { baseUrl: string; apiKey?: string }) {}

  async upload(namespace: string, key: string, data: Buffer): Promise<string> {
    const formData = new FormData();
    formData.append('file', new Blob([new Uint8Array(data)]));
    formData.append('namespace', namespace);
    formData.append('key', key);

    const headers: Record<string, string> = {};
    if (this.config.apiKey) {
      headers['Authorization'] = `Bearer ${this.config.apiKey}`;
    }

    const response = await fetch(`${this.config.baseUrl}/upload`, {
      method: 'POST',
      headers,
      body: formData,
    });

    if (!response.ok) {
      throw new Error(`FileFn upload failed: ${response.status} ${response.statusText}`);
    }

    const result = await response.json() as { fileId: string };
    return result.fileId;
  }

  async download(fileId: string): Promise<Buffer | null> {
    const headers: Record<string, string> = {};
    if (this.config.apiKey) {
      headers['Authorization'] = `Bearer ${this.config.apiKey}`;
    }

    const response = await fetch(`${this.config.baseUrl}/files/${fileId}`, {
      headers,
    });

    if (response.status === 404) {
      return null;
    }

    if (!response.ok) {
      throw new Error(`FileFn download failed: ${response.status} ${response.statusText}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }

  async downloadByKey(namespace: string, key: string): Promise<Buffer | null> {
    const fileId = this.getFileId(namespace, key);
    if (!fileId) return null;
    return this.download(fileId);
  }

  getFileId(namespace: string, key: string): string | null {
    return null;
  }

  list(namespace: string): Array<{ fileId: string; namespace: string; key: string; createdAt: string }> {
    return [];
  }

  async getSignedUrl(fileId: string, expiresIn: number = 3600): Promise<string | null> {
    const headers: Record<string, string> = {};
    if (this.config.apiKey) {
      headers['Authorization'] = `Bearer ${this.config.apiKey}`;
    }

    const response = await fetch(`${this.config.baseUrl}/files/${fileId}/sign?expiresIn=${expiresIn}`, {
      headers,
    });

    if (response.status === 404) {
      return null;
    }

    if (!response.ok) {
      throw new Error(`FileFn getSignedUrl failed: ${response.status} ${response.statusText}`);
    }

    const result = await response.json() as { url?: string };
    return result.url ?? null;
  }
}

export function createArtifactsAdapter(config: AdapterConfig['artifacts']): ArtifactsAdapter {
  if (config.type === 'memory') {
    return new MemoryArtifactsAdapter();
  }

  if (!config.filefnBaseUrl) {
    throw new Error('FileFn adapter requires baseUrl');
  }

  return new FileFnArtifactsAdapter({
    baseUrl: config.filefnBaseUrl,
    apiKey: config.filefnApiKey,
  });
}

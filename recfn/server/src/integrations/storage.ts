import { getStorageCapabilities, type StorageAdapter as SharedStorageAdapter } from '@superfunctions/storage';

export type StorageAdapter = SharedStorageAdapter;

export interface StreamingUploadData {
  size: number;
  openStream(): ReadableStream<Uint8Array>;
}

export interface UploadOptions {
  contentType?: string;
  encryption?: boolean;
  target?: string;
}

export interface DownloadUrlOptions {
  expiresIn?: number;
  proxyUrl?: string;
  target?: string;
  responseContentType?: string;
}

export const DEFAULT_SIGNED_URL_EXPIRY = 3600;

async function writeStream(
  writable: WritableStream<Uint8Array>,
  data: Uint8Array,
): Promise<void> {
  const writer = writable.getWriter();
  try {
    await writer.write(data);
    await writer.close();
  } catch (error) {
    // Never replace the storage failure with an abort/close state error.
    try { await writer.abort(error); } catch { /* Preserve the original failure. */ }
    throw error;
  } finally {
    writer.releaseLock();
  }
}

export async function uploadObject(
  storage: StorageAdapter,
  key: string,
  data: Uint8Array | StreamingUploadData,
  options?: UploadOptions,
): Promise<void> {
  if (storage.openUploadStream) {
    const writable = await storage.openUploadStream({
      key,
      target: options?.target,
      contentType: options?.contentType,
    });
    if (data instanceof Uint8Array) await writeStream(writable, data);
    else await data.openStream().pipeTo(writable);
    return;
  }

  if (storage.signUploadUrl) {
    const signed = await storage.signUploadUrl({
      key,
      target: options?.target,
      expiresInSeconds: 300,
      constraints: {
        contentType: options?.contentType,
        contentLength: data instanceof Uint8Array ? data.byteLength : data.size,
      },
    });
    const response = await fetch(signed.url, {
      method: 'PUT',
      headers: {
        ...(signed.headers ?? {}),
        ...(options?.contentType ? { 'Content-Type': options.contentType } : {}),
      },
      body: (data instanceof Uint8Array ? data : data.openStream()) as RequestInit['body'],
      duplex: 'half',
    } as RequestInit & { duplex: 'half' });
    if (!response.ok) {
      throw new Error(
        `Storage upload failed with status ${response.status} for ${key}.`,
      );
    }
    return;
  }

  throw new Error('Storage adapter does not support server-side uploads.');
}

export async function createDownloadUrl(
  storage: StorageAdapter,
  key: string,
  options?: DownloadUrlOptions,
): Promise<string> {
  const capabilities = getStorageCapabilities(storage, options?.target);
  if (capabilities.signedDownloadUrls && storage.signDownloadUrl) {
    const signed = await storage.signDownloadUrl({
      key,
      target: options?.target,
      expiresInSeconds: options?.expiresIn ?? DEFAULT_SIGNED_URL_EXPIRY,
      constraints: options?.responseContentType
        ? { responseContentType: options.responseContentType }
        : undefined,
    });
    return signed.url;
  }

  if (capabilities.proxyStreamingDownload && options?.proxyUrl) {
    return options.proxyUrl;
  }

  throw new Error(`Storage adapter cannot produce a download URL for ${key}.`);
}

export async function createDownloadResponse(
  storage: StorageAdapter,
  key: string,
  options?: {
    target?: string;
    contentType?: string;
  },
): Promise<Response> {
  if (!storage.openDownloadStream) {
    throw new Error(`Storage adapter cannot proxy downloads for ${key}.`);
  }

  const stream = await storage.openDownloadStream({
    key,
    target: options?.target,
  });
  return new Response(stream, {
    status: 200,
    headers: {
      'Content-Type': options?.contentType ?? 'application/octet-stream',
    },
  });
}

export function assertProductionStorage(
  storage: StorageAdapter | undefined,
): asserts storage is StorageAdapter {
  if (!storage) {
    throw new Error(
      'RecFn production server requires an @superfunctions/storage adapter.',
    );
  }

  const capabilities = getStorageCapabilities(storage);
  const supportsUpload = capabilities.proxyStreamingUpload || typeof storage.signUploadUrl === 'function';
  const supportsDownload =
    capabilities.proxyStreamingDownload ||
    capabilities.signedDownloadUrls ||
    typeof storage.signDownloadUrl === 'function';

  if (!supportsUpload || !supportsDownload) {
    throw new Error(
      'RecFn production storage must support upload and download via @superfunctions/storage capabilities.',
    );
  }
}

type StoredObject = {
  data: Uint8Array;
  contentType?: string;
  encrypted: boolean;
  updatedAt: string;
};

export class MemoryStorageAdapter implements StorageAdapter {
  readonly name = 'recfn-memory';
  readonly capabilities = {
    signedUploadUrls: false,
    signedDownloadUrls: true,
    multipart: false,
    proxyStreamingUpload: true,
    proxyStreamingDownload: true,
  } as const;

  private readonly files = new Map<string, StoredObject>();

  async statObject(input: { key: string; target?: string }): Promise<{
    key: string;
    size: number;
    contentType?: string;
    lastModifiedAt?: string;
  }> {
    const file = this.files.get(input.key);
    if (!file) {
      throw new Error(`File not found: ${input.key}`);
    }
    return {
      key: input.key,
      size: file.data.byteLength,
      contentType: file.contentType,
      lastModifiedAt: file.updatedAt,
    };
  }

  async deleteObject(input: { key: string; target?: string }): Promise<void> {
    this.files.delete(input.key);
  }

  async signDownloadUrl(input: {
    key: string;
    expiresInSeconds: number;
    target?: string;
    constraints?: { responseContentType?: string };
  }): Promise<{ url: string }> {
    if (!this.files.has(input.key)) {
      throw new Error(`File not found: ${input.key}`);
    }
    const expiresAt = Date.now() + input.expiresInSeconds * 1000;
    return {
      url: `https://storage.example.com/${input.key}?token=signed&expires=${expiresAt}`,
    };
  }

  async openUploadStream(input: {
    key: string;
    contentType?: string;
    target?: string;
  }): Promise<WritableStream<Uint8Array>> {
    const chunks: Uint8Array[] = [];
    return new WritableStream<Uint8Array>({
      write: async (chunk: Uint8Array | ArrayBuffer | ArrayBufferView) => {
        if (chunk instanceof Uint8Array) {
          chunks.push(chunk);
          return;
        }
        if (ArrayBuffer.isView(chunk)) {
          chunks.push(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
          return;
        }
        if (chunk instanceof ArrayBuffer) {
          chunks.push(new Uint8Array(chunk));
          return;
        }
        throw new Error('Unsupported upload chunk type.');
      },
      close: async () => {
        const size = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
        const buffer = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) {
          buffer.set(chunk, offset);
          offset += chunk.byteLength;
        }
        this.files.set(input.key, {
          data: buffer,
          contentType: input.contentType,
          encrypted: true,
          updatedAt: new Date().toISOString(),
        });
      },
    });
  }

  async openDownloadStream(input: {
    key: string;
    target?: string;
    range?: { start: number; endInclusive: number };
  }): Promise<ReadableStream<Uint8Array>> {
    const file = this.files.get(input.key);
    if (!file) {
      throw new Error(`File not found: ${input.key}`);
    }
    return new ReadableStream<Uint8Array>({
      start(controller: ReadableStreamDefaultController<Uint8Array>) {
        controller.enqueue(file.data);
        controller.close();
      },
    });
  }

  async upload(key: string, data: Uint8Array, options?: UploadOptions): Promise<void> {
    await uploadObject(this, key, data, options);
  }

  async download(key: string): Promise<Uint8Array> {
    const file = this.files.get(key);
    if (!file) {
      throw new Error(`File not found: ${key}`);
    }
    return file.data;
  }

  async signedUrl(key: string, expiresIn?: number): Promise<string> {
    return createDownloadUrl(this, key, { expiresIn });
  }

  async delete(key: string): Promise<void> {
    await this.deleteObject({ key });
  }

  has(key: string): boolean {
    return this.files.has(key);
  }

  isEncrypted(key: string): boolean {
    return this.files.get(key)?.encrypted ?? false;
  }
}

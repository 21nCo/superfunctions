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
  /** Total upload operation deadline, including adapter acquisition. Default: five minutes. */
  uploadTimeoutMs?: number;
  signal?: AbortSignal;
}

export interface DownloadUrlOptions {
  expiresIn?: number;
  proxyUrl?: string;
  target?: string;
  responseContentType?: string;
}

export const DEFAULT_SIGNED_URL_EXPIRY = 3600;

export const DEFAULT_UPLOAD_TIMEOUT_MS = 300_000;

/** Adapter promises have no signal contract; abort requests are best effort, not rollback. */
export async function uploadObject(
  storage: StorageAdapter,
  key: string,
  data: Uint8Array | StreamingUploadData,
  options?: UploadOptions,
): Promise<void> {
  const timeout = options?.uploadTimeoutMs ?? DEFAULT_UPLOAD_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeout) || timeout <= 0 || timeout > 2_147_483_647) throw new TypeError('uploadTimeoutMs must be a positive finite timer duration');
  const controller = new AbortController();
  const abort = () => controller.abort(options?.signal?.reason ?? new Error('Storage upload cancelled'));
  options?.signal?.addEventListener('abort', abort, { once: true });
  if (options?.signal?.aborted) abort();
  const timer = setTimeout(() => controller.abort(new Error(`Storage upload timed out after ${timeout}ms`)), timeout);
  const signal = controller.signal;
  // Each wait removes its listener; a long upload must not accumulate pending races.
  const wait = <T>(operation: Promise<T>): Promise<T> => new Promise((resolve, reject) => {
    const cancelled = () => { signal.removeEventListener('abort', cancelled); reject(signal.reason); };
    if (signal.aborted) { operation.catch(() => {}); reject(signal.reason); return; }
    signal.addEventListener('abort', cancelled, { once: true });
    operation.then(value => { signal.removeEventListener('abort', cancelled); resolve(value); }, error => { signal.removeEventListener('abort', cancelled); reject(error); });
  });
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let writer: WritableStreamDefaultWriter<Uint8Array> | undefined;
  try {
    signal.throwIfAborted();
    if (storage.openUploadStream) {
      const acquisition = storage.openUploadStream({ key, target: options?.target, contentType: options?.contentType });
      // A timed-out acquisition can resolve later; it must never start writing data.
      void acquisition.then(writable => { if (signal.aborted) void writable.abort(signal.reason).catch(() => {}); }, () => {});
      const writable = await wait(acquisition);
      signal.throwIfAborted();
      writer = writable.getWriter();
      if (data instanceof Uint8Array) await wait(writer.write(data));
      else {
        reader = data.openStream().getReader();
        while (true) {
          const chunk = await wait(reader.read());
          if (chunk.done) break;
          signal.throwIfAborted();
          await wait(writer.write(chunk.value));
        }
      }
      signal.throwIfAborted();
      await wait(writer.close());
      return;
    }
    if (storage.signUploadUrl) {
      const signed = await wait(storage.signUploadUrl({ key, target: options?.target, expiresInSeconds: 300,
        constraints: { contentType: options?.contentType, contentLength: data instanceof Uint8Array ? data.byteLength : data.size } }));
      signal.throwIfAborted();
      let body: Uint8Array | ReadableStream<Uint8Array>;
      if (data instanceof Uint8Array) body = data;
      else {
        reader = data.openStream().getReader();
        const source = reader;
        body = new ReadableStream<Uint8Array>({
          async pull(c) { try { const chunk = await source.read(); if (chunk.done) c.close(); else c.enqueue(chunk.value); } catch (error) { c.error(error); } },
          cancel: reason => source.cancel(reason),
        });
      }
      const response = await wait(fetch(signed.url, {
        method: 'PUT', signal,
        headers: { ...(signed.headers ?? {}), ...(options?.contentType ? { 'Content-Type': options.contentType } : {}) },
        body: body as RequestInit['body'], duplex: 'half',
      } as RequestInit & { duplex: 'half' }));
      // The object is determined by status; never retain an unbounded response body.
      if (response.body) await wait(response.body.cancel());
      if (!response.ok) throw new Error(`Storage upload failed with status ${response.status} for ${key}.`);
      return;
    }
    throw new Error('Storage adapter does not support server-side uploads.');
  } catch (error) {
    controller.abort(error);
    // Web Streams defer sink abort behind an outstanding write. Do not claim that
    // an uncooperative adapter has stopped, or hold the local artifact indefinitely.
    if (writer) void writer.abort(error).catch(() => {});
    throw error;
  } finally {
    clearTimeout(timer);
    options?.signal?.removeEventListener('abort', abort);
    if (reader) { void reader.cancel(signal.reason).catch(() => {}); reader.releaseLock(); }
    writer?.releaseLock();
  }
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

/**
 * In-memory proxy-mode StorageAdapter for the workerd smoke test. It has no
 * signed URLs, so FileFn proxies upload and download bytes through its own
 * routes, which exercises the basePath-relative URLs it hands to clients.
 */
import type { StorageAdapter } from '@superfunctions/storage';

interface StoredObject {
  bytes: Uint8Array;
  contentType?: string;
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function toBytes(chunk: unknown): Uint8Array {
  if (chunk instanceof Uint8Array) return chunk;
  if (chunk instanceof ArrayBuffer) return new Uint8Array(chunk);
  if (ArrayBuffer.isView(chunk)) return new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  if (typeof chunk === 'string') return new TextEncoder().encode(chunk);
  throw new TypeError('memory storage accepts byte chunks only');
}

export function createMemoryStorage(): StorageAdapter {
  const objects = new Map<string, StoredObject>();
  const keyOf = (input: { key: string; target?: string }) => `${input.target ?? 'default'}:${input.key}`;

  return {
    name: 'memory',
    capabilities: {
      signedUploadUrls: false,
      signedDownloadUrls: false,
      multipart: false,
      proxyStreamingUpload: true,
      proxyStreamingDownload: true,
    },
    async statObject(input) {
      const object = objects.get(keyOf(input));
      if (!object) throw new Error(`object not found: ${input.key}`);
      return { key: input.key, size: object.bytes.byteLength, contentType: object.contentType };
    },
    async deleteObject(input) {
      objects.delete(keyOf(input));
    },
    async openUploadStream(input) {
      const chunks: Uint8Array[] = [];
      return new WritableStream<unknown>({
        write(chunk) {
          chunks.push(toBytes(chunk));
        },
        close() {
          objects.set(keyOf(input), { bytes: concat(chunks), contentType: input.contentType });
        },
      });
    },
    async openDownloadStream(input) {
      const object = objects.get(keyOf(input));
      if (!object) throw new Error(`object not found: ${input.key}`);
      const bytes = input.range
        ? object.bytes.slice(input.range.start, input.range.endInclusive + 1)
        : object.bytes;
      return new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes);
          controller.close();
        },
      });
    },
  };
}

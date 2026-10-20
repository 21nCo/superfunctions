import { describe, expect, it } from 'vitest';
import { createFakeStorageAdapter } from '@superfunctions/storage';
import { createLocalStorageAdapter } from '@superfunctions/storage-local';
import {
  MemoryStorageAdapter,
  assertProductionStorage,
  createDownloadResponse,
  createDownloadUrl,
  uploadObject,
} from '../src/integrations/storage.js';

describe('storage adapter integration', () => {
  it('preserves a native stream write failure and releases its writer', async () => {
    const failure = new Error('storage quota exceeded');
    let closed = false;
    const stream = new WritableStream<Uint8Array>({
      write() { throw failure; },
      close() { closed = true; },
    });
    const storage = new MemoryStorageAdapter();
    storage.openUploadStream = async () => stream;
    await expect(uploadObject(storage, 'failed', new Uint8Array([1]))).rejects.toBe(failure);
    expect(closed).toBe(false);
    expect(stream.locked).toBe(false);
  });

  it('releases native stream writers after successful close or failed finalization', async () => {
    for (const fail of [false, true]) {
      const failure = new Error('finalization failed');
      const chunks: number[] = [];
      const stream = new WritableStream<Uint8Array>({
        write(chunk) { chunks.push(...chunk); },
        close() { if (fail) throw failure; },
      });
      const storage = new MemoryStorageAdapter();
      storage.openUploadStream = async () => stream;
      const upload = uploadObject(storage, 'recording', new Uint8Array([1, 2]));
      if (fail) await expect(upload).rejects.toBe(failure);
      else await upload;
      expect(chunks).toEqual([1, 2]);
      expect(stream.locked).toBe(false);
    }
  });

  it('uploads bytes and returns a signed URL from the shared storage seam (TV-ARCH-002)', async () => {
    const storage = new MemoryStorageAdapter();

    await uploadObject(
      storage,
      'recordings/ns_test/rec_123.mp4',
      new Uint8Array([1, 2, 3, 4]),
      { contentType: 'video/mp4', encryption: true },
    );

    expect(storage.has('recordings/ns_test/rec_123.mp4')).toBe(true);
    expect(storage.isEncrypted('recordings/ns_test/rec_123.mp4')).toBe(true);

    const url = await createDownloadUrl(storage, 'recordings/ns_test/rec_123.mp4');
    expect(url).toContain('signed');
    expect(url).toContain('expires=');
  });

  it('falls back to a proxy URL for local storage adapters without signed download URLs', async () => {
    const storage = createLocalStorageAdapter({
      rootDir: '/tmp/recfn-storage-adapter-test',
    });

    const url = await createDownloadUrl(storage, 'recordings/ns_test/rec_456.mp4', {
      proxyUrl: 'http://localhost/api/v1/recordings/rec_456/download',
    });

    expect(url).toBe('http://localhost/api/v1/recordings/rec_456/download');
  });

  it('can proxy-download from local storage when signed URLs are unavailable', async () => {
    const storage = createLocalStorageAdapter({
      rootDir: '/tmp/recfn-storage-response-test',
    });

    await uploadObject(storage, 'recordings/ns_test/rec_789.wav', new Uint8Array([9, 8, 7]));
    const response = await createDownloadResponse(storage, 'recordings/ns_test/rec_789.wav');

    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(
      new Uint8Array([9, 8, 7]),
    );
  });

  it('rejects production startup when storage capabilities are missing', () => {
    const storage = createFakeStorageAdapter({
      capabilities: {
        signedUploadUrls: false,
        signedDownloadUrls: false,
        multipart: false,
        proxyStreamingUpload: false,
        proxyStreamingDownload: false,
      },
    });

    expect(() => assertProductionStorage(storage)).toThrow(/must support upload and download/i);
  });
});

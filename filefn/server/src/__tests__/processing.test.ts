import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createProcessingService, type Processor } from '../processing/service.js';
import { createFakeStorageAdapter } from '@superfunctions/storage';
import { createEventEmitter } from '../events.js';

function createFakeDbAdapter() {
  return {
    create: vi.fn().mockResolvedValue({ artifactId: 'art_1' }),
    findOne: vi.fn().mockResolvedValue(null),
    update: vi.fn().mockResolvedValue({}),
    findMany: vi.fn().mockResolvedValue([]),
  } as any;
}

describe('ProcessingService', () => {
  let db: ReturnType<typeof createFakeDbAdapter>;
  let service: ReturnType<typeof createProcessingService>;
  let events: any;

  beforeEach(() => {
    db = createFakeDbAdapter();
    events = createEventEmitter();
    service = createProcessingService({
      db,
      storage: createFakeStorageAdapter({
        capabilities: { signedUploadUrls: true, signedDownloadUrls: true, multipart: true, proxyStreamingUpload: true, proxyStreamingDownload: true },
        async openDownloadStream() {
            return new ReadableStream({
                start(controller) {
                    controller.enqueue(new Uint8Array([1, 2, 3]));
                    controller.close();
                }
            }) as any;
        },
        async openUploadStream() {
            return new WritableStream() as any;
        }
      }),
      events,
      processors: [{
        name: 'test-processor',
        supportedMimeTypes: ['image/png'],
        process: async () => ({
          success: true,
          artifacts: [{
            kind: 'thumbnail',
            data: new Uint8Array([1]),
            mimeType: 'image/png',
            storageKey: 'thumb/key'
          }]
        })
      }]
    });
  });

  it('should create artifact if not exists', async () => {
    const input = {
      fileId: 'f1',
      versionId: 'v1',
      storageKey: 'k1',
      mimeType: 'image/png',
      size: 100,
      fileName: 'test.png',
    };
    const ctx = { requestId: 'req1' };

    db.findOne.mockResolvedValue(null); // Not found

    await service.runProcessing(input, ctx);

    expect(db.create).toHaveBeenCalled();
    expect(db.update).not.toHaveBeenCalled();
  });

  it('should update artifact if exists (idempotency)', async () => {
    const input = {
      fileId: 'f1',
      versionId: 'v1',
      storageKey: 'k1',
      mimeType: 'image/png',
      size: 100,
      fileName: 'test.png',
    };
    const ctx = { requestId: 'req1' };

    db.findOne.mockResolvedValue({ artifactId: 'art_existing', kind: 'thumbnail' }); // Found

    await service.runProcessing(input, ctx);

    expect(db.create).not.toHaveBeenCalled();
    expect(db.update).toHaveBeenCalled();
  });
});

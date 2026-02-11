import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createFileFnClient } from '../index.js';
import { OPFSStore } from '../offline/opfs-store.js';

// Mock mocks
const stagedUploads = new Map();
const mockUploadFile = vi.fn().mockResolvedValue({ fileId: 'f1', versionId: 'v1' });

// Mock HttpClient
vi.mock('../client.js', async (importOriginal) => {
    const actual = await importOriginal() as Record<string, unknown>;
    return {
        ...actual,
        createHttpClient: () => ({
            // But used by sync
            // The upload manager uses http client.
            // We can mock the upload manager or http client.
            // The sync logic calls manager.startUpload -> http.initUpload etc.
            // But we mocked UploadManager in sync? No, we mocked UploadClient in SyncConfig.
            // In index.ts, we create OfflineSync with a client that uses UploadManager.
            // So we need to mock HttpClient methods that UploadManager calls.
            initUpload: vi.fn().mockResolvedValue({ 
                uploadSessionId: 'upl_real', totalParts: 1, chunkSizeBytes: 100 
            }),
            signPart: vi.fn().mockResolvedValue({ url: 'http://upload' }),
            uploadPartToSignedUrl: vi.fn().mockResolvedValue({ recorded: true }),
            completeUpload: vi.fn().mockResolvedValue({ fileId: 'f1', versionId: 'v1' }),
        })
    };
});

// Mock OPFSStore
vi.mock('../offline/opfs-store.js', () => {
  return {
    OPFSStore: class {
      constructor() {}
      static isSupported = vi.fn().mockReturnValue(true);
      async init() {}
      async stagePendingUpload(u: any) { stagedUploads.set(u.uploadSessionId, u); }
      async getPendingUpload(id: string) { return stagedUploads.get(id); }
      async listPendingUploads() { return Array.from(stagedUploads.keys()); }
      async deletePendingUpload(id: string) { stagedUploads.delete(id); }
      async incrementRetryCount() {}
    }
  };
});

describe('Offline Client', () => {
  let onlineCallback: (() => void) | undefined;

  beforeEach(() => {
    stagedUploads.clear();
    mockUploadFile.mockClear();
    
    // Mock navigator
    if (typeof navigator === 'undefined') {
        global.navigator = {} as any;
    }
    Object.defineProperty(navigator, 'onLine', {
        writable: true,
        value: true
    });

    // Mock window events
    if (typeof window === 'undefined') {
        global.window = {
            addEventListener: vi.fn((event, cb) => {
                if (event === 'online') onlineCallback = cb;
            })
        } as any;
    } else {
        vi.spyOn(window, 'addEventListener').mockImplementation((event, cb) => {
            if (event === 'online') onlineCallback = cb as any;
        });
    }
  });

  it('TV-CLIENT-OFFLINE-001: should stage when offline and sync when online', async () => {
    // Go offline
    Object.defineProperty(navigator, 'onLine', { value: false });

    const client = createFileFnClient({
        baseUrl: 'http://test',
        offline: { enabled: true }
    });

    const file = new File(['content'], 'test.txt', { type: 'text/plain' });
    const handle = client.uploadFile({ policy: 'p', file });

    // Wait for done() - it should block until sync
    const donePromise = handle.done();

    // Wait for staging (microtasks)
    await new Promise(resolve => setTimeout(resolve, 0));

    // Verify staged
    expect(stagedUploads.size).toBe(1);
    expect(stagedUploads.values().next().value.fileName).toBe('test.txt');

    // Go online and trigger sync
    Object.defineProperty(navigator, 'onLine', { value: true });
    if (onlineCallback) await onlineCallback();

    // Wait for done to resolve
    const result = await donePromise;

    expect(result.fileId).toBe('f1');
    expect(stagedUploads.size).toBe(0);
  });

  it('TV-CLIENT-OFFLINE-NEG-001: should throw if offline enabled but OPFS unavailable', () => {
    // Mock OPFS unsupported
    // @ts-ignore
    OPFSStore.isSupported.mockReturnValueOnce(false);

    expect(() => {
        createFileFnClient({
            baseUrl: 'http://test',
            offline: { enabled: true }
        });
    }).toThrow(/OPFS unavailable/);
  });
});

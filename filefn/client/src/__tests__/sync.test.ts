import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { OfflineSync } from '../offline/sync.js';

describe('OfflineSync', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('retries transient sync failures while online and resolves late waiters once', async () => {
    let retryCount = 0;
    const pending = {
      uploadSessionId: 'offline_retry_1',
      fileId: 'file_retry_1',
      policy: 'p',
      fileName: 'retry.txt',
      size: 4,
      mimeType: 'text/plain',
      fileData: new TextEncoder().encode('test').buffer,
      createdAt: new Date().toISOString(),
      retryCount: 0,
    };

    const store = {
      async listPendingUploads() {
        return ['offline_retry_1'];
      },
      async getPendingUpload() {
        return pending;
      },
      async deletePendingUpload() {
        return;
      },
      async incrementRetryCount() {
        retryCount += 1;
        pending.retryCount = retryCount;
      },
    };

    const client = {
      uploadFile: vi
        .fn()
        .mockRejectedValueOnce(new Error('network timeout'))
        .mockResolvedValueOnce({ fileId: 'file_retry_1', versionId: 'ver_retry_1' }),
    };

    const sync = new OfflineSync({
      store: store as any,
      client,
      retryDelayMs: 25,
      maxRetries: 2,
    });
    sync.setConnectivityChecker({
      isOnline: () => true,
      onOnline: () => () => {},
      onOffline: () => () => {},
    });

    await sync.syncAll();
    expect(client.uploadFile).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(25);
    const settled = await sync.waitForUpload('offline_retry_1');
    expect(settled).toEqual({ fileId: 'file_retry_1', versionId: 'ver_retry_1' });
    const secondWait = Promise.race([
      sync.waitForUpload('offline_retry_1').then(() => 'resolved'),
      new Promise((resolve) => setTimeout(() => resolve('pending'), 0)),
    ]);
    await vi.advanceTimersByTimeAsync(0);
    await expect(secondWait).resolves.toBe('pending');
  });

  it('consumes settled results on the fast path', async () => {
    const sync = new OfflineSync({
      store: {
        async listPendingUploads() { return []; },
        async getPendingUpload() { return null; },
        async deletePendingUpload() { return; },
        async incrementRetryCount() { return; },
      } as any,
      client: {
        async uploadFile() {
          return { fileId: 'file', versionId: 'ver' };
        },
      },
    });

    sync.setConnectivityChecker({
      isOnline: () => true,
      onOnline: () => () => {},
      onOffline: () => () => {},
    });

    const notify = sync as unknown as {
      notifyListeners: (uploadSessionId: string, result: { fileId: string; versionId: string } | Error) => void;
    };
    notify.notifyListeners('offline_done_1', { fileId: 'file_done_1', versionId: 'ver_done_1' });

    await expect(sync.waitForUpload('offline_done_1')).resolves.toEqual({
      fileId: 'file_done_1',
      versionId: 'ver_done_1',
    });
    const secondWait = Promise.race([
      sync.waitForUpload('offline_done_1').then(() => 'resolved'),
      new Promise((resolve) => setTimeout(() => resolve('pending'), 0)),
    ]);
    await vi.advanceTimersByTimeAsync(0);
    await expect(secondWait).resolves.toBe('pending');
  });

  it('rejects waiting uploads after cancellation and removes staged data', async () => {
    const store = {
      async listPendingUploads() { return ['offline_cancel_1']; },
      async getPendingUpload() { return null; },
      async deletePendingUpload() { return; },
      async incrementRetryCount() { return; },
    };

    const sync = new OfflineSync({
      store: store as any,
      client: {
        async uploadFile() {
          return { fileId: 'file', versionId: 'ver' };
        },
      },
    });

    const waitPromise = sync.waitForUpload('offline_cancel_1');
    await sync.cancelUpload('offline_cancel_1');

    await expect(waitPromise).rejects.toThrow('Aborted');
  });
});

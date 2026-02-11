import { createHttpClient, FileFnHttpError } from './client.js';
import { UploadManager } from './upload-manager.js';
import type {
  FileFnClientConfig,
  UploadInput,
  UploadHandle,
  UploadResult,
} from './types.js';

import {
  OPFSStore,
  type PendingUpload,
} from './offline/opfs-store.js';

import {
  OfflineSync,
  shouldUseOfflineMode,
  generateOfflineSessionId,
} from './offline/sync.js';

export type {
  FileFnClientConfig,
  UploadInput,
  UploadHandle,
  UploadProgress,
  UploadResult,
  RetryOptions,
  InitUploadResponse,
  UploadStatusResponse,
  SignPartResponse,
  CompletePartResponse,
  CompleteUploadResponse,
  AbortUploadResponse,
} from './types.js';

export { FileFnHttpError } from './client.js';
export { resolveRetryOptions, computeDelay, isRetryableError, withRetry } from './retry.js';

export type {
  PendingUpload,
  OPFSStoreConfig,
} from './offline/opfs-store.js';

export {
  OPFSStore,
} from './offline/opfs-store.js';

export type {
  UploadClient,
  SyncConfig,
  SyncProgress,
  SyncResult,
  ConnectivityChecker,
} from './offline/sync.js';

export {
  OfflineSync,
  shouldUseOfflineMode,
  generateOfflineSessionId,
} from './offline/sync.js';

export interface FileFnClient {
  uploadFile(input: UploadInput): UploadHandle;
  resumeUpload(uploadSessionId: string, file: Blob): UploadHandle;
  getFile(fileId: string): Promise<Record<string, unknown>>;
  downloadUrl(fileId: string, options?: { versionId?: string }): Promise<string>;
  deleteFile(fileId: string): Promise<void>;
}

export function createFileFnClient(config: FileFnClientConfig): FileFnClient {
  const httpClient = createHttpClient(config);
  
  let offlineSync: OfflineSync | undefined;
  let offlineStore: OPFSStore | undefined;

  if (config.offline?.enabled) {
    if (!OPFSStore.isSupported()) {
      const error = new Error('OPFS unavailable') as any;
      error.code = 'FILEFN_OFFLINE_UNSUPPORTED';
      throw error;
    }

    const store = new OPFSStore({ rootDir: config.offline.opfsDir });
    // Initialize lazily but ensure it's started
    store.init().catch(() => {});
    offlineStore = store;

    offlineSync = new OfflineSync({
      store,
      client: {
        uploadFile: async (input) => {
          const manager = new UploadManager(httpClient);
          // startUpload returns UploadResult which matches what we need
          return manager.startUpload(input);
        }
      }
    });

    offlineSync.startAutoSync();
  }

  return {
    uploadFile(input: UploadInput): UploadHandle {
      if (offlineSync && offlineStore && shouldUseOfflineMode(config.offline?.enabled ?? false)) {
        const uploadSessionId = generateOfflineSessionId();
        
        const handle: UploadHandle = {
          uploadSessionId,
          abort: () => {
            // Staging abort not implemented
          },
          onProgress: (_cb) => {
            // Staging progress not implemented
          },
          done: async () => {
            const fileData = await input.file.arrayBuffer();
            const pending: PendingUpload = {
              uploadSessionId,
              policy: input.policy,
              fileName: input.fileName || (input.file instanceof File ? input.file.name : 'blob'),
              size: input.file.size,
              mimeType: input.file.type || 'application/octet-stream',
              fileData,
              metadata: input.metadata,
              createdAt: new Date().toISOString(),
              retryCount: 0
            };

            await offlineStore!.stagePendingUpload(pending);
            
            // Wait for sync to complete when online
            return offlineSync!.waitForUpload(uploadSessionId);
          }
        };
        
        return handle;
      }

      const manager = new UploadManager(httpClient);
      return manager.createHandle(input, () => manager.startUpload(input));
    },

    resumeUpload(uploadSessionId: string, file: Blob): UploadHandle {
      const manager = new UploadManager(httpClient);
      const dummyInput: UploadInput = { policy: '', file };
      return manager.createHandle(dummyInput, () => manager.resumeUpload(uploadSessionId, file));
    },

    async getFile(fileId: string): Promise<Record<string, unknown>> {
      return httpClient.getFile(fileId);
    },

    async downloadUrl(fileId: string, options?: { versionId?: string }): Promise<string> {
      const response = await httpClient.downloadUrl(fileId, options);
      return response.url;
    },

    async deleteFile(fileId: string): Promise<void> {
      await httpClient.deleteFile(fileId);
    },
  };
}
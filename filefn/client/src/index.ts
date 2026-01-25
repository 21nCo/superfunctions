import { createHttpClient } from './client.js';
import { UploadManager } from './upload-manager.js';
import type {
  FileFnClientConfig,
  UploadInput,
  UploadHandle,
  UploadResult,
} from './types.js';

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

export interface FileFnClient {
  uploadFile(input: UploadInput): UploadHandle;
  resumeUpload(uploadSessionId: string, file: Blob): UploadHandle;
}

export function createFileFnClient(config: FileFnClientConfig): FileFnClient {
  const httpClient = createHttpClient(config);

  return {
    uploadFile(input: UploadInput): UploadHandle {
      const manager = new UploadManager(httpClient);
      return manager.createHandle(input, () => manager.startUpload(input));
    },

    resumeUpload(uploadSessionId: string, file: Blob): UploadHandle {
      const manager = new UploadManager(httpClient);
      const dummyInput: UploadInput = { policy: '', file };
      return manager.createHandle(dummyInput, () => manager.resumeUpload(uploadSessionId, file));
    },
  };
}

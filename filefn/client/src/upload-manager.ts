import type { HttpClient } from './client.js';
import type {
  UploadInput,
  UploadHandle,
  UploadProgress,
  UploadResult,
  UploadStatusResponse,
} from './types.js';

interface UploadSession {
  uploadSessionId: string;
  totalParts: number;
  chunkSizeBytes: number;
  fileSize: number;
}

export class UploadManager {
  private progressCallbacks: Array<(progress: UploadProgress) => void> = [];
  private abortController: AbortController;
  private session: UploadSession | null = null;
  private file: Blob | null = null;
  private completedParts: Set<number> = new Set();
  private bytesUploaded = 0;

  constructor(private readonly httpClient: HttpClient) {
    this.abortController = new AbortController();
  }

  createHandle(
    input: UploadInput,
    startUpload: () => Promise<UploadResult>
  ): UploadHandle {
    let uploadPromise: Promise<UploadResult> | null = null;

    const handle: UploadHandle = {
      uploadSessionId: '',
      onProgress: (callback) => {
        this.progressCallbacks.push(callback);
      },
      abort: () => {
        this.abortController.abort();
      },
      done: async () => {
        if (!uploadPromise) {
          uploadPromise = startUpload();
        }
        const result = await uploadPromise;
        handle.uploadSessionId = this.session?.uploadSessionId || '';
        return result;
      },
    };

    return handle;
  }

  async startUpload(input: UploadInput): Promise<UploadResult> {
    const signal = this.abortController.signal;
    this.file = input.file;

    const fileName = input.fileName || (input.file instanceof File ? input.file.name : 'blob');
    const contentType = input.file.type || 'application/octet-stream';
    const fileSize = input.file.size;

    const initResponse = await this.httpClient.initUpload({
      policy: input.policy,
      fileName,
      fileSize,
      contentType,
      metadata: input.metadata,
      fileId: input.fileId,
      idempotencyKey: input.idempotencyKey,
    }, signal);

    this.session = {
      uploadSessionId: initResponse.uploadSessionId,
      totalParts: initResponse.totalParts,
      chunkSizeBytes: initResponse.chunkSizeBytes,
      fileSize,
    };

    await this.uploadAllParts(signal);

    const result = await this.httpClient.completeUpload(this.session.uploadSessionId, signal);
    return result;
  }

  async resumeUpload(uploadSessionId: string, file: Blob): Promise<UploadResult> {
    const signal = this.abortController.signal;
    this.file = file;

    const status = await this.httpClient.getUploadStatus(uploadSessionId, signal);

    this.session = {
      uploadSessionId,
      totalParts: status.totalParts,
      chunkSizeBytes: status.chunkSizeBytes,
      fileSize: status.fileSize,
    };

    this.completedParts = new Set(status.recordedParts);
    this.bytesUploaded = this.calculateUploadedBytes(status);

    this.emitProgress();

    await this.uploadAllParts(signal);

    const result = await this.httpClient.completeUpload(uploadSessionId, signal);
    return result;
  }

  private calculateUploadedBytes(status: UploadStatusResponse): number {
    let bytes = 0;
    for (const partNum of status.recordedParts) {
      if (partNum < status.totalParts) {
        bytes += status.chunkSizeBytes;
      } else {
        bytes += status.fileSize - (status.totalParts - 1) * status.chunkSizeBytes;
      }
    }
    return bytes;
  }

  private async uploadAllParts(signal: AbortSignal): Promise<void> {
    if (!this.session || !this.file) {
      throw new Error('No active session');
    }

    for (let partNum = 1; partNum <= this.session.totalParts; partNum++) {
      if (signal.aborted) {
        throw new DOMException('Aborted', 'AbortError');
      }

      if (this.completedParts.has(partNum)) {
        continue;
      }

      await this.uploadPart(partNum, signal);
    }
  }

  private async uploadPart(partNumber: number, signal: AbortSignal): Promise<void> {
    if (!this.session || !this.file) {
      throw new Error('No active session');
    }

    const { uploadSessionId, chunkSizeBytes, totalParts, fileSize } = this.session;

    const start = (partNumber - 1) * chunkSizeBytes;
    const end = partNumber === totalParts ? fileSize : start + chunkSizeBytes;
    const chunk = this.file.slice(start, end);

    const signResponse = await this.httpClient.signPart(uploadSessionId, partNumber, signal);

    const etag = await this.httpClient.uploadPartToSignedUrl(
      signResponse.url,
      signResponse.headers,
      chunk,
      signal
    );

    await this.httpClient.completePart(uploadSessionId, partNumber, etag, signal);

    this.completedParts.add(partNumber);
    this.bytesUploaded += chunk.size;
    this.emitProgress();
  }

  private emitProgress(): void {
    if (!this.session) return;

    const progress: UploadProgress = {
      bytesUploaded: this.bytesUploaded,
      bytesTotal: this.session.fileSize,
      partsCompleted: this.completedParts.size,
      totalParts: this.session.totalParts,
    };

    for (const callback of this.progressCallbacks) {
      try {
        callback(progress);
      } catch {
        // Ignore callback errors
      }
    }
  }
}

export interface RetryOptions {
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
}

export interface FileFnClientConfig {
  baseUrl: string;
  getAuthHeaders?: () => Promise<Record<string, string>> | Record<string, string>;
  retryOptions?: RetryOptions;
  offline?: {
    enabled: boolean;
    opfsDir?: string;
  };
}

export interface UploadInput {
  policy: string;
  file: File | Blob;
  fileName?: string;
  metadata?: Record<string, unknown>;
  fileId?: string;
  idempotencyKey?: string;
}

export interface UploadProgress {
  bytesUploaded: number;
  bytesTotal: number;
  partsCompleted: number;
  totalParts: number;
}

export interface UploadResult {
  fileId: string;
  versionId: string;
}

export interface UploadHandle {
  uploadSessionId: string;
  onProgress(callback: (progress: UploadProgress) => void): void;
  abort(): void;
  done(): Promise<UploadResult>;
}

export interface InitUploadResponse {
  uploadSessionId: string;
  uploadMode: string;
  chunkSizeBytes: number;
  totalParts: number;
  expiresAt: string;
}

export interface UploadStatusResponse {
  status: 'pending' | 'in_progress' | 'completed' | 'aborted';
  recordedParts: number[];
  totalParts: number;
  chunkSizeBytes: number;
  fileSize: number;
}

export interface SignPartResponse {
  url: string;
  headers: Record<string, string>;
  expiresAt: string;
}

export interface CompletePartResponse {
  recorded: boolean;
}

export interface CompleteUploadResponse {
  fileId: string;
  versionId: string;
}

export interface AbortUploadResponse {
  aborted: boolean;
}

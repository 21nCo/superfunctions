import type {
  HeicPreprocessorOptions,
  PendingLocalSourceMetadata,
  UploadPreprocessor,
} from './preprocessing/types.js';

export interface RetryOptions {
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
}

export interface FileFnClientConfig {
  baseUrl: string;
  /**
   * Headers added to every request sent to FileFn (API calls and proxy part
   * uploads). Called again for each request and retry attempt, so it can
   * return a fresh bearer token or CSRF token. Never sent to presigned
   * storage URLs outside `baseUrl`.
   */
  getAuthHeaders?: () => Promise<Record<string, string>> | Record<string, string>;
  /**
   * Fetch implementation used for every request the client makes, including
   * part uploads and offline sync replay. Defaults to the global `fetch`,
   * looked up when each request is sent. It is called without a `this`
   * binding, so `window.fetch` can be passed directly.
   */
  fetch?: typeof fetch;
  /**
   * Credentials mode for requests sent to FileFn. Defaults to `same-origin`.
   * Use `include` to send session cookies to a FileFn API on another origin.
   * Part uploads to presigned URLs outside `baseUrl` always use `omit`.
   */
  credentials?: RequestCredentials;
  retryOptions?: RetryOptions;
  offline?: {
    enabled: boolean;
    opfsDir?: string;
  };
  preprocessing?: {
    preprocessors?: UploadPreprocessor[];
    heic?: HeicPreprocessorOptions & {
      enabled?: boolean;
    };
  };
}

export interface UploadInput {
  policy: string;
  file: File | Blob;
  fileName?: string;
  metadata?: Record<string, unknown>;
  /**
   * File ID to upload under, so an offline capture keeps one ID before and
   * after it syncs. Defaults to `generateFileId()`.
   *
   * - Must match `file_[A-Za-z0-9_-]{8,64}`; the server rejects any other value
   *   on `upload/init` with 400 `FILEFN_INVALID_FILE_ID`.
   * - A new ID creates the file owned by the caller. If two callers race on
   *   the same new ID, the first upload to complete owns the file and the
   *   other's completion fails with 403 `FILEFN_FORBIDDEN`.
   * - An existing ID replaces that file with a new version and needs write
   *   permission on it; otherwise `upload/init` fails with 403.
   * - Retrying an upload under the same ID is safe: pass the same
   *   `idempotencyKey` to get the same upload session back.
   */
  fileId?: string;
  idempotencyKey?: string;
  preprocessors?: UploadPreprocessor[];
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

export type RenderIntent = 'thumbnail' | 'preview' | 'full' | 'download';
export type RenderState = 'ready' | 'processing' | 'pending-local' | 'unsupported';
export type RenderPlaceholderKind = 'generic-file' | 'pdf-processing' | 'unsupported-preview';

export interface ArtifactDescriptor {
  artifactId: string;
  fileId: string;
  versionId: string;
  kind: string;
  mimeType: string;
  size: number;
  createdAt: string;
}

export interface RenderDescriptor {
  fileId: string;
  versionId: string;
  intent: RenderIntent;
  state: RenderState;
  mimeType: string;
  name: string;
  size: number;
  source:
    | {
        mode: 'artifact';
        artifactId: string;
        artifactKind: string;
        url: string;
        headers?: Record<string, string>;
      }
    | {
        mode: 'original';
        url: string;
        headers?: Record<string, string>;
      }
    | {
        mode: 'placeholder';
        placeholderKind: RenderPlaceholderKind;
      };
  warnings?: string[];
}

export interface UploadHandle {
  uploadSessionId: string;
  uploadSessionToken?: string;
  fileId?: string;
  onProgress(callback: (progress: UploadProgress) => void): void;
  abort(): void;
  done(): Promise<UploadResult>;
}

export interface UploadHandleWithFileId extends UploadHandle {
  fileId: string;
}

export interface PendingLocalDescriptor {
  fileId: string;
  uploadSessionId: string;
  state: 'pending-local';
  source: PendingLocalSourceMetadata & {
    url: string;
  };
}

export interface InitUploadResponse {
  uploadSessionId: string;
  uploadSessionToken?: string;
  uploadMode: string;
  chunkSizeBytes: number;
  totalParts: number;
  expiresAt: string;
}

export interface UploadStatusResponse {
  uploadSessionId?: string;
  fileId?: string;
  status: 'pending' | 'in_progress' | 'completed' | 'aborted';
  recordedParts: number[];
  uploadedParts?: number[];
  totalParts: number;
  chunkSizeBytes: number;
  fileSize: number;
  expiresAt?: string;
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

import type { OfflineQueueCurrentPrincipal, OfflineQueueOptions, OfflineQueuePartition } from './offline/queue.js';
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
    /**
     * Trusted service and principal (or guest namespace) the offline queue is
     * bound to. Required for offline staging; without it offline uploads throw
     * `FILEFN_OFFLINE_PARTITION_REQUIRED` and nothing is listed or replayed.
     * Create a new client (and dispose this one) when the principal changes.
     */
    partition?: OfflineQueuePartition;
    /**
     * Required with `partition`: the principal this client's credentials act
     * for right now (null when signed out). Queued work uploads and runs hooks
     * only while it matches `partition`, so an account switch in another tab
     * that shares cookies cannot upload one principal's files as another.
     */
    currentPrincipal?: OfflineQueueCurrentPrincipal;
    /**
     * Whether offline `uploadFile`, `getPendingLocalDescriptor` and
     * `resolveRenderable` start a sync of the queue on their own. Defaults to
     * true. With false, only an `OfflineSync` from `createOfflineSync()` that
     * you `start()` advances queued work.
     */
    implicitReplay?: boolean;
    /** Queue options: hooks, limits, coordinator, storage root and retention. */
    queue?: Omit<OfflineQueueOptions, 'partition' | 'uploader' | 'legacyRootDir' | 'currentPrincipal'>;
    /**
     * Directory of unscoped uploads staged by 0.4 and earlier. They are never
     * replayed automatically; see `OfflineQueue.migrateLegacyUpload`.
     */
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
   * File ID to create, matching `file_[A-Za-z0-9_-]{8,64}`. Omit it (or pass
   * `null`) and the client generates one with `generateFileId()`. Any other
   * value makes `uploadFile` throw `FILEFN_INVALID_FILE_ID` at once, online or
   * offline, before anything is staged or sent. The ID is kept unchanged through
   * offline staging, reload and replay.
   *
   * The server reserves nothing at `upload/init`: concurrent uploads may name the
   * same new ID, and the first one to complete creates the file. Any other upload
   * naming that ID is then refused at completion with 403 (`FILEFN_FORBIDDEN`)
   * unless the caller may write to the existing file. An ID that names an existing
   * file the caller may not write to is refused with 403 at `upload/init`.
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
  /** Who produced the artifact; servers that predate sources omit it. */
  source?: ArtifactSource;
  /** Processing time recorded for the artifact, in milliseconds. */
  processingDurationMs?: number;
  createdAt: string;
}

/** Who produced an artifact: a server processor or the client on the device. */
export type ArtifactSource = 'client' | 'server';

/** Kinds a client may supply: the thumbnail sizes the viewer resolves, and a converted image. */
export type ClientArtifactKind = 'thumbnail-small' | 'thumbnail-medium' | 'thumbnail-large' | 'converted';

export interface UploadArtifactInput {
  fileId: string;
  versionId: string;
  kind: ClientArtifactKind;
  /** The artifact bytes. A Blob's own type is used when `mimeType` is omitted. */
  data: Blob | Uint8Array;
  /** image/webp, image/png or image/jpeg for a thumbnail; image/png for a converted image. */
  mimeType?: string;
  /** Time spent producing the artifact on the device, in milliseconds. */
  durationMs?: number;
  signal?: AbortSignal;
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
  /**
   * Set when the idempotency key replayed an existing session (servers 0.8+).
   * `completed` carries the stored `fileId` and `versionId`; `aborted` and
   * `expired` are final.
   */
  status?: 'pending' | 'in_progress' | 'completed' | 'aborted' | 'expired';
  fileId?: string;
  versionId?: string;
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

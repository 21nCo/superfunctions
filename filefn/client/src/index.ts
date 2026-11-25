import { createHttpClient, FileFnHttpError } from './client.js';
import {
  UploadManager,
  assertValidExplicitFileId,
  assertValidIdempotencyKey,
  generateFileId,
  prepareUploadInput,
} from './upload-manager.js';
import type {
  ArtifactDescriptor,
  ClientArtifactKind,
  FileFnClientConfig,
  PendingLocalDescriptor,
  RenderDescriptor,
  RenderIntent,
  RenderPlaceholderKind,
  UploadInput,
  UploadHandle,
  UploadHandleWithFileId,
  UploadResult,
  UploadArtifactInput,
} from './types.js';
import type { UploadPreprocessor } from './preprocessing/types.js';
import { createHeicPreprocessor } from './preprocessing/heic.js';

import {
  OfflineSync,
  shouldUseOfflineMode,
  generateOfflineSessionId,
  type SyncConfig,
} from './offline/sync.js';
import { OfflineQueue, OfflineQueueError, type OfflineQueueUploader } from './offline/queue.js';

export type {
  ArtifactDescriptor,
  ArtifactSource,
  ClientArtifactKind,
  UploadArtifactInput,
  FileFnClientConfig,
  PendingLocalDescriptor,
  RenderDescriptor,
  RenderIntent,
  RenderPlaceholderKind,
  UploadInput,
  UploadHandle,
  UploadHandleWithFileId,
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
export type {
  HeicConversionFunction,
  HeicConversionInput,
  HeicConversionResult,
  HeicPreprocessorOptions,
  PendingLocalPreviewBehavior,
  PendingLocalSourceKind,
  PendingLocalSourceMetadata,
  UploadPreprocessor,
  UploadPreprocessorContext,
  UploadPreprocessorResult,
} from './preprocessing/types.js';

export { FileFnHttpError } from './client.js';
export { resolveRetryOptions, computeDelay, isRetryableError, withRetry } from './retry.js';
export { createHeicPreprocessor, FILEFN_HEIC_CONVERSION_FAILED } from './preprocessing/heic.js';
export { generateFileId } from './upload-manager.js';

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

export type {
  LegacyPendingUploadSummary,
  OfflineQueueCapabilities,
  OfflineQueueDirectoryHandle,
  OfflineQueueEntry,
  OfflineQueueErrorCode,
  OfflineQueueEvent,
  OfflineQueueFileHandle,
  OfflineQueueHooks,
  OfflineQueueLimits,
  OfflineQueueLockCoordinator,
  OfflineQueueOperationContext,
  OfflineQueueOptions,
  OfflineQueuePartition,
  OfflineQueuePending,
  OfflineQueuePhase,
  OfflineQueuePrincipal,
  OfflineQueueProcessResult,
  OfflineQueuePublicationCheck,
  OfflineQueuePublicationOutcome,
  OfflineQueueReclaimResult,
  OfflineQueueStageInput,
  OfflineQueueStageResult,
  OfflineQueueUploader,
  OfflineQueueUsage,
  OfflineQueueVerification,
} from './offline/queue.js';

export {
  DEFAULT_MAX_UPLOAD_ATTEMPTS,
  DEFAULT_OFFLINE_QUEUE_LIMITS,
  DEFAULT_TERMINAL_RETENTION_MS,
  OfflineQueue,
  OfflineQueueError,
} from './offline/queue.js';
export { UPLOAD_SESSION_ENDED_ERROR, UPLOAD_RECONCILE_FAILED_ERROR } from './upload-manager.js';

export interface FileFnClient {
  uploadFile(input: UploadInput): UploadHandleWithFileId;
  resumeUpload(
    uploadSessionId: string,
    file: Blob,
    options?: { uploadSessionToken?: string; fileId?: string }
  ): UploadHandle;
  getFile(fileId: string): Promise<Record<string, unknown>>;
  listArtifacts(fileId: string): Promise<ArtifactDescriptor[]>;
  downloadUrl(fileId: string, options?: { versionId?: string }): Promise<string>;
  downloadArtifact(fileId: string, artifactId: string): Promise<string>;
  /**
   * Uploads a thumbnail or converted image made on the device as an artifact
   * of the file version, so the viewer resolves it as it resolves the ones
   * server processing makes, and server processing skips that kind. Only the
   * file's owner or a writer may; a retry replaces the same artifact.
   */
  uploadArtifact(input: UploadArtifactInput): Promise<ArtifactDescriptor>;
  resolveRenderable(input: {
    fileId: string;
    intent: RenderIntent;
    versionId?: string;
    preferLocal?: boolean;
  }): Promise<RenderDescriptor>;
  deleteFile(fileId: string): Promise<void>;
  /** A local preview of a provisional offline upload in this client's partition, or null. */
  getPendingLocalDescriptor(fileId: string): Promise<PendingLocalDescriptor | null>;
  /**
   * The durable offline queue bound to `offline.partition`. Throws
   * `FILEFN_OFFLINE_DISABLED`, `FILEFN_OFFLINE_PARTITION_REQUIRED`,
   * `FILEFN_OFFLINE_PRINCIPAL_CHECK_REQUIRED` or
   * `FILEFN_OFFLINE_GUEST_TRANSPORT_REQUIRED`. Where OPFS or Web Locks are
   * missing it still returns the queue: check `capabilities()`, since its
   * durable operations fail closed there.
   */
  getOfflineQueue(): OfflineQueue;
  /** A new, unstarted sync of this client's queue. Call `start()` to drive it and `dispose()` to stop. */
  createOfflineSync(options?: Omit<SyncConfig, 'queue' | 'store' | 'client'>): OfflineSync;
  /**
   * Stops this client's offline work: its queue and implicit sync are
   * disposed and late results are dropped. Staged work stays for a client of
   * the same partition. Call it on logout or account switch.
   */
  dispose(): void;
}

const CLIENT_ARTIFACT_KINDS: readonly ClientArtifactKind[] = [
  'thumbnail-small',
  'thumbnail-medium',
  'thumbnail-large',
  'converted',
];

/** Refuses an artifact upload the server would refuse for its shape, before any request. */
function assertUploadArtifactInput(input: UploadArtifactInput, mimeType: string): void {
  if (typeof input.fileId !== 'string' || input.fileId.length === 0) {
    throw new TypeError('uploadArtifact requires a fileId');
  }
  if (typeof input.versionId !== 'string' || input.versionId.length === 0) {
    throw new TypeError('uploadArtifact requires a versionId');
  }
  if (!CLIENT_ARTIFACT_KINDS.includes(input.kind)) {
    throw new TypeError(`uploadArtifact kind must be one of ${CLIENT_ARTIFACT_KINDS.join(', ')}`);
  }
  if (!mimeType) {
    throw new TypeError('uploadArtifact requires a mimeType when the data has no type');
  }
  if (
    input.durationMs !== undefined &&
    !(Number.isInteger(input.durationMs) && input.durationMs >= 0)
  ) {
    throw new TypeError('uploadArtifact durationMs must be a non-negative integer');
  }
}

function createAbortError(): DOMException {
  return new DOMException('Aborted', 'AbortError');
}

function createPlaceholderDescriptor(input: {
  fileId: string;
  versionId: string;
  intent: RenderIntent;
  state: 'processing' | 'unsupported' | 'pending-local';
  mimeType: string;
  name: string;
  size: number;
  placeholderKind: RenderPlaceholderKind;
  warnings?: string[];
}): RenderDescriptor {
  return {
    fileId: input.fileId,
    versionId: input.versionId,
    intent: input.intent,
    state: input.state,
    mimeType: input.mimeType,
    name: input.name,
    size: input.size,
    source: {
      mode: 'placeholder',
      placeholderKind: input.placeholderKind,
    },
    warnings: input.warnings,
  };
}

function resolvePendingLocalRenderable(
  input: { intent: RenderIntent },
  pending: PendingLocalDescriptor,
): RenderDescriptor {
  const base = {
    fileId: pending.fileId,
    versionId: pending.uploadSessionId,
    intent: input.intent,
    mimeType: pending.source.mimeType,
    name: pending.source.fileName,
    size: pending.source.size,
  } as const;

  if (input.intent === 'full' || input.intent === 'download') {
    return {
      ...base,
      state: 'pending-local',
      source: {
        mode: 'original',
        url: pending.source.url,
      },
    };
  }

  if (pending.source.previewBehavior === 'direct-image' && pending.source.kind === 'image') {
    return {
      ...base,
      state: 'pending-local',
      source: {
        mode: 'original',
        url: pending.source.url,
      },
    };
  }

  if (pending.source.previewBehavior === 'direct-pdf' && pending.source.kind === 'pdf') {
    return {
      ...base,
      state: 'pending-local',
      source: {
        mode: 'original',
        url: pending.source.url,
      },
    };
  }

  if (pending.source.kind === 'pdf' || pending.source.previewBehavior === 'deterministic-placeholder') {
    return createPlaceholderDescriptor({
      ...base,
      state: 'pending-local',
      placeholderKind: 'pdf-processing',
      warnings: ['Pending local PDF preview artifact is not available yet.'],
    });
  }

  if (pending.source.mimeType.startsWith('audio/') || pending.source.mimeType.startsWith('video/')) {
    if (input.intent === 'preview') {
      return {
        ...base,
        state: 'pending-local',
        source: {
          mode: 'original',
          url: pending.source.url,
        },
      };
    }
  }

  return createPlaceholderDescriptor({
    ...base,
    state: 'unsupported',
    placeholderKind: input.intent === 'thumbnail' ? 'generic-file' : 'unsupported-preview',
  });
}

function buildPreprocessors(config: FileFnClientConfig): UploadPreprocessor[] {
  const preprocessors: UploadPreprocessor[] = [];
  const heicEnabled = config.preprocessing?.heic?.enabled ?? true;
  if (heicEnabled) {
    preprocessors.push(createHeicPreprocessor(config.preprocessing?.heic));
  }
  if (config.preprocessing?.preprocessors?.length) {
    preprocessors.push(...config.preprocessing.preprocessors);
  }
  return preprocessors;
}

export function createFileFnClient(config: FileFnClientConfig): FileFnClient {
  const httpClient = createHttpClient(config);
  const preprocessors = buildPreprocessors(config);
  
  let offlineQueue: OfflineQueue | undefined;
  let implicitSync: OfflineSync | undefined;
  let disposed = false;

  function offlineError(code: string, message: string): Error & { code: string } {
    return Object.assign(new Error(message), { code });
  }

  function getOfflineQueue(): OfflineQueue {
    if (disposed) {
      throw offlineError('FILEFN_CLIENT_DISPOSED', 'FileFn client was disposed');
    }
    if (!config.offline?.enabled) {
      throw offlineError('FILEFN_OFFLINE_DISABLED', 'Offline uploads are disabled');
    }
    if (!config.offline.partition) {
      throw offlineError('FILEFN_OFFLINE_PARTITION_REQUIRED', 'Offline uploads need offline.partition (service and principal)');
    }
    const currentPrincipal = config.offline.currentPrincipal;
    if (typeof currentPrincipal !== 'function') {
      throw offlineError('FILEFN_OFFLINE_PRINCIPAL_CHECK_REQUIRED', 'Offline uploads need offline.currentPrincipal with offline.partition');
    }
    if (config.offline.partition.principal?.kind === 'guest' && !config.offline.uploader) {
      // The server gives anonymous callers no idempotent replay, so a lost
      // completion could never be reconciled with the built-in transport.
      throw offlineError(
        'FILEFN_OFFLINE_GUEST_TRANSPORT_REQUIRED',
        'A guest partition needs offline.uploader, a transport whose replays are idempotent',
      );
    }
    offlineQueue ??= new OfflineQueue({
      ...config.offline.queue,
      partition: config.offline.partition,
      currentPrincipal,
      legacyRootDir: config.offline.opfsDir,
      uploader: config.offline.uploader ?? builtInUploader,
    });
    return offlineQueue;
  }

  /**
   * Replays with this client's transport. Every request and retry first
   * checks that the credentials still act for the partition's principal.
   */
  const builtInUploader: OfflineQueueUploader = {
    upload: (input) => {
      // Already prepared when staged: no preprocessors run again.
      const manager = new UploadManager(createHttpClient(config, { beforeSend: input.assertPrincipal }));
      manager.bindAbortSignal(input.signal);
      return manager.startUpload(input);
    },
  };

  /** The queue for read paths: null when offline is off, unbound or unsupported here. */
  function readableOfflineQueue(): OfflineQueue | null {
    if (disposed || !config.offline?.enabled || !config.offline.partition) return null;
    try {
      const queue = getOfflineQueue();
      return queue.capabilities().durable ? queue : null;
    } catch {
      return null;
    }
  }

  /** A local read that the current principal may not make yields nothing. */
  async function readPendingLocal(queue: OfflineQueue, fileId: string): Promise<PendingLocalDescriptor | null> {
    try {
      return await queue.getPendingLocalDescriptor(fileId);
    } catch (error) {
      if (error instanceof OfflineQueueError && error.code === 'FILEFN_QUEUE_PRINCIPAL_MISMATCH') return null;
      throw error;
    }
  }

  function startImplicitReplay(queue: OfflineQueue): OfflineSync | undefined {
    if (config.offline?.implicitReplay === false || disposed || !queue.capabilities().durable) return undefined;
    if (!implicitSync) {
      implicitSync = new OfflineSync({ queue });
      implicitSync.start();
    }
    return implicitSync;
  }

  return {
    uploadFile(input: UploadInput): UploadHandleWithFileId {
      // Fail before any staging or network work, online or offline.
      assertValidExplicitFileId(input.fileId);
      assertValidIdempotencyKey(input.idempotencyKey);
      const normalizedInput: UploadInput = {
        ...input,
        fileId: input.fileId ?? generateFileId(),
      };

      if (config.offline?.enabled && shouldUseOfflineMode(true)) {
        const queue = getOfflineQueue();
        const sync = startImplicitReplay(queue);
        const uploadSessionId = generateOfflineSessionId();
        let aborted = false;
        let staged: { entryId: string; generation: number } | undefined;
        // Rejects every outstanding done() as soon as the handle is aborted.
        let rejectAborted!: (error: unknown) => void;
        const abortedPromise = new Promise<never>((_, reject) => {
          rejectAborted = reject;
        });
        void abortedPromise.catch(() => {});
        const stagePromise = (async () => {
          const prepared = await prepareUploadInput(normalizedInput, [
            ...preprocessors,
            ...(normalizedInput.preprocessors || []),
          ]);
          if (aborted) {
            throw createAbortError();
          }
          const result = await queue.stage({
            entryId: prepared.fileId,
            fileId: prepared.fileId,
            policy: prepared.policy,
            file: prepared.file,
            fileName: prepared.fileName,
            mimeType: prepared.mimeType,
            metadata: prepared.metadata,
            localSource: prepared.localSource,
            idempotencyKey: prepared.idempotencyKey,
          });
          if (result.status !== 'staged') {
            throw new OfflineQueueError('FILEFN_QUEUE_REFUSED', `Offline staging refused: ${result.reason}`, { ...result });
          }
          staged = { entryId: result.entry.entryId, generation: result.entry.generation };
          if (aborted) {
            await queue.cancel(staged.entryId, staged.generation);
            throw createAbortError();
          }
          if (sync?.isOnline()) {
            void sync.syncAll().catch(() => {});
          }
          return staged;
        })();
        void stagePromise.catch(() => {});

        const handle: UploadHandleWithFileId = {
          uploadSessionId,
          fileId: normalizedInput.fileId!,
          abort: () => {
            if (aborted) {
              return;
            }
            aborted = true;
            rejectAborted(createAbortError());
            if (staged) {
              // An unconfirmed publication refuses the cancel and stays journaled for reconciliation.
              void queue.cancel(staged.entryId, staged.generation).catch(() => {});
            }
          },
          onProgress: (_cb) => {
            // Staging progress not implemented
          },
          done: async () => {
            if (aborted) {
              throw createAbortError();
            }
            try {
              const { entryId, generation } = await Promise.race([stagePromise, abortedPromise]);
              // Settles once this generation is published, not while it is provisional.
              const settled = queue.whenSettled(entryId, generation);
              void settled.catch(() => {});
              const entry = await Promise.race([settled, abortedPromise]);
              return entry.upload ?? { fileId: entry.fileId, versionId: '' };
            } catch (error) {
              if (aborted) {
                throw createAbortError();
              }
              throw error;
            }
          }
        };

        return handle;
      }

      const manager = new UploadManager(httpClient, preprocessors);
      return manager.createHandle(
        normalizedInput,
        (handle) => manager.startUpload(normalizedInput, handle),
      ) as UploadHandleWithFileId;
    },

    resumeUpload(uploadSessionId: string, file: Blob, options?: { uploadSessionToken?: string; fileId?: string }): UploadHandle {
      const manager = new UploadManager(httpClient);
      const dummyInput: UploadInput = { policy: '', file, fileId: options?.fileId };
      return manager.createHandle(
        dummyInput,
        (handle) => manager.resumeUpload(uploadSessionId, file, options?.uploadSessionToken, handle),
        {
          uploadSessionId,
          uploadSessionToken: options?.uploadSessionToken,
          fileId: options?.fileId,
        },
      );
    },

    async getFile(fileId: string): Promise<Record<string, unknown>> {
      return httpClient.getFile(fileId);
    },

    async listArtifacts(fileId: string): Promise<ArtifactDescriptor[]> {
      return httpClient.listArtifacts(fileId);
    },

    async downloadUrl(fileId: string, options?: { versionId?: string }): Promise<string> {
      const response = await httpClient.downloadUrl(fileId, options);
      return response.url;
    },

    async downloadArtifact(fileId: string, artifactId: string): Promise<string> {
      const response = await httpClient.downloadArtifact(fileId, artifactId);
      return response.url;
    },

    async uploadArtifact(input: UploadArtifactInput): Promise<ArtifactDescriptor> {
      const mimeType = input.mimeType ?? (typeof Blob !== 'undefined' && input.data instanceof Blob ? input.data.type : '');
      assertUploadArtifactInput(input, mimeType);
      return httpClient.uploadArtifact(
        {
          fileId: input.fileId,
          versionId: input.versionId,
          kind: input.kind,
          data: input.data,
          mimeType,
          durationMs: input.durationMs,
        },
        input.signal,
      );
    },

    async resolveRenderable(input): Promise<RenderDescriptor> {
      const queue = input.preferLocal && !input.versionId ? readableOfflineQueue() : null;
      if (queue) {
        startImplicitReplay(queue);
        const pending = await readPendingLocal(queue, input.fileId);
        if (pending) {
          return resolvePendingLocalRenderable({ intent: input.intent }, pending);
        }
      }

      return httpClient.getRenderDescriptor(input.fileId, {
        intent: input.intent,
        versionId: input.versionId,
      });
    },

    async deleteFile(fileId: string): Promise<void> {
      await httpClient.deleteFile(fileId);
    },

    async getPendingLocalDescriptor(fileId: string): Promise<PendingLocalDescriptor | null> {
      const queue = readableOfflineQueue();
      if (!queue) {
        return null;
      }
      startImplicitReplay(queue);
      return readPendingLocal(queue, fileId);
    },

    getOfflineQueue,

    createOfflineSync(options = {}): OfflineSync {
      return new OfflineSync({ ...options, queue: getOfflineQueue() });
    },

    dispose(): void {
      if (disposed) {
        return;
      }
      disposed = true;
      implicitSync?.dispose();
      offlineQueue?.dispose();
    },
  };
}

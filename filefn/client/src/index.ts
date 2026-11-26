import { createHttpClient, FileFnHttpError } from './client.js';
import {
  UploadManager,
  assertValidExplicitFileId,
  assertValidIdempotencyKey,
  isValidIdempotencyKey,
  generateFileId,
  prepareUploadInput,
  replayScopeOf,
  REPLAY_SCOPE_UNCONFIRMED_ERROR,
} from './upload-manager.js';
import type {
  ArtifactDescriptor,
  ClientArtifactKind,
  FileFnClientConfig,
  PendingLocalDescriptor,
  RenderDescriptor,
  ReplayAccount,
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
import { OfflineQueue, OfflineQueueError, type OfflineQueuePrincipal, type OfflineQueueUploader } from './offline/queue.js';

export type {
  ArtifactDescriptor,
  ArtifactSource,
  ClientArtifactKind,
  UploadArtifactInput,
  FileFnClientConfig,
  ReplayAccount,
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
  OfflineQueueChannel,
  OfflineQueueCurrentPrincipal,
  OfflineQueueDirectoryHandle,
  OfflineQueueEntry,
  OfflineQueueErrorCode,
  OfflineQueueEvent,
  OfflineQueueFileHandle,
  OfflineQueueHoldResult,
  OfflineQueueHooks,
  OfflineQueueLimits,
  OfflineQueueLockCoordinator,
  OfflineQueueOperationContext,
  OfflineQueueOptions,
  OfflineQueuePartition,
  OfflineQueuePending,
  OfflineQueuePhase,
  OfflineQueuePrincipal,
  OfflineQueueProcessAllItem,
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
export { UPLOAD_SESSION_ENDED_ERROR, UPLOAD_RECONCILE_FAILED_ERROR, createUploadSessionEndedError } from './upload-manager.js';

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

/** Settles with `promise`, or rejects with AbortError once `signal` aborts. */
function raceSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new DOMException('Aborted', 'AbortError'));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

/**
 * Replays queued uploads with a snapshot of the client's transport. Every
 * request, retry and part sends only headers `authHeaders(principal)` issued
 * for the queue's own principal, resolved between two principal checks, and
 * the principal is checked again right before each request goes out.
 */
function replayUploader(
  transport: FileFnClientConfig,
  authHeaders: NonNullable<NonNullable<FileFnClientConfig['offline']>['getAuthHeaders']>,
  replayAccount: NonNullable<FileFnClientConfig['offline']>['replayAccount'],
  principal: () => OfflineQueuePrincipal,
): OfflineQueueUploader {
  return {
    // The account the partition expects. The queue journals its scope with
    // the generation's replay identity before the first request, and sends
    // nothing when a later result differs from the journaled one.
    replayScope: async (bound) => {
      const account: ReplayAccount | null = replayAccount
        ? await replayAccount(bound)
        : bound.kind === 'user'
          ? { principalId: bound.principalId, tenantId: bound.tenantId }
          : null;
      if (!account) {
        throw new OfflineQueueError('FILEFN_QUEUE_PRINCIPAL_MISMATCH', "No server account for the queue's principal");
      }
      return replayScopeOf(account);
    },
    upload: async (input) => {
      if (input.replayScope === undefined) {
        // Never sent without the journaled scope.
        throw Object.assign(new Error('The generation has no journaled replay scope'), { code: REPLAY_SCOPE_UNCONFIRMED_ERROR });
      }
      const headers = async (): Promise<Record<string, string>> => {
        await input.assertPrincipal();
        // App code that runs before a request goes out: raced with the step's
        // signal, so a disposal or cancellation with nothing sent settles the
        // step (and frees its entry) even if it never settles. A late result
        // is discarded.
        const bound = await raceSignal(Promise.resolve().then(() => authHeaders(principal())), input.signal);
        if (!bound) {
          throw new OfflineQueueError('FILEFN_QUEUE_PRINCIPAL_MISMATCH', "No credentials for the queue's principal");
        }
        await input.assertPrincipal();
        return bound;
      };
      // Already prepared when staged: no preprocessors run again.
      const manager = new UploadManager(createHttpClient(transport, { beforeSend: input.assertPrincipal, authHeaders: headers }));
      manager.bindAbortSignal(input.signal);
      // Every init, the first included, is marked as a replay and carries the
      // journaled scope: the server refuses one with no account or another,
      // creating nothing.
      return manager.startUpload(input, undefined, { scope: input.replayScope });
    },
  };
}

export function createFileFnClient(config: FileFnClientConfig): FileFnClient {
  const httpClient = createHttpClient(config);
  const preprocessors = buildPreprocessors(config);
  
  let offlineQueue: OfflineQueue | undefined;
  let implicitSync: OfflineSync | undefined;
  /** Every sync `createOfflineSync` made: disposed with the client. */
  const createdSyncs = new Set<OfflineSync>();
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
    const boundAuthHeaders = config.offline.getAuthHeaders;
    if (!config.offline.uploader && typeof boundAuthHeaders !== 'function') {
      // The client's own getAuthHeaders acts for whoever is signed in now:
      // replays would carry another account's credentials after a switch.
      throw offlineError(
        'FILEFN_OFFLINE_CREDENTIALS_REQUIRED',
        'Offline replay with the built-in transport needs offline.getAuthHeaders(principal), credentials bound to the partition',
      );
    }
    if (!offlineQueue) {
      // Captured now: later changes to `config` never redirect queued work.
      // Never ambient cookies: they act for whoever signed in last, in any
      // tab, not for the partition.
      const transport: FileFnClientConfig = {
        ...config,
        getAuthHeaders: undefined,
        offline: undefined,
        credentials: 'omit',
      };
      let queue: OfflineQueue | undefined;
      queue = new OfflineQueue({
        ...config.offline.queue,
        partition: config.offline.partition,
        currentPrincipal,
        legacyRootDir: config.offline.opfsDir,
        uploader:
          config.offline.uploader ??
          replayUploader(transport, boundAuthHeaders!, config.offline.replayAccount, () => queue!.partition.principal),
      });
      offlineQueue = queue;
    }
    return offlineQueue;
  }

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
        // The queue keeps room in the key for its own suffix: a longer key is
        // refused now, not after the handle was returned.
        if (input.idempotencyKey !== undefined && !isValidIdempotencyKey(input.idempotencyKey, 200)) {
          throw offlineError('FILEFN_INVALID_IDEMPOTENCY_KEY', 'An offline idempotencyKey must be 1-200 visible ASCII characters');
        }
        const queue = getOfflineQueue();
        const sync = startImplicitReplay(queue);
        const uploadSessionId = generateOfflineSessionId();
        const abortController = new AbortController();
        /** Settles as the abort does: the cancellation's error, else an AbortError. */
        let abortOutcome: Promise<never> | undefined;
        let notifyAbort!: () => void;
        const abortSignal = new Promise<void>((resolve) => {
          notifyAbort = resolve;
        });
        // The generation is staged under an admission hold owned by this
        // call (`stageAdmitted`): no sync, here or in another tab, runs it
        // until the call lets it go, and a call that never does (its queue
        // disposed, its tab reloaded or crashed, a principal switch refusing
        // the staging after its commit) leaves it runnable for its principal.
        // Release or cancellation is decided in the transaction that ends the
        // hold, reading the abort there: only a committed release announces
        // work, and an abort before it removes the generation unrun. An abort
        // after the release is a lock-ordered `abortStaged` request at once:
        // it removes the generation only if no tab claimed its first upload
        // step yet, and otherwise keeps it (FILEFN_QUEUE_UPLOAD_STARTED).
        let staged: { entryId: string; generation: number } | undefined;
        const stagePromise = (async () => {
          const prepared = await prepareUploadInput(normalizedInput, [
            ...preprocessors,
            ...(normalizedInput.preprocessors || []),
          ]);
          if (abortController.signal.aborted) {
            throw createAbortError();
          }
          const result = await queue.stageAdmitted(
            {
              entryId: prepared.fileId,
              fileId: prepared.fileId,
              policy: prepared.policy,
              file: prepared.file,
              fileName: prepared.fileName,
              mimeType: prepared.mimeType,
              metadata: prepared.metadata,
              localSource: prepared.localSource,
              idempotencyKey: prepared.idempotencyKey,
            },
            abortController.signal,
          );
          if (result.status === 'cancelled') throw createAbortError();
          if (result.status !== 'staged') {
            throw new OfflineQueueError('FILEFN_QUEUE_REFUSED', `Offline staging refused: ${result.reason}`, { ...result });
          }
          // Set synchronously with the return: an abort from now on requests
          // abortStaged itself.
          staged = { entryId: result.entry.entryId, generation: result.entry.generation };
          if (abortController.signal.aborted) {
            // Aborted after stageAdmitted stopped listening.
            await queue.abortStaged(staged.entryId, staged.generation);
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
            if (abortController.signal.aborted) {
              return;
            }
            const known = staged;
            abortController.abort();
            // Requested at once once the staging returned; before that, the
            // staging call itself acts on the abort and settles stagePromise
            // with its outcome.
            const requested = known
              ? queue.abortStaged(known.entryId, known.generation).then(() => {
                  throw createAbortError();
                })
              : undefined;
            abortOutcome = (requested ?? stagePromise).then(
              () => {
                throw createAbortError();
              },
              (error) => {
                throw error;
              },
            );
            void abortOutcome.catch(() => {});
            notifyAbort();
          },
          onProgress: (_cb) => {
            // Staging progress not implemented
          },
          done: async () => {
            const onAbort = abortSignal.then(() => abortOutcome!);
            void onAbort.catch(() => {});
            try {
              if (abortOutcome) return await abortOutcome;
              const { entryId, generation } = await Promise.race([stagePromise, onAbort]);
              // Settles once this generation is published, not while it is provisional.
              const settled = queue.whenSettled(entryId, generation);
              void settled.catch(() => {});
              const entry = await Promise.race([settled, onAbort]);
              return entry.upload ?? { fileId: entry.fileId, versionId: '' };
            } catch (error) {
              // The abort's outcome: its cancellation error, else an AbortError.
              if (abortController.signal.aborted) return await abortOutcome!;
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
      const sync = new OfflineSync({ ...options, queue: getOfflineQueue() });
      createdSyncs.add(sync);
      return sync;
    },

    dispose(): void {
      if (disposed) {
        return;
      }
      disposed = true;
      implicitSync?.dispose();
      for (const sync of createdSyncs) sync.dispose();
      createdSyncs.clear();
      offlineQueue?.dispose();
    },
  };
}

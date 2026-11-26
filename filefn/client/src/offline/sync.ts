import type { OPFSStore } from './opfs-store.js';
import type { OfflineQueue, OfflineQueueProcessAllItem } from './queue.js';
import { isRetryableError } from '../retry.js';

export interface UploadClient {
  uploadFile(input: {
    policy: string;
    file: File;
    metadata?: Record<string, unknown>;
    fileId?: string;
    idempotencyKey?: string;
    signal?: AbortSignal;
  }): Promise<{ fileId: string; versionId: string }>;
}

/**
 * Drives either a durable, partition-bound `queue` (recommended), or the
 * unscoped pre-0.5 `store` with its `client` (deprecated).
 */
export interface SyncConfig {
  queue?: OfflineQueue;
  store?: OPFSStore;
  client?: UploadClient;
  maxRetries?: number;
  retryDelayMs?: number;
  onSyncProgress?: (progress: SyncProgress) => void;
  onSyncComplete?: (result: SyncResult) => void;
  onSyncError?: (error: Error, uploadSessionId: string) => void;
}

export interface SyncProgress {
  totalPending: number;
  completed: number;
  failed: number;
  current: string | null;
}

export interface SyncResult {
  succeeded: string[];
  failed: string[];
  totalProcessed: number;
}

export interface ConnectivityChecker {
  isOnline(): boolean;
  onOnline(callback: () => void): () => void;
  onOffline(callback: () => void): () => void;
}

type UploadCompletionListener = (result: { fileId: string; versionId: string } | Error) => void;

type ResolvedSyncConfig = Required<Omit<SyncConfig, 'queue' | 'store' | 'client'>> & Pick<SyncConfig, 'queue' | 'store' | 'client'>;

export class OfflineSync {
  private static readonly SETTLED_RESULT_TTL_MS = 5 * 60 * 1000;
  private config: ResolvedSyncConfig;
  private isSyncing = false;
  /** Work arrived during a pass that had already listed its entries: run one more pass after it. */
  private rerunRequested = false;
  private queueRetries = 0;
  private disposed = false;
  private readonly lifetime = new AbortController();
  private connectivityChecker: ConnectivityChecker;
  private listeners: Map<string, UploadCompletionListener[]> = new Map();
  private settledResults: Map<string, { fileId: string; versionId: string } | Error> = new Map();
  private settledResultTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private stopOnlineListener?: () => void;
  private stopWorkListener?: () => void;
  private retryTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private cancelledUploads: Set<string> = new Set();
  private activeSyncControllers: Map<string, AbortController> = new Map();
  private inFlightSyncs: Map<string, Promise<{ fileId: string; versionId: string }>> = new Map();

  constructor(config: SyncConfig) {
    if (!config.queue && !(config.store && config.client)) {
      throw new TypeError('OfflineSync needs a queue, or a store and a client');
    }
    this.config = {
      maxRetries: 3,
      retryDelayMs: 1000,
      onSyncProgress: () => {},
      onSyncComplete: () => {},
      onSyncError: () => {},
      ...config,
    };

    // Default connectivity checker using browser APIs
    this.connectivityChecker = this.createDefaultConnectivityChecker();
  }

  /**
   * Starts driving the work: syncs now when online and again on each online
   * event, until `dispose`. Throws once disposed.
   */
  start(): void {
    this.startAutoSync();
  }

  /**
   * Stops driving the work for good: no further sync, retry or online
   * listener; the upload or hook this sync is running is aborted, as are
   * in-flight replays of the legacy store. A queue is otherwise left as it is
   * (dispose it separately); its staged work stays for later.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.lifetime.abort();
    this.stopAutoSync();
    for (const uploadSessionId of [...this.retryTimers.keys()]) this.clearRetry(uploadSessionId);
    for (const controller of this.activeSyncControllers.values()) controller.abort();
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  /**
   * Start listening for online events and automatically sync when online.
   */
  startAutoSync(): void {
    if (this.disposed) {
      throw new Error('OfflineSync was disposed');
    }
    this.stopAutoSync();
    this.stopOnlineListener = this.connectivityChecker.onOnline(() => this.runPass());
    // Work this tab makes runnable (a staging, a released hold) starts a pass at once.
    this.stopWorkListener = this.config.queue?.onWork(() => {
      if (this.connectivityChecker.isOnline()) this.runPass();
    });
    if (this.connectivityChecker.isOnline()) this.runPass();
  }

  /**
   * Stop listening for online events.
   */
  stopAutoSync(): void {
    this.stopOnlineListener?.();
    this.stopOnlineListener = undefined;
    this.stopWorkListener?.();
    this.stopWorkListener = undefined;
  }

  /** Starts a pass in the background; a pass that fails is reported and, for a queue, tried again later. */
  private runPass(): void {
    void this.syncAll().catch((error) => this.passFailed(error));
  }

  private passFailed(error: unknown): void {
    if (this.disposed) return;
    this.config.onSyncError(error instanceof Error ? error : new Error('Unknown error'), this.config.queue ? '*queue*' : '*sync*');
    if (this.config.queue && this.isOnline()) this.scheduleQueueRetry();
  }

  /**
   * Check if currently online.
   */
  isOnline(): boolean {
    return this.connectivityChecker.isOnline();
  }

  /**
   * Register a listener for a specific upload session completion.
   */
  waitForUpload(uploadSessionId: string): Promise<{ fileId: string; versionId: string }> {
    const settled = this.settledResults.get(uploadSessionId);
    if (settled) {
      if (settled instanceof Error) {
        return Promise.reject(settled);
      }
      return Promise.resolve(settled);
    }

    return new Promise((resolve, reject) => {
      if (!this.listeners.has(uploadSessionId)) {
        this.listeners.set(uploadSessionId, []);
      }
      this.listeners.get(uploadSessionId)!.push((result) => {
        if (result instanceof Error) {
          reject(result);
        } else {
          resolve(result);
        }
      });
    });
  }

  private notifyListeners(uploadSessionId: string, result: { fileId: string; versionId: string } | Error) {
    this.clearRetry(uploadSessionId);
    this.clearSettledResult(uploadSessionId);
    this.settledResults.set(uploadSessionId, result);
    const expiry = setTimeout(() => {
      this.clearSettledResult(uploadSessionId);
      this.settledResults.delete(uploadSessionId);
    }, OfflineSync.SETTLED_RESULT_TTL_MS);
    this.settledResultTimers.set(uploadSessionId, expiry);
    const listeners = this.listeners.get(uploadSessionId);
    if (listeners) {
      listeners.forEach(l => l(result));
      this.listeners.delete(uploadSessionId);
    }
  }

  /**
   * Sync all pending uploads.
   */
  async syncAll(): Promise<SyncResult> {
    if (this.disposed) {
      return { succeeded: [], failed: [], totalProcessed: 0 };
    }
    if (this.isSyncing) {
      // The running pass may have listed its work before this call's: a follow-up pass picks it up.
      this.rerunRequested = true;
      return { succeeded: [], failed: [], totalProcessed: 0 };
    }

    if (!this.isOnline()) {
      throw new Error('Cannot sync while offline');
    }

    this.isSyncing = true;

    try {
      if (this.config.queue) {
        return await this.syncQueue(this.config.queue);
      }
      const store = this.config.store!;
      const pendingSessionIds = await store.listPendingUploads();

      const result: SyncResult = {
        succeeded: [],
        failed: [],
        totalProcessed: 0,
      };

      const progress: SyncProgress = {
        totalPending: pendingSessionIds.length,
        completed: 0,
        failed: 0,
        current: null,
      };

      for (const uploadSessionId of pendingSessionIds) {
        if (this.disposed) break;
        if (this.cancelledUploads.has(uploadSessionId)) {
          await store.deletePendingUpload(uploadSessionId);
          continue;
        }
        progress.current = uploadSessionId;
        this.config.onSyncProgress(progress);

        try {
          const uploadResult = await this.syncOne(uploadSessionId);
          result.succeeded.push(uploadSessionId);
          progress.completed += 1;
          this.notifyListeners(uploadSessionId, uploadResult);
        } catch (error) {
          if (this.cancelledUploads.has(uploadSessionId)) {
            this.cancelledUploads.delete(uploadSessionId);
            continue;
          }
          // A disposed sync reports nothing and leaves the upload for a live one.
          if (this.disposed) break;
          const err = error instanceof Error ? error : new Error('Unknown error');
          result.failed.push(uploadSessionId);
          progress.failed += 1;
          this.config.onSyncError(err, uploadSessionId);
          if (this.disposed) break;

          // Check if we should notify listeners of failure (max retries reached)
          const pending = await store.getPendingUpload(uploadSessionId);
          if (pending && pending.retryCount >= this.config.maxRetries) {
            this.notifyListeners(uploadSessionId, err);
          } else if (pending && this.isOnline() && isRetryableError(err)) {
            this.scheduleRetry(uploadSessionId);
          } else {
            this.notifyListeners(uploadSessionId, err);
          }
        }

        result.totalProcessed += 1;
        if (this.disposed) break;
        this.config.onSyncProgress(progress);
      }

      progress.current = null;
      if (!this.disposed) this.config.onSyncComplete(result);

      return result;
    } finally {
      this.isSyncing = false;
      if (this.rerunRequested && !this.disposed) {
        this.rerunRequested = false;
        if (this.isOnline()) this.runPass();
      }
    }
  }

  /**
   * One pass over the queue's entries. Published entries succeed; a failed,
   * rejected or unconfirmed one is reported as failed and stays provisional,
   * as is an entry whose processing threw (the pass goes on to the next).
   * An unconfirmed (ambiguous) one, one that threw, one another tab was
   * processing (busy), one waiting for its principal to come back and a held
   * one (another tab may release it) are looked at again after
   * `retryDelayMs`, doubling up to a minute per retry. A generation replaced
   * during the pass (superseded) gets a follow-up pass at once, so the newer
   * one is driven even when the tab that staged it has closed. No callback
   * runs once the sync is disposed, even from inside an earlier callback.
   */
  private async syncQueue(queue: OfflineQueue): Promise<SyncResult> {
    const result: SyncResult = { succeeded: [], failed: [], totalProcessed: 0 };
    const progress: SyncProgress = { totalPending: 0, completed: 0, failed: 0, current: null };
    let outcomes: OfflineQueueProcessAllItem[];
    try {
      outcomes = await queue.processAll({ signal: this.lifetime.signal });
    } catch (error) {
      if (this.disposed) return result;
      if ((error as { code?: unknown })?.code !== 'FILEFN_QUEUE_PRINCIPAL_MISMATCH') throw error;
      // Another account is active for now: look again later.
      if (this.isOnline()) this.scheduleQueueRetry();
      return result;
    }
    progress.totalPending = outcomes.length;
    let retry = false;
    for (const item of outcomes) {
      if (this.disposed) return result;
      const { entryId } = item;
      let failure: Error | undefined;
      if ('error' in item) {
        retry = true;
        failure = item.error;
      } else {
        const outcome = item.result;
        if (outcome.status === 'busy') {
          // Another tab holds it; if that tab closes, a later pass takes over.
          retry = true;
          continue;
        }
        if (outcome.status === 'superseded') {
          this.rerunRequested = true;
          continue;
        }
        if (outcome.status === 'stopped') {
          retry ||= outcome.reason === 'principal-mismatch';
          continue;
        }
        if (outcome.status === 'provisional' && outcome.reason === 'held') {
          retry = true;
          continue;
        }
        if (outcome.status === 'published') {
          result.succeeded.push(entryId);
          progress.completed += 1;
        } else if (outcome.status === 'provisional') {
          retry ||= outcome.reason === 'ambiguous';
          const message = outcome.entry.error?.message ?? outcome.entry.pending?.message ?? outcome.reason;
          failure = Object.assign(new Error(message), { code: outcome.reason });
        } else {
          continue;
        }
      }
      if (failure) {
        result.failed.push(entryId);
        progress.failed += 1;
        this.config.onSyncError(failure, entryId);
        if (this.disposed) return result;
      }
      result.totalProcessed += 1;
      progress.current = entryId;
      this.config.onSyncProgress(progress);
    }
    progress.current = null;
    if (this.disposed) return result;
    this.config.onSyncComplete(result);
    if (!retry) this.queueRetries = 0;
    else if (this.isOnline() && !this.disposed) this.scheduleQueueRetry();
    return result;
  }

  private scheduleQueueRetry(): void {
    const key = '*queue*';
    if (this.retryTimers.has(key) || this.disposed) return;
    const delay = Math.min(this.config.retryDelayMs * 2 ** this.queueRetries, 60_000);
    this.queueRetries += 1;
    const timer = setTimeout(() => {
      this.retryTimers.delete(key);
      this.runPass();
    }, delay);
    this.retryTimers.set(key, timer);
  }

  /**
   * Sync a single pending upload of the legacy store.
   */
  async syncOne(uploadSessionId: string): Promise<{ fileId: string; versionId: string }> {
    const store = this.legacyStore();
    if (this.disposed) {
      throw new DOMException('Aborted', 'AbortError');
    }
    const existing = this.inFlightSyncs.get(uploadSessionId);
    if (existing) {
      return existing;
    }

    const task = (async () => {
      const pendingUpload = await store.getPendingUpload(uploadSessionId);

      if (!pendingUpload) {
        throw new Error(`Pending upload ${uploadSessionId} not found`);
      }
      // Disposed while reading: nothing is sent, the upload stays for a live sync.
      if (this.disposed) {
        throw new DOMException('Aborted', 'AbortError');
      }

      if (pendingUpload.retryCount >= this.config.maxRetries) {
        throw new Error(`Max retries exceeded for ${uploadSessionId}`);
      }

      try {
        const controller = new AbortController();
        this.activeSyncControllers.set(uploadSessionId, controller);
        const file = new File([pendingUpload.fileData], pendingUpload.fileName, {
          type: pendingUpload.mimeType,
        });

        const result = await this.config.client!.uploadFile({
          policy: pendingUpload.policy,
          file,
          metadata: pendingUpload.metadata,
          fileId: pendingUpload.fileId,
          idempotencyKey: pendingUpload.idempotencyKey,
          signal: controller.signal,
        });

        if (this.disposed) {
          // A disposed sync records nothing: the next one replays under the same key.
          throw new DOMException('Aborted', 'AbortError');
        }
        await store.deletePendingUpload(uploadSessionId);
        return result;
      } catch (error) {
        if (this.cancelledUploads.has(uploadSessionId) || (error instanceof DOMException && error.name === 'AbortError')) {
          throw error;
        }
        await store.incrementRetryCount(uploadSessionId);
        throw error;
      } finally {
        this.activeSyncControllers.delete(uploadSessionId);
      }
    })();

    this.inFlightSyncs.set(uploadSessionId, task);
    try {
      return await task;
    } finally {
      if (this.inFlightSyncs.get(uploadSessionId) === task) {
        this.inFlightSyncs.delete(uploadSessionId);
      }
    }
  }

  /**
   * Manually trigger sync for a specific upload.
   */
  async syncUpload(uploadSessionId: string): Promise<void> {
    if (this.disposed || this.cancelledUploads.has(uploadSessionId)) {
      return;
    }
    if (!this.isOnline()) {
      throw new Error('Cannot sync while offline');
    }

    try {
      const result = await this.syncOne(uploadSessionId);
      this.notifyListeners(uploadSessionId, result);
    } catch (error) {
      if (this.cancelledUploads.has(uploadSessionId)) {
        this.cancelledUploads.delete(uploadSessionId);
        return;
      }
      const err = error instanceof Error ? error : new Error('Unknown error');
      const pending = await this.legacyStore().getPendingUpload(uploadSessionId);
      if (pending && pending.retryCount >= this.config.maxRetries) {
        this.notifyListeners(uploadSessionId, err);
        return;
      }
      if (pending && this.isOnline() && isRetryableError(err)) {
        this.scheduleRetry(uploadSessionId);
        return;
      }
      this.notifyListeners(uploadSessionId, err);
    }
  }

  /**
   * Set a custom connectivity checker.
   */
  setConnectivityChecker(checker: ConnectivityChecker): void {
    this.connectivityChecker = checker;
  }

  async cancelUpload(uploadSessionId: string, reason: Error = new DOMException('Aborted', 'AbortError')): Promise<void> {
    this.cancelledUploads.add(uploadSessionId);
    this.clearRetry(uploadSessionId);
    this.activeSyncControllers.get(uploadSessionId)?.abort();
    this.notifyListeners(uploadSessionId, reason);
    await this.legacyStore().deletePendingUpload(uploadSessionId);
  }

  private legacyStore(): OPFSStore {
    if (!this.config.store || !this.config.client) {
      throw new Error('This OfflineSync drives a queue: use the queue for per-entry calls');
    }
    return this.config.store;
  }

  private scheduleRetry(uploadSessionId: string): void {
    if (this.disposed || this.retryTimers.has(uploadSessionId)) {
      return;
    }

    const timer = setTimeout(() => {
      this.retryTimers.delete(uploadSessionId);
      void this.syncUpload(uploadSessionId).catch((error) => {
        const err = error instanceof Error ? error : new Error('Unknown error');
        this.config.onSyncError(err, uploadSessionId);
      });
    }, this.config.retryDelayMs);
    this.retryTimers.set(uploadSessionId, timer);
  }

  private clearRetry(uploadSessionId: string): void {
    const timer = this.retryTimers.get(uploadSessionId);
    if (!timer) {
      return;
    }
    clearTimeout(timer);
    this.retryTimers.delete(uploadSessionId);
  }

  private clearSettledResult(uploadSessionId: string): void {
    const timer = this.settledResultTimers.get(uploadSessionId);
    if (!timer) {
      return;
    }
    clearTimeout(timer);
    this.settledResultTimers.delete(uploadSessionId);
  }

  private createDefaultConnectivityChecker(): ConnectivityChecker {
    return {
      isOnline: () => {
        if (typeof navigator !== 'undefined' && 'onLine' in navigator) {
          return navigator.onLine;
        }
        return true; // Assume online if can't detect
      },
      onOnline: (callback: () => void) => {
        if (typeof window !== 'undefined') {
          window.addEventListener('online', callback);
        }
        return () => {
          if (typeof window !== 'undefined') {
            window.removeEventListener('online', callback);
          }
        };
      },
      onOffline: (callback: () => void) => {
        if (typeof window !== 'undefined') {
          window.addEventListener('offline', callback);
        }
        return () => {
          if (typeof window !== 'undefined') {
            window.removeEventListener('offline', callback);
          }
        };
      },
    };
  }
}

/**
 * Check if offline mode is currently needed.
 */
export function shouldUseOfflineMode(isOfflineEnabled: boolean): boolean {
  if (!isOfflineEnabled) return false;

  // Check if online
  if (typeof navigator !== 'undefined' && 'onLine' in navigator) {
    return !navigator.onLine;
  }

  return false;
}

/**
 * Generate a unique upload session ID for offline staging.
 */
export function generateOfflineSessionId(): string {
  return `offline_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
}

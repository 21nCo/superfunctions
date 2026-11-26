import { OfflineQueueError, type OfflineQueue, type OfflineQueueProcessAllItem } from './queue.js';

/** @deprecated The unscoped `OfflineSync({ store, client })` form is refused; kept so existing imports compile. */
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
 * Drives a durable, partition-bound `queue`. The pre-0.5 form over an
 * unscoped `store` and its `client` is refused with
 * `FILEFN_QUEUE_LEGACY_UNSCOPED` and leaves every record in place: those
 * uploads belong to no known principal, so nothing replays them
 * automatically. Migrate each with `OfflineQueue.migrateLegacyUpload` once
 * the app has independent ownership evidence.
 */
export interface SyncConfig {
  queue: OfflineQueue;
  /** @deprecated Refused (`FILEFN_QUEUE_LEGACY_UNSCOPED`): unscoped records are never replayed automatically. */
  store?: never;
  /** @deprecated Refused (`FILEFN_QUEUE_LEGACY_UNSCOPED`), together with `store`. */
  client?: never;
  /** @deprecated Unused: the queue's `maxUploadAttempts` limits uploads. */
  maxRetries?: number;
  retryDelayMs?: number;
  /**
   * With a queue: while started and online, how long after a pass that left
   * nothing to retry the next pass runs anyway (default 30000; 0 turns it
   * off). It finds work no wakeup announced, such as an entry another tab
   * claimed and left when it closed.
   */
  idlePollMs?: number;
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

type ResolvedSyncConfig = Required<Omit<SyncConfig, 'store' | 'client'>>;

export class OfflineSync {
  private config: ResolvedSyncConfig;
  private isSyncing = false;
  /** Started (`start`/`startAutoSync`) and not stopped since. */
  private autoSyncing = false;
  /** Work arrived during a pass that had already listed its entries: run one more pass after it. */
  private rerunRequested = false;
  private queueRetries = 0;
  private disposed = false;
  private readonly lifetime = new AbortController();
  private connectivityChecker: ConnectivityChecker;
  private stopOnlineListener?: () => void;
  private stopWorkListener?: () => void;
  private stopQueueDisposeListener?: () => void;
  private retryTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();

  constructor(config: SyncConfig) {
    const legacy = config as { store?: unknown; client?: unknown };
    if (legacy.store !== undefined || legacy.client !== undefined) {
      // Nothing is listed, read, sent or removed: the records stay for an explicit migration.
      throw new OfflineQueueError(
        'FILEFN_QUEUE_LEGACY_UNSCOPED',
        'OfflineSync no longer replays the unscoped pre-0.5 store: migrate its uploads with OfflineQueue.migrateLegacyUpload once you can prove whose they are',
      );
    }
    if (!config.queue) {
      throw new TypeError('OfflineSync needs a queue');
    }
    this.config = {
      maxRetries: 3,
      retryDelayMs: 1000,
      idlePollMs: 30_000,
      onSyncProgress: () => {},
      onSyncComplete: () => {},
      onSyncError: () => {},
      ...config,
    };

    // Default connectivity checker using browser APIs
    this.connectivityChecker = this.createDefaultConnectivityChecker();
    // The queue's disposal disposes this sync at once: its online listener,
    // idle poll and retry timers go with it, without waiting for an event.
    this.stopQueueDisposeListener = config.queue.onDispose(() => this.dispose());
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
   * listener; the upload or hook this sync is running is aborted. A queue is
   * otherwise left as it is (dispose it separately); its staged work stays
   * for later.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.lifetime.abort();
    this.stopQueueDisposeListener?.();
    this.stopQueueDisposeListener = undefined;
    this.stopAutoSync();
    for (const key of [...this.retryTimers.keys()]) this.clearRetry(key);
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  /**
   * Start listening for online events and automatically sync when online.
   */
  startAutoSync(): void {
    // A disposed queue disposes this sync (stopped()) before anything is registered.
    if (this.stopped()) {
      throw new Error('OfflineSync was disposed');
    }
    this.stopAutoSync();
    try {
      // Work this tab makes runnable (a staging, a released hold) starts a pass at once.
      this.stopWorkListener = this.config.queue.onWork(() => {
        if (this.connectivityChecker.isOnline()) this.runPass();
      });
      this.stopOnlineListener = this.connectivityChecker.onOnline(() => this.runPass());
    } catch (error) {
      // Nothing of a failed start stays registered.
      this.stopAutoSync();
      if (this.config.queue.isDisposed) this.dispose();
      throw error;
    }
    this.autoSyncing = true;
    if (this.connectivityChecker.isOnline()) this.runPass();
  }

  /**
   * Stop listening for online events.
   */
  stopAutoSync(): void {
    this.autoSyncing = false;
    this.clearRetry('*idle*');
    this.stopOnlineListener?.();
    this.stopOnlineListener = undefined;
    this.stopWorkListener?.();
    this.stopWorkListener = undefined;
  }

  /** Starts a pass in the background; a pass that fails is reported and tried again later. */
  private runPass(): void {
    void this.syncAll().catch((error) => this.passFailed(error)).catch(() => {});
  }

  private async passFailed(error: unknown): Promise<void> {
    if (this.stopped()) return;
    if (this.queueGone(error)) return;
    // A failed pass of a queue whose principal is no longer current is retried, not reported.
    // Raced with this sync's lifetime: a stalled check cannot hold a disposed sync.
    const reportable = await this.config.queue.principalIsCurrent(this.lifetime.signal).catch(() => false);
    if (this.stopped()) return;
    if (!reportable) {
      if (this.isOnline()) this.scheduleQueueRetry();
      return;
    }
    this.config.onSyncError(error instanceof Error ? error : new Error('Unknown error'), '*queue*');
    if (this.isOnline()) this.scheduleQueueRetry();
  }

  /**
   * Check if currently online.
   */
  isOnline(): boolean {
    return this.connectivityChecker.isOnline();
  }

  /**
   * Sync all pending uploads.
   */
  async syncAll(): Promise<SyncResult> {
    if (this.stopped()) {
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
      return await this.syncQueue(this.config.queue);
    } finally {
      this.isSyncing = false;
      if (this.rerunRequested && !this.stopped()) {
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
   * The principal is checked before each callback and before the summary is
   * returned: once a callback (or anything else) switched the account, no
   * further callback runs, the pass returns an empty summary with none of
   * the old principal's entry IDs, and it is looked at again later (the old
   * principal may come back).
   */
  private async syncQueue(queue: OfflineQueue): Promise<SyncResult> {
    const result: SyncResult = { succeeded: [], failed: [], totalProcessed: 0 };
    const progress: SyncProgress = { totalPending: 0, completed: 0, failed: 0, current: null };
    let outcomes: OfflineQueueProcessAllItem[];
    try {
      outcomes = await queue.processAll({ signal: this.lifetime.signal });
    } catch (error) {
      if (this.stopped() || this.queueGone(error)) return result;
      if ((error as { code?: unknown })?.code !== 'FILEFN_QUEUE_PRINCIPAL_MISMATCH') throw error;
      // Another account is active for now: look again later.
      if (this.isOnline() && !this.stopped()) this.scheduleQueueRetry();
      return result;
    }
    progress.totalPending = outcomes.length;
    let retry = false;
    // Before a callback or the summary: still running, and still the partition's principal.
    const mayReport = async (): Promise<boolean> => {
      if (this.stopped()) return false;
      // Raced with this sync's lifetime: a stalled `currentPrincipal` cannot
      // hold a disposed sync (the check settles false and nothing is reported).
      const current = await queue.principalIsCurrent(this.lifetime.signal);
      if (this.stopped()) return false;
      if (current) return true;
      if (this.isOnline()) this.scheduleQueueRetry();
      return false;
    };
    const withheld = (): SyncResult => ({ succeeded: [], failed: [], totalProcessed: 0 });
    for (const item of outcomes) {
      if (this.stopped()) return withheld();
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
          retry ||= outcome.reason === 'ambiguous' || outcome.reason === 'scope-unconfirmed';
          const message = outcome.entry.error?.message ?? outcome.entry.pending?.message ?? outcome.reason;
          failure = Object.assign(new Error(message), { code: outcome.reason });
        } else {
          continue;
        }
      }
      if (failure) {
        result.failed.push(entryId);
        progress.failed += 1;
        if (!(await mayReport())) return withheld();
        this.config.onSyncError(failure, entryId);
      }
      result.totalProcessed += 1;
      progress.current = entryId;
      if (!(await mayReport())) return withheld();
      this.config.onSyncProgress({ ...progress });
    }
    progress.current = null;
    if (!(await mayReport())) return withheld();
    this.config.onSyncComplete({ succeeded: [...result.succeeded], failed: [...result.failed], totalProcessed: result.totalProcessed });
    if (!(await mayReport())) return withheld();
    if (!retry) {
      this.queueRetries = 0;
      this.scheduleIdlePoll();
    } else if (this.isOnline() && !this.stopped()) this.scheduleQueueRetry();
    return result;
  }

  /**
   * Whether this sync is done driving work: disposed, or its queue was
   * disposed (even from inside one of this sync's callbacks), which disposes
   * the sync too. Checked before every callback and every timer.
   */
  private stopped(): boolean {
    if (this.disposed) return true;
    if (!this.config.queue.isDisposed) return false;
    this.dispose();
    return true;
  }

  /**
   * A disposed queue ends this sync for good: it disposes itself, silently,
   * instead of reporting and retrying a queue that can never run again.
   */
  private queueGone(error: unknown): boolean {
    if ((error as { code?: unknown })?.code !== 'FILEFN_QUEUE_DISPOSED' || !this.config.queue.isDisposed) return false;
    this.dispose();
    return true;
  }

  private scheduleIdlePoll(): void {
    const key = '*idle*';
    const delay = this.config.idlePollMs;
    if (!this.autoSyncing || this.stopped() || !(delay > 0) || this.retryTimers.has(key) || this.retryTimers.has('*queue*')) return;
    if (!this.isOnline()) return;
    const timer = setTimeout(() => {
      this.retryTimers.delete(key);
      if (this.autoSyncing && this.isOnline()) this.runPass();
    }, delay);
    this.retryTimers.set(key, timer);
  }

  private scheduleQueueRetry(): void {
    const key = '*queue*';
    if (this.retryTimers.has(key) || this.stopped()) return;
    const delay = Math.min(this.config.retryDelayMs * 2 ** this.queueRetries, 60_000);
    this.queueRetries += 1;
    const timer = setTimeout(() => {
      this.retryTimers.delete(key);
      this.runPass();
    }, delay);
    this.retryTimers.set(key, timer);
  }

  /**
   * Set a custom connectivity checker.
   */
  setConnectivityChecker(checker: ConnectivityChecker): void {
    this.connectivityChecker = checker;
  }

  private clearRetry(uploadSessionId: string): void {
    const timer = this.retryTimers.get(uploadSessionId);
    if (!timer) {
      return;
    }
    clearTimeout(timer);
    this.retryTimers.delete(uploadSessionId);
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

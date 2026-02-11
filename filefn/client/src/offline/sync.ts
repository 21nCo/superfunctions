import type { OPFSStore, PendingUpload } from './opfs-store.js';

export interface UploadClient {
  uploadFile(input: {
    policy: string;
    file: File;
    metadata?: Record<string, unknown>;
  }): Promise<{ fileId: string; versionId: string }>;
}

export interface SyncConfig {
  store: OPFSStore;
  client: UploadClient;
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
  onOnline(callback: () => void): void;
  onOffline(callback: () => void): void;
}

type UploadCompletionListener = (result: { fileId: string; versionId: string } | Error) => void;

export class OfflineSync {
  private config: Required<SyncConfig>;
  private isSyncing = false;
  private connectivityChecker: ConnectivityChecker;
  private listeners: Map<string, UploadCompletionListener[]> = new Map();

  constructor(config: SyncConfig) {
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
   * Start listening for online events and automatically sync when online.
   */
  startAutoSync(): void {
    this.connectivityChecker.onOnline(async () => {
      await this.syncAll();
    });
  }

  /**
   * Stop listening for online events.
   */
  stopAutoSync(): void {
    // Placeholder
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
    if (this.isSyncing) {
      // Return a promise that resolves when current sync finishes? 
      // For simplicity, throw or ignore.
      return { succeeded: [], failed: [], totalProcessed: 0 };
    }

    if (!this.isOnline()) {
      throw new Error('Cannot sync while offline');
    }

    this.isSyncing = true;

    try {
      const pendingSessionIds = await this.config.store.listPendingUploads();

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
        progress.current = uploadSessionId;
        this.config.onSyncProgress(progress);

        try {
          const uploadResult = await this.syncOne(uploadSessionId);
          result.succeeded.push(uploadSessionId);
          progress.completed += 1;
          this.notifyListeners(uploadSessionId, uploadResult);
        } catch (error) {
          const err = error instanceof Error ? error : new Error('Unknown error');
          result.failed.push(uploadSessionId);
          progress.failed += 1;
          this.config.onSyncError(err, uploadSessionId);
          
          // Check if we should notify listeners of failure (max retries reached)
          const pending = await this.config.store.getPendingUpload(uploadSessionId);
          if (pending && pending.retryCount >= this.config.maxRetries) {
             this.notifyListeners(uploadSessionId, err);
          }
        }

        result.totalProcessed += 1;
        this.config.onSyncProgress(progress);
      }

      progress.current = null;
      this.config.onSyncComplete(result);

      return result;
    } finally {
      this.isSyncing = false;
    }
  }

  /**
   * Sync a single pending upload.
   */
  async syncOne(uploadSessionId: string): Promise<{ fileId: string; versionId: string }> {
    const pendingUpload = await this.config.store.getPendingUpload(uploadSessionId);

    if (!pendingUpload) {
      throw new Error(`Pending upload ${uploadSessionId} not found`);
    }

    // Check retry limit
    if (pendingUpload.retryCount >= this.config.maxRetries) {
      throw new Error(`Max retries exceeded for ${uploadSessionId}`);
    }

    try {
      // Convert ArrayBuffer back to File
      const file = new File([pendingUpload.fileData], pendingUpload.fileName, {
        type: pendingUpload.mimeType,
      });

      // Upload the file
      const result = await this.config.client.uploadFile({
        policy: pendingUpload.policy,
        file,
        metadata: pendingUpload.metadata,
      });

      // Delete from store on success
      await this.config.store.deletePendingUpload(uploadSessionId);
      
      return result;
    } catch (error) {
      // Increment retry count
      await this.config.store.incrementRetryCount(uploadSessionId);
      throw error;
    }
  }

  /**
   * Manually trigger sync for a specific upload.
   */
  async syncUpload(uploadSessionId: string): Promise<void> {
    if (!this.isOnline()) {
      throw new Error('Cannot sync while offline');
    }

    const result = await this.syncOne(uploadSessionId);
    this.notifyListeners(uploadSessionId, result);
  }

  /**
   * Set a custom connectivity checker.
   */
  setConnectivityChecker(checker: ConnectivityChecker): void {
    this.connectivityChecker = checker;
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
      },
      onOffline: (callback: () => void) => {
        if (typeof window !== 'undefined') {
          window.addEventListener('offline', callback);
        }
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
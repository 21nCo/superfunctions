import { indexedDB as fakeIndexedDB, IDBKeyRange as fakeIDBKeyRange } from 'fake-indexeddb';
import type { TestRun, TestResult, Artifact } from '../types.js';

const STORE_NAMES = {
  runs: 'testfn_runs',
  results: 'testfn_results',
  artifacts: 'testfn_artifacts',
  metadata: 'testfn_metadata'
} as const;

type StoreName = typeof STORE_NAMES[keyof typeof STORE_NAMES];
type TransactionMode = 'readonly' | 'readwrite';

interface StorageInitOptions {
  dbName: string;
  version?: number;
}

function getIndexedDB(): IDBFactory {
  if (typeof indexedDB !== 'undefined') {
    return indexedDB;
  }
  if (typeof fakeIndexedDB !== 'undefined') {
    return fakeIndexedDB as IDBFactory;
  }
  throw new Error('IndexedDB is not available');
}

function getIDBKeyRange(): typeof IDBKeyRange {
  if (typeof IDBKeyRange !== 'undefined') {
    return IDBKeyRange;
  }
  return fakeIDBKeyRange as typeof IDBKeyRange;
}

export class IndexedDbManager {
  private options: Required<StorageInitOptions>;
  private db?: IDBDatabase;

  constructor(options: StorageInitOptions) {
    this.options = {
      dbName: options.dbName,
      version: options.version ?? 1
    };
  }

  async open(): Promise<void> {
    if (this.db) return;

    const factory = getIndexedDB();
    const request = factory.open(this.options.dbName, this.options.version);

    request.onupgradeneeded = () => {
      const database = request.result;

      this.ensureObjectStore(database, STORE_NAMES.runs, {
        keyPath: 'id',
        autoIncrement: false
      });

      if (!database.objectStoreNames.contains(STORE_NAMES.runs)) {
        return;
      }

      const runsStore = request.transaction!.objectStore(STORE_NAMES.runs);
      if (!runsStore.indexNames.contains('timestamp')) {
        runsStore.createIndex('timestamp', 'timestamp', { unique: false });
      }
      if (!runsStore.indexNames.contains('branch')) {
        runsStore.createIndex('branch', 'branch', { unique: false });
      }

      this.ensureObjectStore(database, STORE_NAMES.results, {
        keyPath: ['runId', 'id'],
        autoIncrement: false
      });

      this.ensureObjectStore(database, STORE_NAMES.artifacts, {
        keyPath: 'id',
        autoIncrement: false
      });

      this.ensureObjectStore(database, STORE_NAMES.metadata, {
        keyPath: 'key',
        autoIncrement: false
      });
    };

    this.db = await new Promise<IDBDatabase>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('Failed to open IndexedDB'));
    });
  }

  private ensureObjectStore(
    database: IDBDatabase,
    name: StoreName,
    options: IDBObjectStoreParameters
  ) {
    if (database.objectStoreNames.contains(name)) return;
    database.createObjectStore(name, options);
  }

  private assertDb(): IDBDatabase {
    if (!this.db) {
      throw new Error('IndexedDB database is not open');
    }
    return this.db;
  }

  async close(): Promise<void> {
    if (this.db) {
      this.db.close();
      this.db = undefined;
    }
  }

  async deleteDatabase(): Promise<void> {
    await this.close();
    const factory = getIndexedDB();
    await new Promise<void>((resolve, reject) => {
      const request = factory.deleteDatabase(this.options.dbName);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(new Error('Failed to delete IndexedDB'));
    });
  }

  private async withTransaction<T>(
    stores: StoreName[],
    mode: TransactionMode,
    fn: (tx: IDBTransaction) => Promise<T>
  ): Promise<T> {
    const database = this.assertDb();
    const tx = database.transaction(stores, mode);

    const completionPromise = new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(new Error('IndexedDB transaction failed'));
    });

    let result: T;
    try {
      result = await fn(tx);
    } catch (error) {
      try {
        tx.abort();
      } catch {}
      throw error;
    }

    await completionPromise;
    return result;
  }

  private requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
    });
  }

  async putRun(run: TestRun): Promise<void> {
    await this.withTransaction([STORE_NAMES.runs], 'readwrite', async (tx) => {
      const store = tx.objectStore(STORE_NAMES.runs);
      await this.requestToPromise(store.put(run));
    });
  }

  async getRun(id: string): Promise<TestRun | null> {
    return this.withTransaction([STORE_NAMES.runs], 'readonly', async (tx) => {
      const store = tx.objectStore(STORE_NAMES.runs);
      const result = await this.requestToPromise<TestRun | undefined>(store.get(id));
      return result ?? null;
    });
  }

  async getRecentRuns(limit: number): Promise<TestRun[]> {
    return this.withTransaction([STORE_NAMES.runs], 'readonly', async (tx) => {
      const store = tx.objectStore(STORE_NAMES.runs);
      const index = store.index('timestamp');
      const KeyRange = getIDBKeyRange();
      const range = KeyRange.upperBound(Date.now());
      const request = index.openCursor(range, 'prev');
      
      const runs: TestRun[] = [];
      
      return new Promise((resolve, reject) => {
        request.onsuccess = (event) => {
          const cursor = (event.target as IDBRequest).result as IDBCursorWithValue;
          if (cursor && runs.length < limit) {
            runs.push(cursor.value as TestRun);
            cursor.continue();
          } else {
            resolve(runs);
          }
        };
        request.onerror = () => reject(request.error);
      });
    });
  }

  async putResult(runId: string, result: TestResult): Promise<void> {
    await this.withTransaction([STORE_NAMES.results], 'readwrite', async (tx) => {
      const store = tx.objectStore(STORE_NAMES.results);
      await this.requestToPromise(store.put({ ...result, runId }));
    });
  }

  async getTestHistory(testId: string, limit: number): Promise<TestResult[]> {
    return this.withTransaction([STORE_NAMES.results], 'readonly', async (tx) => {
      const store = tx.objectStore(STORE_NAMES.results);
      const request = store.openCursor();
      
      const results: TestResult[] = [];
      
      return new Promise((resolve, reject) => {
        request.onsuccess = (event) => {
          const cursor = (event.target as IDBRequest).result as IDBCursorWithValue;
          if (cursor && results.length < limit) {
            const value = cursor.value as TestResult & { runId: string };
            if (value.id === testId) {
              results.push(value);
            }
            cursor.continue();
          } else {
            resolve(results);
          }
        };
        request.onerror = () => reject(request.error);
      });
    });
  }

  async putArtifact(artifact: Artifact & { id: string; runId: string; testId: string }): Promise<void> {
    await this.withTransaction([STORE_NAMES.artifacts], 'readwrite', async (tx) => {
      const store = tx.objectStore(STORE_NAMES.artifacts);
      await this.requestToPromise(store.put(artifact));
    });
  }

  async getArtifact(id: string): Promise<Artifact | null> {
    return this.withTransaction([STORE_NAMES.artifacts], 'readonly', async (tx) => {
      const store = tx.objectStore(STORE_NAMES.artifacts);
      const result = await this.requestToPromise<Artifact | undefined>(store.get(id));
      return result ?? null;
    });
  }

  async cleanup(retentionDays: number): Promise<void> {
    const cutoffTimestamp = Date.now() - (retentionDays * 24 * 60 * 60 * 1000);
    
    await this.withTransaction([STORE_NAMES.runs, STORE_NAMES.results, STORE_NAMES.artifacts], 'readwrite', async (tx) => {
      const runsStore = tx.objectStore(STORE_NAMES.runs);
      const index = runsStore.index('timestamp');
      const KeyRange = getIDBKeyRange();
      const range = KeyRange.upperBound(cutoffTimestamp);
      const request = index.openCursor(range);
      
      const oldRunIds: string[] = [];
      
      await new Promise<void>((resolve, reject) => {
        request.onsuccess = async (event) => {
          const cursor = (event.target as IDBRequest).result as IDBCursorWithValue;
          if (cursor) {
            const run = cursor.value as TestRun;
            oldRunIds.push(run.id);
            await this.requestToPromise(cursor.delete());
            cursor.continue();
          } else {
            resolve();
          }
        };
        request.onerror = () => reject(request.error);
      });
    });
  }
}

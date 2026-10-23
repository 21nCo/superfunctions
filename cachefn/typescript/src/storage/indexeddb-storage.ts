/** IndexedDB storage backend. Entry metadata is the authoritative tag index. */
import type { StorageBackend, EntryMetadata } from "./storage-interface.js";
import { isExpired } from "../strategies/ttl-manager.js";
import { filterByPattern } from "../utils/pattern.js";

export interface IndexedDBStorageConfig { name: string; version?: number }
interface IndexedDBEntry<T> { key: string; value: T; metadata: EntryMetadata }

export class IndexedDBStorage<T = any> implements StorageBackend<T> {
  private dbName: string;
  private version: number;
  private db: IDBDatabase | null = null;
  private initPromise: Promise<void> | null = null;

  constructor(config: IndexedDBStorageConfig) {
    this.dbName = `cachefn-${config.name}`;
    this.version = config.version ?? 1;
  }

  /** Release this connection; a subsequent operation opens it again. */
  close(): void { this.db?.close(); this.db = null; }

  private async init(): Promise<void> {
    if (this.db) return;
    if (!this.initPromise) {
      this.initPromise = new Promise<void>((resolve, reject) => {
        const request = indexedDB.open(this.dbName, this.version);
        let blocked = false;
        request.onerror = () => reject(request.error);
        request.onblocked = () => {
          blocked = true;
          reject(new Error("IndexedDB upgrade blocked by another open connection"));
        };
        request.onsuccess = () => {
          const db = request.result;
          if (blocked) { db.close(); return; }
          this.db = db;
          db.onversionchange = () => { db.close(); this.db = null; };
          db.onclose = () => { if (this.db === db) this.db = null; };
          resolve();
        };
        request.onupgradeneeded = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains("entries")) {
            const store = db.createObjectStore("entries", { keyPath: "key" });
            store.createIndex("expiresAt", "metadata.expiresAt", { unique: false });
          }
        };
      }).finally(() => { this.initPromise = null; });
    }
    return this.initPromise;
  }

  /** Resolve only after commit; errors in request callbacks explicitly abort. */
  private async transaction<R>(
    initial: R,
    operation: (store: IDBObjectStore, result: (value: R) => void,
      guard: (callback: () => void) => () => void) => void,
  ): Promise<R> {
    await this.init();
    return new Promise<R>((resolve, reject) => {
      const tx = this.db!.transaction("entries", "readwrite");
      let value = initial;
      let failure: unknown;
      const guard = (callback: () => void) => () => {
        try { callback(); } catch (error) {
          failure = error;
          tx.abort();
        }
      };
      tx.oncomplete = () => resolve(value);
      tx.onabort = () => reject(failure ?? tx.error ?? new Error("IndexedDB transaction aborted"));
      // Request errors bubble and abort the transaction by default.
      tx.onerror = () => { failure ??= tx.error; };
      guard(() => operation(tx.objectStore("entries"), (next) => { value = next; }, guard))();
    });
  }

  private expired(entry: IndexedDBEntry<T>): boolean {
    return isExpired({ key: entry.key, value: entry.value, ...entry.metadata });
  }

  private async read<R>(key: string, initial: R,
    visit: (entry: IndexedDBEntry<T>, store: IDBObjectStore) => R): Promise<R> {
    return this.transaction(initial, (store, result, guard) => {
      const request = store.get(key);
      request.onsuccess = guard(() => {
        const entry = request.result as IndexedDBEntry<T> | undefined;
        if (!entry) return;
        if (this.expired(entry)) { store.delete(key); return; }
        result(visit(entry, store));
      });
    });
  }

  async get(key: string): Promise<T | undefined> {
    return this.read<T | undefined>(key, undefined, (entry, store) => {
      entry.metadata.hits++;
      entry.metadata.lastAccess = Date.now();
      store.put(entry);
      return entry.value;
    });
  }

  async set(key: string, value: T, metadata: EntryMetadata): Promise<void> {
    return this.transaction(undefined, (store) => {
      store.put({ key, value, metadata });
    });
  }

  async has(key: string): Promise<boolean> {
    return this.read(key, false, () => true);
  }

  async delete(key: string): Promise<boolean> {
    return this.transaction(false, (store, result, guard) => {
      const request = store.get(key);
      request.onsuccess = guard(() => {
        if (request.result) { store.delete(key); result(true); }
      });
    });
  }

  /** Match live entries and commit all removals in one transaction. */
  async deleteMatching(matches: (key: string) => boolean): Promise<string[]> {
    return this.transaction<string[]>([], (store, result, guard) => {
      const expiry = store.indexNames.contains('expiresAt') ? store.index('expiresAt') : undefined;
      if (expiry?.keyPath === 'metadata.expiresAt' && !expiry.multiEntry) {
        // Do not clone unrelated payloads just to decide which keys to remove.
        // Both requests and all deletes share the same readwrite transaction.
        const keys = store.getAllKeys();
        keys.onsuccess = guard(() => {
          const expired = expiry.getAllKeys(IDBKeyRange.upperBound(Date.now()));
          expired.onsuccess = guard(() => {
            const expiredKeys = new Set(expired.result);
            for (const key of expiredKeys) store.delete(key);
            const deleted: string[] = [];
            for (const key of keys.result) {
              if (expiredKeys.has(key)) continue;
              if (typeof key !== 'string') throw new TypeError('Cache keys must be strings');
              if (matches(key)) {
                store.delete(key);
                deleted.push(key);
              }
            }
            result(deleted);
          });
        });
      } else {
        // Older/externally provisioned databases may lack the expected index.
        const request = store.getAll();
        request.onsuccess = guard(() => {
          const deleted: string[] = [];
          for (const entry of request.result as IndexedDBEntry<T>[]) {
            if (this.expired(entry)) store.delete(entry.key);
            else if (matches(entry.key)) {
              store.delete(entry.key);
              deleted.push(entry.key);
            }
          }
          result(deleted);
        });
      }
    });
  }

  async clear(): Promise<void> {
    return this.transaction(undefined, (store) => { store.clear(); });
  }

  private async liveEntries(): Promise<IndexedDBEntry<T>[]> {
    return this.transaction<IndexedDBEntry<T>[]>([], (store, result, guard) => {
      const entries: IndexedDBEntry<T>[] = [];
      const request = store.openCursor();
      request.onsuccess = guard(() => {
        const cursor = request.result;
        if (!cursor) { result(entries); return; }
        const entry = cursor.value as IndexedDBEntry<T>;
        if (this.expired(entry)) cursor.delete();
        else entries.push(entry);
        cursor.continue();
      });
    });
  }

  async keys(pattern?: string): Promise<string[]> {
    return filterByPattern((await this.liveEntries()).map((entry) => entry.key), pattern);
  }

  async size(): Promise<number> { return (await this.liveEntries()).length; }

  async getKeysByTag(tag: string): Promise<string[]> {
    return (await this.liveEntries()).filter((entry) => entry.metadata.tags?.includes(tag))
      .map((entry) => entry.key);
  }

  async addTag(tag: string, key: string): Promise<void> {
    await this.read(key, undefined, (entry, store) => {
      entry.metadata.tags = [...new Set([...(entry.metadata.tags ?? []), tag])];
      store.put(entry);
      return undefined;
    });
  }

  async removeTag(tag: string, key: string): Promise<void> {
    await this.read(key, undefined, (entry, store) => {
      entry.metadata.tags = entry.metadata.tags?.filter((item) => item !== tag);
      store.put(entry);
      return undefined;
    });
  }

  async getTagsForKey(key: string): Promise<string[]> {
    return this.read<string[]>(key, [], (entry) => entry.metadata.tags ?? []);
  }

  async getMetadata(key: string): Promise<EntryMetadata | undefined> {
    return this.read<EntryMetadata | undefined>(key, undefined, (entry) => entry.metadata);
  }
}

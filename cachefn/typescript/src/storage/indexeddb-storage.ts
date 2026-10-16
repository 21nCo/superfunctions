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

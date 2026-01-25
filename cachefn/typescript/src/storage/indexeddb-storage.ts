/**
 * IndexedDB storage backend for browser persistence
 */

import type { CacheEntry } from "../core/types.js";
import type { StorageBackend, EntryMetadata } from "./storage-interface.js";
import { isExpired } from "../strategies/ttl-manager.js";
import { filterByPattern } from "../utils/pattern.js";

export interface IndexedDBStorageConfig {
  name: string;
  version?: number;
}

interface IndexedDBEntry<T> {
  key: string;
  value: T;
  metadata: EntryMetadata;
}

interface TagEntry {
  tag: string;
  keys: string[];
}

/**
 * IndexedDB storage implementation
 */
export class IndexedDBStorage<T = any> implements StorageBackend<T> {
  private dbName: string;
  private version: number;
  private db: IDBDatabase | null = null;
  private initPromise: Promise<void> | null = null;

  constructor(config: IndexedDBStorageConfig) {
    this.dbName = `cachefn-${config.name}`;
    this.version = config.version ?? 1;
  }

  /**
   * Initialize the IndexedDB database
   */
  private async init(): Promise<void> {
    if (this.db) {
      return;
    }

    if (this.initPromise) {
      return this.initPromise;
    }

    this.initPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(this.dbName, this.version);

      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        this.db = request.result;
        resolve();
      };

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;

        // Create entries store
        if (!db.objectStoreNames.contains("entries")) {
          const entriesStore = db.createObjectStore("entries", {
            keyPath: "key",
          });
          entriesStore.createIndex("expiresAt", "metadata.expiresAt", {
            unique: false,
          });
        }

        // Create tags store
        if (!db.objectStoreNames.contains("tags")) {
          db.createObjectStore("tags", { keyPath: "tag" });
        }
      };
    });

    return this.initPromise;
  }

  async get(key: string): Promise<T | undefined> {
    await this.init();

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction(["entries"], "readwrite");
      const store = transaction.objectStore("entries");
      const request = store.get(key);

      request.onsuccess = async () => {
        const entry: IndexedDBEntry<T> | undefined = request.result;

        if (!entry) {
          resolve(undefined);
          return;
        }

        // Check if expired
        const cacheEntry: CacheEntry<T> = {
          key: entry.key,
          value: entry.value,
          ...entry.metadata,
        };

        if (isExpired(cacheEntry)) {
          await this.delete(key);
          resolve(undefined);
          return;
        }

        // Update access metadata
        entry.metadata.hits++;
        entry.metadata.lastAccess = Date.now();
        store.put(entry);

        resolve(entry.value);
      };

      request.onerror = () => reject(request.error);
    });
  }

  async set(key: string, value: T, metadata: EntryMetadata): Promise<void> {
    await this.init();

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction(
        ["entries", "tags"],
        "readwrite"
      );
      const entriesStore = transaction.objectStore("entries");
      const tagsStore = transaction.objectStore("tags");

      // Get old entry to clean up old tags
      const getRequest = entriesStore.get(key);

      getRequest.onsuccess = async () => {
        const oldEntry: IndexedDBEntry<T> | undefined = getRequest.result;

        // Remove old tags
        if (oldEntry?.metadata.tags) {
          for (const tag of oldEntry.metadata.tags) {
            await this.removeTagFromStore(tagsStore, tag, key);
          }
        }

        // Set new entry
        const entry: IndexedDBEntry<T> = { key, value, metadata };
        entriesStore.put(entry);

        // Add new tags
        if (metadata.tags) {
          for (const tag of metadata.tags) {
            await this.addTagToStore(tagsStore, tag, key);
          }
        }
      };

      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
  }

  async has(key: string): Promise<boolean> {
    await this.init();

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction(["entries"], "readonly");
      const store = transaction.objectStore("entries");
      const request = store.get(key);

      request.onsuccess = async () => {
        const entry: IndexedDBEntry<T> | undefined = request.result;

        if (!entry) {
          resolve(false);
          return;
        }

        const cacheEntry: CacheEntry<T> = {
          key: entry.key,
          value: entry.value,
          ...entry.metadata,
        };

        if (isExpired(cacheEntry)) {
          await this.delete(key);
          resolve(false);
          return;
        }

        resolve(true);
      };

      request.onerror = () => reject(request.error);
    });
  }

  async delete(key: string): Promise<boolean> {
    await this.init();

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction(
        ["entries", "tags"],
        "readwrite"
      );
      const entriesStore = transaction.objectStore("entries");
      const tagsStore = transaction.objectStore("tags");

      const getRequest = entriesStore.get(key);

      getRequest.onsuccess = async () => {
        const entry: IndexedDBEntry<T> | undefined = getRequest.result;

        if (!entry) {
          resolve(false);
          return;
        }

        // Remove from entries
        entriesStore.delete(key);

        // Remove from tags
        if (entry.metadata.tags) {
          for (const tag of entry.metadata.tags) {
            await this.removeTagFromStore(tagsStore, tag, key);
          }
        }

        resolve(true);
      };

      transaction.onerror = () => reject(transaction.error);
    });
  }

  async clear(): Promise<void> {
    await this.init();

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction(
        ["entries", "tags"],
        "readwrite"
      );

      transaction.objectStore("entries").clear();
      transaction.objectStore("tags").clear();

      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
  }

  async keys(pattern?: string): Promise<string[]> {
    await this.init();

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction(["entries"], "readonly");
      const store = transaction.objectStore("entries");
      const request = store.getAllKeys();

      request.onsuccess = () => {
        const allKeys = request.result as string[];
        resolve(filterByPattern(allKeys, pattern));
      };

      request.onerror = () => reject(request.error);
    });
  }

  async size(): Promise<number> {
    await this.init();

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction(["entries"], "readonly");
      const store = transaction.objectStore("entries");
      const request = store.count();

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async getKeysByTag(tag: string): Promise<string[]> {
    await this.init();

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction(["tags"], "readonly");
      const store = transaction.objectStore("tags");
      const request = store.get(tag);

      request.onsuccess = () => {
        const entry: TagEntry | undefined = request.result;
        resolve(entry?.keys ?? []);
      };

      request.onerror = () => reject(request.error);
    });
  }

  async addTag(tag: string, key: string): Promise<void> {
    await this.init();

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction(["tags"], "readwrite");
      const store = transaction.objectStore("tags");

      this.addTagToStore(store, tag, key);

      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
  }

  async removeTag(tag: string, key: string): Promise<void> {
    await this.init();

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction(["tags"], "readwrite");
      const store = transaction.objectStore("tags");

      this.removeTagFromStore(store, tag, key);

      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
  }

  async getTagsForKey(key: string): Promise<string[]> {
    await this.init();

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction(["entries"], "readonly");
      const store = transaction.objectStore("entries");
      const request = store.get(key);

      request.onsuccess = () => {
        const entry: IndexedDBEntry<T> | undefined = request.result;
        resolve(entry?.metadata.tags ?? []);
      };

      request.onerror = () => reject(request.error);
    });
  }

  async getMetadata(key: string): Promise<EntryMetadata | undefined> {
    await this.init();

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction(["entries"], "readonly");
      const store = transaction.objectStore("entries");
      const request = store.get(key);

      request.onsuccess = () => {
        const entry: IndexedDBEntry<T> | undefined = request.result;

        if (!entry) {
          resolve(undefined);
          return;
        }

        const cacheEntry: CacheEntry<T> = {
          key: entry.key,
          value: entry.value,
          ...entry.metadata,
        };

        if (isExpired(cacheEntry)) {
          this.delete(key);
          resolve(undefined);
          return;
        }

        resolve(entry.metadata);
      };

      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Add a tag to the tag store
   */
  private async addTagToStore(
    store: IDBObjectStore,
    tag: string,
    key: string
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const getRequest = store.get(tag);

      getRequest.onsuccess = () => {
        const entry: TagEntry | undefined = getRequest.result;
        const keys = entry?.keys ?? [];

        if (!keys.includes(key)) {
          keys.push(key);
        }

        store.put({ tag, keys });
        resolve();
      };

      getRequest.onerror = () => reject(getRequest.error);
    });
  }

  /**
   * Remove a tag from the tag store
   */
  private async removeTagFromStore(
    store: IDBObjectStore,
    tag: string,
    key: string
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const getRequest = store.get(tag);

      getRequest.onsuccess = () => {
        const entry: TagEntry | undefined = getRequest.result;

        if (!entry) {
          resolve();
          return;
        }

        const keys = entry.keys.filter((k) => k !== key);

        if (keys.length === 0) {
          store.delete(tag);
        } else {
          store.put({ tag, keys });
        }

        resolve();
      };

      getRequest.onerror = () => reject(getRequest.error);
    });
  }
}

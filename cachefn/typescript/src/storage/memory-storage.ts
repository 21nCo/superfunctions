/**
 * In-memory storage backend with LRU eviction
 */

import type { CacheEntry } from "../core/types.js";
import type { StorageBackend, EntryMetadata } from "./storage-interface.js";
import { LRUList } from "../strategies/lru-eviction.js";
import { isExpired } from "../strategies/ttl-manager.js";
import { filterByPattern } from "../utils/pattern.js";
import { estimateSize } from "../utils/serialize.js";

export interface MemoryStorageConfig {
  maxSize?: number;
  onEviction?: (key: string, reason: string) => void;
}

/**
 * Memory storage implementation with LRU eviction
 */
export class MemoryStorage<T = any> implements StorageBackend<T> {
  private cache: Map<string, CacheEntry<T>> = new Map();
  private lru: LRUList<string> = new LRUList();
  private tagIndex: Map<string, Set<string>> = new Map();
  private keyTags: Map<string, Set<string>> = new Map();
  private maxSize: number;
  private onEviction?: (key: string, reason: string) => void;

  constructor(config: MemoryStorageConfig = {}) {
    this.maxSize = config.maxSize ?? 1000;
    if (!Number.isSafeInteger(this.maxSize) || this.maxSize < 0) {
      throw new RangeError("maxSize must be a non-negative safe integer");
    }
    this.onEviction = config.onEviction;
  }

  async get(key: string): Promise<T | undefined> {
    const entry = this.cache.get(key);

    if (!entry) {
      return undefined;
    }

    // Check if expired
    if (isExpired(entry)) {
      await this.delete(key);
      return undefined;
    }

    // Update access metadata
    entry.hits++;
    entry.lastAccess = Date.now();
    this.lru.touch(key);

    return entry.value;
  }

  async set(key: string, value: T, metadata: EntryMetadata): Promise<void> {
    if (this.maxSize === 0) return;
    // Reclaim expired entries before evicting a live least-recently-used value.
    if (this.cache.size >= this.maxSize) {
      for (const [storedKey, entry] of this.cache) {
        if (isExpired(entry)) void this.delete(storedKey);
      }
    }
    // Evict if at capacity and key doesn't exist
    if (!this.cache.has(key) && this.cache.size >= this.maxSize) {
      this.evictLRU();
    }

    // Remove old tags if updating existing entry
    if (this.cache.has(key)) {
      this.removeAllTagsForKey(key);
    }

    const entry: CacheEntry<T> = {
      key,
      value,
      createdAt: metadata.createdAt,
      expiresAt: metadata.expiresAt,
      tags: metadata.tags ? [...metadata.tags] : undefined,
      hits: metadata.hits,
      lastAccess: metadata.lastAccess,
    };

    this.cache.set(key, entry);
    this.lru.touch(key);

    // Update tag index
    if (metadata.tags) {
      for (const tag of metadata.tags) {
        void this.addTag(tag, key);
      }
    }
  }

  async has(key: string): Promise<boolean> {
    const entry = this.cache.get(key);
    if (!entry) {
      return false;
    }

    if (isExpired(entry)) {
      await this.delete(key);
      return false;
    }

    return true;
  }

  async delete(key: string): Promise<boolean> {
    const entry = this.cache.get(key);
    if (!entry) {
      return false;
    }

    this.cache.delete(key);
    this.lru.remove(key);
    this.removeAllTagsForKey(key);

    return true;
  }

  async clear(): Promise<void> {
    this.cache.clear();
    this.lru.clear();
    this.tagIndex.clear();
    this.keyTags.clear();
  }

  async keys(pattern?: string): Promise<string[]> {
    const allKeys = Array.from(this.cache.keys());

    // Filter out expired keys
    const validKeys: string[] = [];
    for (const key of allKeys) {
      if (await this.has(key)) {
        validKeys.push(key);
      }
    }

    return filterByPattern(validKeys, pattern);
  }

  async size(): Promise<number> {
    // Clean up expired entries first
    const allKeys = Array.from(this.cache.keys());
    for (const key of allKeys) {
      const entry = this.cache.get(key);
      if (entry && isExpired(entry)) {
        await this.delete(key);
      }
    }

    return this.cache.size;
  }

  async getKeysByTag(tag: string): Promise<string[]> {
    const keys = this.tagIndex.get(tag);
    if (!keys) {
      return [];
    }

    // Filter out expired or deleted keys
    const validKeys: string[] = [];
    for (const key of keys) {
      if (await this.has(key)) {
        validKeys.push(key);
      } else {
        // Clean up stale tag reference
        keys.delete(key);
      }
    }

    return validKeys;
  }

  async addTag(tag: string, key: string): Promise<void> {
    // Update tag index
    if (!this.tagIndex.has(tag)) {
      this.tagIndex.set(tag, new Set());
    }
    this.tagIndex.get(tag)!.add(key);

    // Update key tags
    if (!this.keyTags.has(key)) {
      this.keyTags.set(key, new Set());
    }
    this.keyTags.get(key)!.add(tag);
  }

  async removeTag(tag: string, key: string): Promise<void> {
    // Remove from tag index
    const keys = this.tagIndex.get(tag);
    if (keys) {
      keys.delete(key);
      if (keys.size === 0) {
        this.tagIndex.delete(tag);
      }
    }

    // Remove from key tags
    const tags = this.keyTags.get(key);
    if (tags) {
      tags.delete(tag);
      if (tags.size === 0) {
        this.keyTags.delete(key);
      }
    }
  }

  async getTagsForKey(key: string): Promise<string[]> {
    const tags = this.keyTags.get(key);
    return tags ? Array.from(tags) : [];
  }

  async getMetadata(key: string): Promise<EntryMetadata | undefined> {
    const entry = this.cache.get(key);
    if (!entry) {
      return undefined;
    }

    if (isExpired(entry)) {
      await this.delete(key);
      return undefined;
    }

    return {
      createdAt: entry.createdAt,
      expiresAt: entry.expiresAt,
      tags: entry.tags ? [...entry.tags] : undefined,
      hits: entry.hits,
      lastAccess: entry.lastAccess,
    };
  }

  /**
   * Get estimated memory usage in bytes
   */
  getMemoryUsage(): number {
    let total = 0;
    for (const entry of this.cache.values()) {
      total += estimateSize(entry.value);
      total += entry.key.length * 2;
    }
    return total;
  }

  /**
   * Evict the least recently used entry
   */
  private evictLRU(): void {
    const key = this.lru.evictLRU();
    if (key !== undefined) {
      void this.delete(key);
      this.onEviction?.(key, "lru");
    }
  }

  /**
   * Remove all tags for a key
   */
  private removeAllTagsForKey(key: string): void {
    const tags = this.keyTags.get(key);
    if (tags) {
      for (const tag of tags) {
        const keys = this.tagIndex.get(tag);
        keys?.delete(key);
        if (keys?.size === 0) this.tagIndex.delete(tag);
      }
    }
    this.keyTags.delete(key);
  }
}

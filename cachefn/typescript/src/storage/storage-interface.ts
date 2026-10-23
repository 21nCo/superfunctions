/**
 * Storage backend interface
 */

import type { CacheEntry, SetOptions } from "../core/types.js";

/**
 * Entry metadata for storage operations
 */
export interface EntryMetadata {
  createdAt: number;
  expiresAt?: number;
  tags?: string[];
  hits: number;
  lastAccess: number;
}

/**
 * Storage backend abstraction
 */
export interface StorageBackend<T = any> {
  /**
   * Get a value from storage
   */
  get(key: string): Promise<T | undefined>;

  /**
   * Set a value in storage
   */
  set(key: string, value: T, metadata: EntryMetadata): Promise<void>;

  /**
   * Check if a key exists
   */
  has(key: string): Promise<boolean>;

  /**
   * Delete a value from storage
   */
  delete(key: string): Promise<boolean>;

  /**
   * Clear all values from storage
   */
  clear(): Promise<void>;

  /**
   * Get all keys matching a pattern
   */
  keys(pattern?: string): Promise<string[]>;

  /**
   * Get the number of entries
   */
  size(): Promise<number>;

  /**
   * Get keys by tag
   */
  getKeysByTag(tag: string): Promise<string[]>;

  /**
   * Add a tag to a key
   */
  addTag(tag: string, key: string): Promise<void>;

  /**
   * Remove a tag from a key
   */
  removeTag(tag: string, key: string): Promise<void>;

  /**
   * Get all tags for a key
   */
  getTagsForKey(key: string): Promise<string[]>;

  /**
   * Get entry metadata
   */
  getMetadata(key: string): Promise<EntryMetadata | undefined>;
}

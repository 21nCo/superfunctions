import type { CacheOptions } from '../types/action.js';
import type { Logger } from '../types/action.js';
import type { KVStoreAdapter } from '@superfunctions/db';
import { createHmac, randomBytes } from 'node:crypto';
import { hash, validateEncryptionKey } from '../utils/crypto.js';

function credentialSegment(binding: string | undefined): string {
  if (binding === undefined) return '';
  if (!/^[a-f0-9]{64}$/.test(binding)) {
    throw new TypeError('credentialBinding must be an HMAC-SHA-256 hex digest');
  }
  return `:credential-hmac=${binding}`;
}

const CACHE_BINDING_LABEL = 'plugfn/action-cache/credential-binding/v1';
const CACHE_BINDING_KEY_BYTES = 32;

/**
 * Derive the server-side key that binds cache entries to credentials from the
 * configured PlugFn encryption key, under a fixed label, so the encryption key
 * itself is never used for anything but token encryption.
 */
export function deriveCacheBindingKey(encryptionKey: string): Uint8Array {
  validateEncryptionKey(encryptionKey);
  return createHmac('sha256', Buffer.from(encryptionKey, 'hex'))
    .update(CACHE_BINDING_LABEL)
    .digest();
}

/** A random binding key, for executors built without a configured secret. */
export function randomCacheBindingKey(): Uint8Array {
  return randomBytes(CACHE_BINDING_KEY_BYTES);
}

/** Locale-independent ordering by UTF-16 code units. */
function compareCodeUnits(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

/**
 * Keyed HMAC-SHA-256 (hex) of a credential version and the sorted set of
 * granted scopes. The version is a non-secret identifier of the stored
 * credential (see ConnectionManager.credentialVersion), never the secret, so
 * a cache key or log line that carries this value reveals nothing about it.
 */
export function credentialBinding(
  bindingKey: Uint8Array,
  credentialVersion: string,
  scopes: readonly string[] | undefined
): string {
  if (!(bindingKey instanceof Uint8Array) || bindingKey.length < CACHE_BINDING_KEY_BYTES) {
    throw new TypeError('cache binding key must be at least 32 bytes');
  }
  if (typeof credentialVersion !== 'string' || credentialVersion === '') {
    throw new TypeError('credential version must be a non-empty string');
  }
  const canonical = JSON.stringify([
    credentialVersion,
    [...new Set(scopes ?? [])].sort(compareCodeUnits),
  ]);
  return createHmac('sha256', bindingKey).update(canonical, 'utf8').digest('hex');
}

interface CacheEntry {
  data: any;
  expiresAt: number;
}

interface SerializedCacheEntry {
  data: any;
}

export type CacheLookup<T> = { hit: true; data: T } | { hit: false };

interface CacheMiddlewareOptions {
  store?: KVStoreAdapter;
  keyPrefix?: string;
}

export class CacheClearUnsupportedError extends Error {
  readonly code = 'PLUGFN_CACHE_CLEAR_UNSUPPORTED';

  constructor() {
    super('Cache clear is not supported for KV-backed caches without prefix invalidation support');
    this.name = 'CacheClearUnsupportedError';
  }
}

/**
 * Action cache middleware. Uses an injected KV store when available and falls
 * back to an in-memory cache for local development/testing.
 */
export class CacheMiddleware {
  private cache = new Map<string, CacheEntry>();
  private cleanupInterval: NodeJS.Timeout;
  private readonly store?: KVStoreAdapter;
  private readonly keyPrefix: string;

  constructor(
    private defaultTTL: number = 300000, // 5 minutes
    private logger?: Logger,
    options: CacheMiddlewareOptions = {}
  ) {
    this.store = options.store;
    this.keyPrefix = options.keyPrefix ?? 'plugfn:action-cache:';
    // Cleanup expired entries every minute
    this.cleanupInterval = setInterval(() => this.cleanup(), 60000);
    this.cleanupInterval.unref?.();
  }

  /**
   * Get cached value
   */
  async get<T>(key: string): Promise<T | undefined> {
    const lookup = await this.getEntry<T>(key);
    return lookup.hit ? lookup.data : undefined;
  }

  async getEntry<T>(key: string): Promise<CacheLookup<T>> {
    if (this.store) {
      const raw = await this.store.get(this.cacheKey(key));
      if (raw === null) {
        return { hit: false };
      }

      try {
        const entry = JSON.parse(raw) as SerializedCacheEntry;
        this.logger?.debug(`Cache hit: ${key}`);
        return { hit: true, data: entry.data as T };
      } catch {
        await this.store.delete(this.cacheKey(key));
        return { hit: false };
      }
    }

    const entry = this.cache.get(key);
    
    if (!entry) {
      return { hit: false };
    }
    
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      return { hit: false };
    }
    
    this.logger?.debug(`Cache hit: ${key}`);
    return { hit: true, data: entry.data };
  }

  /**
   * Set cached value
   */
  async set(key: string, value: any, ttl?: number): Promise<void> {
    const ttlMs = ttl ?? this.defaultTTL;
    if (ttlMs <= 0) {
      await this.delete(key);
      return;
    }

    if (this.store) {
      await this.store.set({
        key: this.cacheKey(key),
        value: JSON.stringify({ data: value } satisfies SerializedCacheEntry),
        ttlSeconds: Math.max(1, Math.ceil(ttlMs / 1000)),
      });
      this.logger?.debug(`Cache set: ${key} (TTL: ${ttlMs}ms)`);
      return;
    }

    const expiresAt = Date.now() + ttlMs;
    
    this.cache.set(key, {
      data: value,
      expiresAt,
    });
    
    this.logger?.debug(`Cache set: ${key} (TTL: ${ttlMs}ms)`);
  }

  /**
   * Delete cached value
   */
  async delete(key: string): Promise<void> {
    if (this.store) {
      await this.store.delete(this.cacheKey(key));
      this.logger?.debug(`Cache delete: ${key}`);
      return;
    }

    this.cache.delete(key);
    this.logger?.debug(`Cache delete: ${key}`);
  }

  /**
   * Clear all cache
   */
  async clear(): Promise<void> {
    if (this.store) {
      throw new CacheClearUnsupportedError();
    }

    this.cache.clear();
    this.logger?.debug('Cache cleared');
  }

  /**
   * Generate cache key for action. A credential binding (see
   * {@link credentialBinding}) ties the entry to the credential and granted
   * scopes that produced it; keys without one are unchanged.
   */
  generateKey(
    provider: string,
    action: string,
    params: any,
    userId?: string,
    connectionId?: string,
    credentialBindingDigest?: string
  ): string {
    const paramsHash = hash(JSON.stringify(params));
    return `${provider}:${action}:${userId || 'anonymous'}:${connectionId || 'default'}${credentialSegment(credentialBindingDigest)}:${paramsHash}`;
  }

  /** Generate a key in a namespace that cannot collide with parameter-derived keys. */
  generateCustomKey(
    provider: string,
    action: string,
    customKey: string,
    userId?: string,
    connectionId?: string,
    credentialBindingDigest?: string
  ): string {
    const customKeyHash = hash(customKey);
    return `${provider}:${action}:${userId || 'anonymous'}:${connectionId || 'default'}${credentialSegment(credentialBindingDigest)}:custom:${customKeyHash}`;
  }

  /**
   * Execute function with caching
   */
  async wrap<T>(
    key: string,
    fn: () => Promise<T>,
    options?: CacheOptions
  ): Promise<{ data: T; cached: boolean }> {
    // Check cache
    const cached = await this.getEntry<T>(key);
    
    if (cached.hit) {
      return { data: cached.data, cached: true };
    }
    
    // Execute function
    const data = await fn();
    
    // Store in cache
    await this.set(key, data, options?.ttl);
    
    return { data, cached: false };
  }

  /**
   * Cleanup expired entries
   */
  private cleanup(): void {
    const now = Date.now();
    let cleaned = 0;
    
    for (const [key, entry] of this.cache.entries()) {
      if (now > entry.expiresAt) {
        this.cache.delete(key);
        cleaned++;
      }
    }
    
    if (cleaned > 0) {
      this.logger?.debug(`Cache cleanup: removed ${cleaned} expired entries`);
    }
  }

  /**
   * Destroy cache and cleanup
   */
  destroy(): void {
    clearInterval(this.cleanupInterval);
    this.cache.clear();
  }

  /**
   * Get cache statistics
   */
  getStats(): { size: number; keys: string[] } {
    if (this.store) {
      return {
        size: -1,
        keys: [],
      };
    }

    return {
      size: this.cache.size,
      keys: Array.from(this.cache.keys()),
    };
  }

  private cacheKey(key: string): string {
    return `${this.keyPrefix}${key}`;
  }
}

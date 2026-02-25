/**
 * SequenceStore - Pluggable sequence generation for serverSeq
 * 
 * Supports multiple backends:
 * - Redis: Uses atomic INCR for high-performance sequence generation
 * - KV Store: Uses atomic incr if available
 * - Database: Falls back to CAS retry loop (existing behavior)
 */

import type { Adapter } from "@superfunctions/db";
import type { RedisAdapter, KVStoreAdapter } from "@superfunctions/db";
import { ensureInternalTable } from "../internal-tables.js";

/**
 * Interface for sequence generation stores
 */
export interface SequenceStore {
  /** Get and increment sequence atomically, returns the next value */
  getNext(namespace: string): Promise<number>;

  /** Get and increment sequence atomically by count, returns array of contiguous values */
  getNextN(namespace: string, count: number): Promise<number[]>;

  /** Get current sequence value (without incrementing) */
  getCurrent(namespace: string): Promise<number>;

  /** Check if the store is healthy/available */
  isHealthy?(): Promise<boolean>;
}

/**
 * Redis-based sequence store using atomic INCR
 */
export class RedisSequenceStore implements SequenceStore {
  private keyPrefix = "serverSeq";

  constructor(private redis: RedisAdapter) {}

  private getKey(namespace: string): string {
    return `${this.keyPrefix}:${namespace}`;
  }

  async getNext(namespace: string): Promise<number> {
    return (await this.getNextN(namespace, 1))[0];
  }

  async getNextN(namespace: string, count: number): Promise<number[]> {
    if (!Number.isInteger(count) || count < 1 || count > 1000) {
      throw new Error("count must be a positive integer between 1 and 1000");
    }
    const key = this.getKey(namespace);
    const end = await this.redis.incr(key, count);
    const start = end - count + 1;
    return Array.from({ length: count }, (_, i) => start + i);
  }

  async getCurrent(namespace: string): Promise<number> {
    const key = this.getKey(namespace);
    const value = await this.redis.get(key);
    return value ? parseInt(value, 10) : 0;
  }

  async isHealthy(): Promise<boolean> {
    return await this.redis.isHealthy();
  }
}

/**
 * KV Store-based sequence store using atomic incr
 */
export class KVSequenceStore implements SequenceStore {
  private keyPrefix = "serverSeq";

  constructor(private kvStore: KVStoreAdapter) {
    if (!kvStore.incr) {
      throw new Error("KV store does not support incr() - cannot use for sequence generation");
    }
  }

  private getKey(namespace: string): string {
    return `${this.keyPrefix}:${namespace}`;
  }

  async getNext(namespace: string): Promise<number> {
    return (await this.getNextN(namespace, 1))[0];
  }

  async getNextN(namespace: string, count: number): Promise<number[]> {
    if (!Number.isInteger(count) || count < 1 || count > 1000) {
      throw new Error("count must be a positive integer between 1 and 1000");
    }
    const key = this.getKey(namespace);
    const result = await this.kvStore.incr!({ key, by: count });
    const end = result.value;
    const start = end - count + 1;
    return Array.from({ length: count }, (_, i) => start + i);
  }

  async getCurrent(namespace: string): Promise<number> {
    const key = this.getKey(namespace);
    const value = await this.kvStore.get(key);
    return value ? parseInt(value, 10) : 0;
  }
}

/**
 * Database-based sequence store using CAS retry loop
 * This is the fallback implementation using the main database adapter
 */
export class DatabaseSequenceStore implements SequenceStore {
  private ensured = false;

  constructor(private db: Adapter) {}

  async getNext(namespace: string): Promise<number> {
    return (await this.getNextN(namespace, 1))[0];
  }

  async getNextN(namespace: string, count: number): Promise<number[]> {
    if (!Number.isInteger(count) || count < 1 || count > 1000) {
      throw new Error("count must be a positive integer between 1 and 1000");
    }

    if (!this.ensured) {
      await ensureInternalTable(this.db, "__datafn_meta");
      this.ensured = true;
    }

    const MAX_RETRIES = 10;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        const meta = await this.db.internal.findOne("__datafn_meta", [
          { field: "namespace", op: "eq", value: namespace },
        ]);

        if (!meta) {
          try {
            await this.db.internal.create("__datafn_meta", {
              id: `meta:${namespace}`,
              namespace: namespace,
              next_server_seq: 1 + count,
            });
            return Array.from({ length: count }, (_, i) => 1 + i);
          } catch {
            continue;
          }
        } else {
          const currentSeq = (meta.next_server_seq as number) || 1;

          try {
            const affected = await this.db.internal.update(
              "__datafn_meta",
              [
                { field: "namespace", op: "eq", value: namespace },
                { field: "next_server_seq", op: "eq", value: currentSeq },
              ],
              { next_server_seq: currentSeq + count },
            );

            if (affected === 0) {
              continue;
            }

            return Array.from({ length: count }, (_, i) => currentSeq + i);
          } catch {
            continue;
          }
        }
      } catch (error) {
        if (attempt === MAX_RETRIES - 1) {
          console.error("Failed to get next serverSeq after max retries:", error);
          throw new Error("INTERNAL: Failed to allocate serverSeq after maximum retries");
        }
      }
    }

    throw new Error("INTERNAL: Failed to allocate serverSeq after maximum retries");
  }

  async getCurrent(namespace: string): Promise<number> {
    if (!this.ensured) {
      await ensureInternalTable(this.db, "__datafn_meta");
      this.ensured = true;
    }

    try {
      const meta = await this.db.internal.findOne("__datafn_meta", [
        { field: "namespace", op: "eq", value: namespace },
      ]);

      if (!meta) {
        return 0;
      }
      return ((meta.next_server_seq as number) || 1) - 1;
    } catch (error) {
      console.error("Failed to get current serverSeq:", error);
      return 0;
    }
  }
}

/**
 * Fallback sequence store that tries primary store first, falls back to database
 */
export class FallbackSequenceStore implements SequenceStore {
  constructor(
    private primary: SequenceStore,
    private fallback: SequenceStore,
  ) {}

  async getNext(namespace: string): Promise<number> {
    return (await this.getNextN(namespace, 1))[0];
  }

  async getNextN(namespace: string, count: number): Promise<number[]> {
    try {
      if (this.primary.isHealthy) {
        const healthy = await this.primary.isHealthy();
        if (!healthy) {
          console.warn("Primary sequence store unhealthy, using fallback");
          return await this.fallback.getNextN(namespace, count);
        }
      }
      return await this.primary.getNextN(namespace, count);
    } catch (error) {
      console.warn("Primary sequence store failed, using fallback:", error);
      return await this.fallback.getNextN(namespace, count);
    }
  }

  async getCurrent(namespace: string): Promise<number> {
    try {
      if (this.primary.isHealthy) {
        const healthy = await this.primary.isHealthy();
        if (!healthy) {
          return await this.fallback.getCurrent(namespace);
        }
      }
      return await this.primary.getCurrent(namespace);
    } catch (error) {
      console.warn("Primary sequence store failed for getCurrent, using fallback:", error);
      return await this.fallback.getCurrent(namespace);
    }
  }

  async isHealthy(): Promise<boolean> {
    if (this.primary.isHealthy) {
      return await this.primary.isHealthy();
    }
    return true;
  }
}

/**
 * Database mapping configuration for routing operations to different databases
 */
export interface DbMapping {
  /** Which database to use for serverSeq generation (default: "db") */
  serverseq?: "redis" | "kv" | "db";
  /** Which database to use for rate limiting (default: "db") */
  ratelimiting?: "redis" | "kv" | "db";
  /** Which database to use for caching (default: "db") */
  cache?: "redis" | "kv" | "db";
}

/**
 * Create appropriate sequence store based on configuration
 */
export function createSequenceStore(config: {
  db?: Adapter;
  redis?: RedisAdapter;
  kvStore?: KVStoreAdapter;
  dbMapping?: DbMapping;
}): SequenceStore | undefined {
  const { db, redis, kvStore, dbMapping } = config;
  const mapping = dbMapping?.serverseq || "db";

  if (!db) {
    return undefined;
  }

  const dbFallback = new DatabaseSequenceStore(db);

  if (mapping === "redis" && redis) {
    const primary = new RedisSequenceStore(redis);
    return new FallbackSequenceStore(primary, dbFallback);
  }

  if (mapping === "kv" && kvStore) {
    if (!kvStore.incr) {
      console.warn("KV store does not support incr(), falling back to database for serverSeq");
      return dbFallback;
    }
    const primary = new KVSequenceStore(kvStore);
    return new FallbackSequenceStore(primary, dbFallback);
  }

  return dbFallback;
}

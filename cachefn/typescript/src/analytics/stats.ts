/**
 * Cache statistics tracking
 */

import type { CacheStats } from "../core/types.js";

/**
 * Statistics tracker for cache operations
 */
export class StatsTracker {
  private hits = 0;
  private misses = 0;
  private sets = 0;
  private deletes = 0;
  private evictions = 0;

  /**
   * Record a cache hit
   */
  recordHit(): void {
    this.hits++;
  }

  /**
   * Record a cache miss
   */
  recordMiss(): void {
    this.misses++;
  }

  /**
   * Record a set operation
   */
  recordSet(): void {
    this.sets++;
  }

  /**
   * Record a delete operation
   */
  recordDelete(): void {
    this.deletes++;
  }

  /**
   * Record an eviction
   */
  recordEviction(): void {
    this.evictions++;
  }

  /**
   * Get current statistics
   */
  getStats(size: number, memoryUsage?: number): CacheStats {
    const total = this.hits + this.misses;
    const hitRate = total > 0 ? (this.hits / total) * 100 : 0;

    return {
      hits: this.hits,
      misses: this.misses,
      hitRate: Math.round(hitRate * 100) / 100,
      sets: this.sets,
      deletes: this.deletes,
      evictions: this.evictions,
      size,
      memoryUsage,
    };
  }

  /**
   * Reset all statistics
   */
  reset(): void {
    this.hits = 0;
    this.misses = 0;
    this.sets = 0;
    this.deletes = 0;
    this.evictions = 0;
  }
}

import type { RateLimitConfig } from '../types/provider.js';

interface RateLimitEntry {
  tokens: number;
  lastRefill: number;
  queue: Array<{ resolve: () => void; reject: (error: Error) => void }>;
}

/**
 * Token bucket rate limiter
 */
export class RateLimiter {
  private buckets = new Map<string, RateLimitEntry>();
  private cleanupInterval: NodeJS.Timeout;

  constructor() {
    // Cleanup old buckets every minute
    this.cleanupInterval = setInterval(() => this.cleanup(), 60000);
  }

  /**
   * Acquire a token for the given key
   */
  async acquire(key: string, config: RateLimitConfig): Promise<void> {
    const bucket = this.getOrCreateBucket(key, config);
    
    // Refill tokens based on time elapsed
    this.refillTokens(bucket, config);
    
    // If tokens available, consume one
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return;
    }
    
    // Wait for token to become available
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        const index = bucket.queue.findIndex((item) => item.resolve === resolve);
        if (index !== -1) {
          bucket.queue.splice(index, 1);
        }
        reject(new Error('Rate limit timeout'));
      }, config.window * 2);

      bucket.queue.push({
        resolve: () => {
          clearTimeout(timeout);
          resolve();
        },
        reject: (error: Error) => {
          clearTimeout(timeout);
          reject(error);
        },
      });
    });
  }

  /**
   * Check if rate limit would be exceeded
   */
  wouldExceed(key: string, config: RateLimitConfig): boolean {
    const bucket = this.buckets.get(key);
    
    if (!bucket) {
      return false;
    }
    
    this.refillTokens(bucket, config);
    return bucket.tokens < 1;
  }

  /**
   * Get or create bucket for key
   */
  private getOrCreateBucket(key: string, config: RateLimitConfig): RateLimitEntry {
    let bucket = this.buckets.get(key);
    
    if (!bucket) {
      bucket = {
        tokens: config.requests,
        lastRefill: Date.now(),
        queue: [],
      };
      this.buckets.set(key, bucket);
    }
    
    return bucket;
  }

  /**
   * Refill tokens based on elapsed time
   */
  private refillTokens(bucket: RateLimitEntry, config: RateLimitConfig): void {
    const now = Date.now();
    const elapsed = now - bucket.lastRefill;
    
    if (elapsed >= config.window) {
      // Full refill
      const tokensToAdd = config.requests;
      bucket.tokens = Math.min(config.requests, bucket.tokens + tokensToAdd);
      bucket.lastRefill = now;
      
      // Process queued requests
      while (bucket.queue.length > 0 && bucket.tokens >= 1) {
        const item = bucket.queue.shift();
        if (item) {
          bucket.tokens -= 1;
          item.resolve();
        }
      }
    } else {
      // Partial refill based on time elapsed
      const refillRate = config.requests / config.window;
      const tokensToAdd = refillRate * elapsed;
      
      if (tokensToAdd >= 1) {
        bucket.tokens = Math.min(config.requests, bucket.tokens + Math.floor(tokensToAdd));
        bucket.lastRefill = now;
        
        // Process queued requests
        while (bucket.queue.length > 0 && bucket.tokens >= 1) {
          const item = bucket.queue.shift();
          if (item) {
            bucket.tokens -= 1;
            item.resolve();
          }
        }
      }
    }
  }

  /**
   * Cleanup old buckets
   */
  private cleanup(): void {
    const now = Date.now();
    const maxAge = 300000; // 5 minutes
    
    for (const [key, bucket] of this.buckets.entries()) {
      if (now - bucket.lastRefill > maxAge && bucket.queue.length === 0) {
        this.buckets.delete(key);
      }
    }
  }

  /**
   * Destroy rate limiter and cleanup
   */
  destroy(): void {
    clearInterval(this.cleanupInterval);
    
    // Reject all queued requests
    for (const bucket of this.buckets.values()) {
      for (const item of bucket.queue) {
        item.reject(new Error('Rate limiter destroyed'));
      }
    }
    
    this.buckets.clear();
  }
}


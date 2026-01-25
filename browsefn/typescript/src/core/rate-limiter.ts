/**
 * Rate limiter implementation for API requests
 */

import type { RateLimitConfig, RateLimitStatus } from './types.js';

interface RateLimitEntry {
  count: number;
  windowStart: number;
}

export class RateLimiter {
  private limits = new Map<string, RateLimitEntry>();
  private configs = new Map<string, RateLimitConfig>();

  constructor(
    private globalConfig?: RateLimitConfig,
    perProviderConfigs?: Record<string, RateLimitConfig>
  ) {
    if (perProviderConfigs) {
      Object.entries(perProviderConfigs).forEach(([provider, config]) => {
        this.configs.set(provider, config);
      });
    }
  }

  /**
   * Check if a request is allowed for the given provider
   */
  async checkLimit(provider: string): Promise<boolean> {
    const config = this.configs.get(provider) || this.globalConfig;
    if (!config) return true;

    const key = provider;
    const now = Date.now();
    const entry = this.limits.get(key);

    if (!entry) {
      this.limits.set(key, { count: 1, windowStart: now });
      return true;
    }

    // Check if window has expired
    if (now - entry.windowStart >= config.window) {
      this.limits.set(key, { count: 1, windowStart: now });
      return true;
    }

    // Check if under limit
    if (entry.count < config.requests) {
      entry.count++;
      return true;
    }

    return false;
  }

  /**
   * Wait until rate limit allows the request
   */
  async waitForLimit(provider: string): Promise<void> {
    const config = this.configs.get(provider) || this.globalConfig;
    if (!config) return;

    while (!(await this.checkLimit(provider))) {
      const status = this.getStatus(provider);
      const waitTime = status.resetAt - Date.now();
      if (waitTime > 0) {
        await new Promise(resolve => setTimeout(resolve, Math.min(waitTime, 1000)));
      }
    }
  }

  /**
   * Get rate limit status for a provider
   */
  getStatus(provider: string): RateLimitStatus {
    const config = this.configs.get(provider) || this.globalConfig;
    if (!config) {
      return { remaining: Infinity, resetAt: 0, limit: Infinity };
    }

    const entry = this.limits.get(provider);
    if (!entry) {
      return {
        remaining: config.requests,
        resetAt: Date.now() + config.window,
        limit: config.requests
      };
    }

    const now = Date.now();
    const windowEnd = entry.windowStart + config.window;

    if (now >= windowEnd) {
      return {
        remaining: config.requests,
        resetAt: now + config.window,
        limit: config.requests
      };
    }

    return {
      remaining: Math.max(0, config.requests - entry.count),
      resetAt: windowEnd,
      limit: config.requests
    };
  }

  /**
   * Reset rate limit for a provider
   */
  reset(provider?: string): void {
    if (provider) {
      this.limits.delete(provider);
    } else {
      this.limits.clear();
    }
  }

  /**
   * Set rate limit config for a provider
   */
  setConfig(provider: string, config: RateLimitConfig): void {
    this.configs.set(provider, config);
  }
}

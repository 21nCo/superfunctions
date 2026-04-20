/**
 * Rate limiter wrapper that delegates to the shared middleware package.
 */

import {
  createRateLimiter,
  type RateLimiter as SharedRateLimiter,
} from '@superfunctions/middleware/rate-limit';

import { BrowseFnError } from './errors.js';
import type { RateLimitConfig, RateLimitStatus } from './types.js';

type RateLimitListener = (status: RateLimitStatus) => void;

const UNBOUNDED_STATUS: RateLimitStatus = {
  remaining: Number.POSITIVE_INFINITY,
  resetAt: 0,
  limit: Number.POSITIVE_INFINITY,
  allowed: true,
  retryAfterMs: 0,
};

export class RateLimiter {
  private readonly providerLimiters = new Map<string, SharedRateLimiter>();
  private readonly globalLimiter?: SharedRateLimiter;
  private readonly configs = new Map<string, RateLimitConfig>();
  private readonly listeners = new Set<RateLimitListener>();
  private readonly lastStatus = new Map<string, RateLimitStatus>();

  constructor(
    private readonly globalConfig?: RateLimitConfig,
    perProviderConfigs?: Record<string, RateLimitConfig>
  ) {
    if (perProviderConfigs) {
      Object.entries(perProviderConfigs).forEach(([provider, config]) => {
        this.configs.set(provider, config);
        this.providerLimiters.set(
          provider,
          this.createSharedLimiter(config, `browsefn:${provider}:`)
        );
      });
    }

    if (globalConfig) {
      this.globalLimiter = this.createSharedLimiter(globalConfig, 'browsefn:global:');
    }
  }

  getImportPath(): string {
    return '@superfunctions/middleware/rate-limit';
  }

  onRateLimited(listener: RateLimitListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async check(provider: string): Promise<RateLimitStatus> {
    const config = this.configs.get(provider) ?? this.globalConfig;
    if (!config) {
      return { ...UNBOUNDED_STATUS, provider };
    }

    const limiter = this.getLimiter(provider, config);
    const result = await limiter.check({ key: provider });

    const resetAt = new Date(result.resetAt).getTime();
    const status: RateLimitStatus = {
      allowed: result.allowed,
      remaining: result.remaining,
      resetAt,
      limit: result.total,
      provider,
      retryAfterMs: Math.max(0, resetAt - Date.now()),
    };

    this.lastStatus.set(provider, status);

    if (!result.allowed) {
      this.listeners.forEach((listener) => listener(status));
    }

    return status;
  }

  async checkLimit(provider: string): Promise<boolean> {
    const status = await this.check(provider);
    return status.allowed !== false;
  }

  async waitForLimit(provider: string): Promise<void> {
    const config = this.configs.get(provider) ?? this.globalConfig;
    if (!config) {
      return;
    }

    for (;;) {
      const status = await this.check(provider);
      if (status.allowed !== false) {
        return;
      }

      const delayMs = Math.max(25, status.retryAfterMs ?? status.resetAt - Date.now());
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  getStatus(provider: string): RateLimitStatus {
    const config = this.configs.get(provider) ?? this.globalConfig;
    if (!config) {
      return { ...UNBOUNDED_STATUS, provider };
    }

    const lastKnown = this.lastStatus.get(provider);
    if (!lastKnown) {
      return {
        remaining: config.requests,
        resetAt: Date.now() + config.window,
        limit: config.requests,
        allowed: true,
        provider,
        retryAfterMs: config.window,
      };
    }

    if (Date.now() >= lastKnown.resetAt) {
      return {
        remaining: config.requests,
        resetAt: Date.now() + config.window,
        limit: config.requests,
        allowed: true,
        provider,
        retryAfterMs: config.window,
      };
    }

    return lastKnown;
  }

  async consume(provider: string): Promise<void> {
    const status = await this.check(provider);
    if (status.allowed === false) {
      throw new BrowseFnError({
        code: 'RATE_LIMITED',
        message: `Rate limit exceeded for provider ${provider}.`,
        provider,
        retryAfterMs: status.retryAfterMs,
      });
    }
  }

  async reset(provider?: string): Promise<void> {
    if (provider) {
      const config = this.configs.get(provider) ?? this.globalConfig;
      if (config) {
        await this.getLimiter(provider, config).reset(provider);
      }
      this.lastStatus.delete(provider);
      return;
    }

    const providers = new Set<string>([
      ...this.configs.keys(),
      ...this.lastStatus.keys(),
    ]);

    await Promise.all(
      Array.from(providers).map(async (name) => {
        const config = this.configs.get(name) ?? this.globalConfig;
        if (config) {
          await this.getLimiter(name, config).reset(name);
        }
        this.lastStatus.delete(name);
      })
    );
  }

  setConfig(provider: string, config: RateLimitConfig): void {
    this.configs.set(provider, config);
    this.providerLimiters.set(
      provider,
      this.createSharedLimiter(config, `browsefn:${provider}:`)
    );
    this.lastStatus.delete(provider);
  }

  private getLimiter(provider: string, config: RateLimitConfig): SharedRateLimiter {
    return (
      this.providerLimiters.get(provider) ??
      this.globalLimiter ??
      this.createSharedLimiter(config, `browsefn:${provider}:`)
    );
  }

  private createSharedLimiter(
    config: RateLimitConfig,
    keyPrefix: string
  ): SharedRateLimiter {
    return createRateLimiter({
      windowMs: config.window,
      maxRequests: config.requests,
      keyPrefix,
    });
  }
}

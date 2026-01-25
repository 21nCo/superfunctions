import type { RateLimitRule, RateLimitEntry, RateLimitResult, RateLimitViolation } from '../types/index.js';
import type { IndexedDBStorage } from '../storage/indexeddb-storage.js';
import { generateId } from '../utils/helpers.js';

export interface RateLimiterConfig {
  storage: IndexedDBStorage;
  rules: {
    global?: RateLimitRule;
    perUser?: RateLimitRule;
    perIP?: RateLimitRule;
    perEndpoint?: Record<string, RateLimitRule>;
  };
  onLimitExceeded?: (violation: RateLimitViolation) => void | Promise<void>;
}

export interface RateLimitCheckRequest {
  userId?: string;
  ip: string;
  endpoint?: string;
}

export class RateLimiter {
  private storage: IndexedDBStorage;
  private rules: RateLimiterConfig['rules'];
  private onLimitExceeded?: (violation: RateLimitViolation) => void | Promise<void>;

  constructor(config: RateLimiterConfig) {
    this.storage = config.storage;
    this.rules = config.rules;
    this.onLimitExceeded = config.onLimitExceeded;
  }

  async check(request: RateLimitCheckRequest): Promise<RateLimitResult> {
    const checks: Array<{ key: string; rule: RateLimitRule }> = [];

    if (this.rules.global) {
      checks.push({
        key: 'global',
        rule: this.rules.global,
      });
    }

    if (this.rules.perUser && request.userId) {
      checks.push({
        key: `user:${request.userId}`,
        rule: this.rules.perUser,
      });
    }

    if (this.rules.perIP) {
      checks.push({
        key: `ip:${request.ip}`,
        rule: this.rules.perIP,
      });
    }

    if (this.rules.perEndpoint && request.endpoint) {
      const endpointRule = this.rules.perEndpoint[request.endpoint];
      if (endpointRule) {
        checks.push({
          key: `endpoint:${request.endpoint}:${request.ip}`,
          rule: endpointRule,
        });
      }
    }

    for (const check of checks) {
      const result = await this.checkLimit(check.key, check.rule);
      
      if (!result.allowed) {
        await this.handleViolation({
          id: generateId('violation'),
          timestamp: Date.now(),
          key: check.key,
          ip: request.ip,
          userId: request.userId,
          endpoint: request.endpoint || 'unknown',
          requestCount: result.limit || 0,
          limit: check.rule.requests,
          window: check.rule.window,
          blocked: true,
        });

        return result;
      }
    }

    return {
      allowed: true,
      remaining: checks.length > 0 ? checks[0].rule.requests : 0,
      resetAt: Date.now() + (checks.length > 0 ? checks[0].rule.window : 0),
    };
  }

  private async checkLimit(key: string, rule: RateLimitRule): Promise<RateLimitResult> {
    const now = Date.now();
    const entry = await this.storage.getRateLimitEntry(key);

    if (!entry || now >= entry.resetAt) {
      const newEntry: RateLimitEntry = {
        key,
        count: 1,
        resetAt: now + rule.window,
        blocked: false,
      };
      await this.storage.setRateLimitEntry(newEntry);

      return {
        allowed: true,
        remaining: rule.requests - 1,
        resetAt: newEntry.resetAt,
        limit: rule.requests,
      };
    }

    if (entry.blocked && entry.blockedUntil && now < entry.blockedUntil) {
      return {
        allowed: false,
        remaining: 0,
        resetAt: entry.resetAt,
        retryAfter: entry.blockedUntil - now,
        limit: rule.requests,
      };
    }

    if (entry.count >= rule.requests) {
      entry.blocked = true;
      entry.blockedUntil = now + (rule.blockDuration || rule.window);
      await this.storage.setRateLimitEntry(entry);

      return {
        allowed: false,
        remaining: 0,
        resetAt: entry.resetAt,
        retryAfter: entry.blockedUntil - now,
        limit: rule.requests,
      };
    }

    entry.count++;
    await this.storage.setRateLimitEntry(entry);

    return {
      allowed: true,
      remaining: rule.requests - entry.count,
      resetAt: entry.resetAt,
      limit: rule.requests,
    };
  }

  private async handleViolation(violation: RateLimitViolation): Promise<void> {
    if (this.onLimitExceeded) {
      try {
        await this.onLimitExceeded(violation);
      } catch (error) {
        console.error('[SecFn] Error in rate limit violation handler:', error);
      }
    }
  }

  async reset(key: string): Promise<void> {
    await this.storage.deleteRateLimitEntry(key);
  }

  async resetUser(userId: string): Promise<void> {
    await this.reset(`user:${userId}`);
  }

  async resetIP(ip: string): Promise<void> {
    await this.reset(`ip:${ip}`);
  }

  async unblock(key: string): Promise<void> {
    const entry = await this.storage.getRateLimitEntry(key);
    if (entry) {
      entry.blocked = false;
      entry.blockedUntil = undefined;
      await this.storage.setRateLimitEntry(entry);
    }
  }
}

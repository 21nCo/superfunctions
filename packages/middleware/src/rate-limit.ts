import type { Adapter, KVStoreAdapter } from '@superfunctions/db';

export { KVStoreAdapter };

export interface RateLimitConfig {
  windowMs: number;
  maxRequests: number;
  keyPrefix?: string;
  persistence?: Adapter | KVStoreAdapter;
  algorithm?: 'sliding-window' | 'fixed-window';
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: string; // ISO8601
  total: number;
}

export interface CheckLimitInput {
  key: string;
  windowSeconds?: number;
  limit?: number;
}

export interface RateLimiter {
  check(input: CheckLimitInput): Promise<RateLimitResult>;
  reset(key: string): Promise<void>;
}

interface RateLimitState {
  count: number;
  windowStart: number;
}

function createInMemoryKVStore(): KVStoreAdapter {
  const store = new Map<string, { value: string; expiresAt?: number }>();

  return {
    async get(key: string): Promise<string | null> {
      const entry = store.get(key);
      if (!entry) return null;
      if (entry.expiresAt && Date.now() > entry.expiresAt) {
        store.delete(key);
        return null;
      }
      return entry.value;
    },
    async set(input: { key: string; value: string; ttlSeconds?: number }): Promise<void> {
      store.set(input.key, {
        value: input.value,
        expiresAt: input.ttlSeconds ? Date.now() + input.ttlSeconds * 1000 : undefined,
      });
    },
    async delete(key: string): Promise<void> {
      store.delete(key);
    },
  };
}

function isAdapter(p: any): p is Adapter {
  return typeof p.findOne === 'function' && typeof p.create === 'function';
}

function ensureKV(p: Adapter | KVStoreAdapter): KVStoreAdapter {
  if (isAdapter(p)) {
    return {
      async get(key: string) {
        const res = await p.findOne<{ value: string; expiresAt?: string }>({ 
          model: 'rate_limits', 
          where: [{ field: 'key', operator: 'eq', value: key }] 
        });
        if (!res) return null;
        if (res.expiresAt && new Date(res.expiresAt).getTime() < Date.now()) {
           await p.delete({ model: 'rate_limits', where: [{ field: 'key', operator: 'eq', value: key }] });
           return null;
        }
        return res.value;
      },
      async set(input) {
        const expiresAt = input.ttlSeconds ? new Date(Date.now() + input.ttlSeconds * 1000).toISOString() : undefined;
        await p.upsert({
          model: 'rate_limits',
          where: [{ field: 'key', operator: 'eq', value: input.key }],
          create: { key: input.key, value: input.value, expiresAt },
          update: { value: input.value, expiresAt }
        });
      },
      async delete(key) {
        await p.delete({ model: 'rate_limits', where: [{ field: 'key', operator: 'eq', value: key }] });
      }
    };
  }
  return p;
}

export function createRateLimiter(config: RateLimitConfig): RateLimiter {
  const {
    windowMs,
    maxRequests,
    keyPrefix = 'ratelimit:',
    persistence = createInMemoryKVStore(),
    algorithm = 'fixed-window',
  } = config;

  const kv = ensureKV(persistence);

  async function getState(key: string): Promise<RateLimitState | null> {
    const data = await kv.get(keyPrefix + key);
    if (!data) return null;
    try {
      return JSON.parse(data) as RateLimitState;
    } catch {
      return null;
    }
  }

  async function setState(key: string, state: RateLimitState, windowDuration: number): Promise<void> {
    const ttlMs = state.windowStart + windowDuration - Date.now();
    if (ttlMs > 0) {
      await kv.set({
        key: keyPrefix + key, 
        value: JSON.stringify(state), 
        ttlSeconds: Math.ceil(ttlMs / 1000)
      });
    }
  }

  return {
    async check(input: CheckLimitInput): Promise<RateLimitResult> {
      const key = input.key;
      const effectiveWindowMs = (input.windowSeconds ? input.windowSeconds * 1000 : undefined) ?? windowMs;
      const effectiveLimit = input.limit ?? maxRequests;

      const now = Date.now();
      let state = await getState(key);

      if (!state || now >= state.windowStart + effectiveWindowMs) {
        state = { count: 0, windowStart: now };
      }

      const allowed = state.count < effectiveLimit;
      if (allowed) {
        state.count++;
        await setState(key, state, effectiveWindowMs);
      }

      const resetAtTs = state.windowStart + effectiveWindowMs;

      return {
        allowed,
        remaining: Math.max(0, effectiveLimit - state.count),
        resetAt: new Date(resetAtTs).toISOString(),
        total: effectiveLimit,
      };
    },

    async reset(key: string): Promise<void> {
      await kv.delete(keyPrefix + key);
    },
  };
}

export { createInMemoryKVStore };

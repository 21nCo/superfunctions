# PHASE 07: Rate Limiting

## Phase Goal

Implement configurable per-endpoint rate limiting with Redis-backed and in-memory fallback implementations.

## In Scope

- Rate limiting middleware
- Redis-backed sliding window limiter using `RedisAdapter.incr()`
- In-memory sliding window limiter as fallback
- Per-endpoint override configuration
- Client key extraction
- HTTP 429 response envelope

## Out of Scope

- Distributed rate limiting across multiple processes (in-memory is single-process only; Redis is distributed)
- IP-based key extraction (server abstraction doesn't expose IP)
- Rate limit headers (X-RateLimit-Remaining, etc.) — MAY be added later

## Deliverables

| File | Action |
|---|---|
| `datafn/server/src/middleware/rate-limit.ts` | CREATE — rate limiter implementations and middleware |
| `datafn/server/src/server.ts` | MODIFY — wire rate limiting into request pipeline |
| `datafn/server/src/core-types.ts` | MODIFY — add `RateLimitConfig` type |
| `datafn/server/__tests__/rate-limit.test.ts` | CREATE — rate limiting tests |

## Requirements Covered

- RATE-001 (Rate limiting middleware)
- RATE-002 (Redis-backed rate limiter)
- RATE-003 (In-memory fallback rate limiter)
- RATE-004 (Per-endpoint overrides)
- RATE-005 (Rate limit configuration)

## Implementation Tasks

1. Create `datafn/server/src/middleware/rate-limit.ts`:
   ```typescript
   export interface RateLimiter {
     check(key: string, maxRequests: number, windowSeconds: number): Promise<{ allowed: boolean; remaining: number }>;
   }

   export class RedisRateLimiter implements RateLimiter {
     constructor(private redis: RedisAdapter) {}
     async check(key: string, maxRequests: number, windowSeconds: number) {
       const windowId = Math.floor(Date.now() / (windowSeconds * 1000));
       const redisKey = `ratelimit:${key}:${windowId}`;
       const count = await this.redis.incr(redisKey);
       if (count === 1) {
         await this.redis.set(redisKey, String(count), windowSeconds);
       }
       return { allowed: count <= maxRequests, remaining: Math.max(0, maxRequests - count) };
     }
   }

   export class MemoryRateLimiter implements RateLimiter {
     private windows = new Map<string, { count: number; resetAt: number }>();
     async check(key: string, maxRequests: number, windowSeconds: number) {
       const now = Date.now();
       const windowMs = windowSeconds * 1000;
       const entry = this.windows.get(key);
       if (!entry || now >= entry.resetAt) {
         this.windows.set(key, { count: 1, resetAt: now + windowMs });
         return { allowed: true, remaining: maxRequests - 1 };
       }
       entry.count++;
       return { allowed: entry.count <= maxRequests, remaining: Math.max(0, maxRequests - entry.count) };
     }
   }
   ```

2. Create rate limit middleware factory:
   ```typescript
   export function createRateLimitMiddleware(config: {
     limiter: RateLimiter;
     maxRequests: number;
     windowSeconds: number;
     endpoints?: Partial<Record<string, { maxRequests: number; windowSeconds: number }>>;
     keyExtractor: (ctx: any) => string | Promise<string>;
   }) {
     return async (endpoint: string, ctx: any): Promise<Response | null> => {
       const key = await config.keyExtractor(ctx);
       const endpointConfig = config.endpoints?.[endpoint];
       const max = endpointConfig?.maxRequests ?? config.maxRequests;
       const window = endpointConfig?.windowSeconds ?? config.windowSeconds;
       const result = await config.limiter.check(`${endpoint}:${key}`, max, window);
       if (!result.allowed) {
         return new Response(JSON.stringify({
           ok: false,
           error: { code: "RATE_LIMITED", message: "Too many requests", details: { path: "$" } }
         }), { status: 429, headers: { "Content-Type": "application/json" } });
       }
       return null; // allowed
     };
   }
   ```

3. Wire into `server.ts`:
   - Create limiter instance during `createDatafnServer()`:
     - If `config.redis` and `config.rateLimit?.enabled`: use `RedisRateLimiter`
     - Else if `config.rateLimit?.enabled`: use `MemoryRateLimiter`
   - In `withAuth()` wrapper, BEFORE JSON parsing and authorization:
     ```typescript
     if (rateLimitMiddleware) {
       const rateLimitResponse = await rateLimitMiddleware(action, ctx);
       if (rateLimitResponse) return rateLimitResponse;
     }
     ```
   - Default key extractor: try `authContextProvider.getContext(ctx).userId`, fallback to `"anonymous"`

4. Tests:
   - TV-RATE-001: under limit passes
   - TV-RATE-002: over limit returns 429
   - TV-RATE-REDIS-001: Redis limiter calls INCR
   - TV-RATE-MEMORY-001: memory limiter with window expiry
   - TV-RATE-OVERRIDE-001: per-endpoint override
   - TV-RATE-CONFIG-001: disabled rate limiting

## Verification Steps

```bash
cd /Users/serro/Documents/dev/n/superfunctions/datafn/server
npx vitest run __tests__/rate-limit.test.ts
npx vitest run
npx tsc --noEmit
```

**Expected**: All rate limiting tests pass. Existing tests unaffected (rate limiting disabled by default).

## Stop Condition

Report: Rate limiting middleware implemented with Redis and in-memory backends. Per-endpoint overrides working. HTTP 429 response verified.

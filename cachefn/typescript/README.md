# CacheFn TypeScript SDK

> Self-hosted caching solution with multi-tier storage and function memoization

CacheFn is a developer-first caching library that provides memory and IndexedDB storage, intelligent invalidation strategies, function memoization, and framework middleware - all with zero external dependencies.

## Features

✅ **Zero Dependencies** - No Redis, Memcached, or external services required\
✅ **Multi-tier Storage** - Memory and IndexedDB backends\
✅ **Type-Safe** - Full TypeScript support with type inference\
✅ **Function Memoization** - Cache expensive function results\
✅ **Tag-based Invalidation** - Flexible cache invalidation strategies\
✅ **Framework Middleware** - Express, Hono, and Fastify support\
✅ **Analytics** - Built-in hit/miss tracking and statistics\
✅ **Browser + Node.js** - Works everywhere

## Installation

```bash
npm install @cachefn/core
```

## Quick Start

### Basic Usage

```typescript
import { cacheFn } from "@cachefn/core";

// Create a cache instance
const cache = cacheFn({
  name: "my-cache",
  storage: "memory",
  maxSize: 1000,
  defaultTTL: 60000, // 1 minute
});

// Set a value
await cache.set("user:123", { name: "Alice", age: 30 });

// Get a value
const user = await cache.get("user:123");

// Set with TTL and tags
await cache.set("session:abc", { userId: "123" }, {
  ttl: 3600000, // 1 hour
  tags: ["sessions", "user:123"],
});

// Invalidate by tag
await cache.invalidateByTag("sessions");
```

### Function Memoization

```typescript
import { memoizeSync } from "@cachefn/core";

// Memoize a function
const fibonacci = memoizeSync(
  (n: number): number => {
    if (n <= 1) return n;
    return fibonacci(n - 1) + fibonacci(n - 2);
  },
  {
    keyGenerator: (n) => `fib:${n}`,
    storage: "memory",
  }
);

console.log(fibonacci(40)); // Computed
console.log(fibonacci(40)); // Cached!

// Clear cache
await fibonacci.clear();
```

`memoize` always returns a Promise and coalesces concurrent calls for the same key. Rejected computations are retried. `clear` and `delete` prevent pending computations from repopulating the cache. Each wrapper has its own cache, including IndexedDB wrappers. Keys are derived from arguments; use a custom key generator when additional context affects the result.

`memoizeSync` returns synchronously, supports memory storage, TTL, LRU eviction, and statistics. Both APIs accept `maxSize: 0` to disable result storage. Cache control methods return Promises.

### Express Middleware

```typescript
import express from "express";
import { cacheFn, expressMiddleware } from "@cachefn/core";

const app = express();
const cache = cacheFn({ name: "api-cache", storage: "memory" });

app.get(
  "/api/users",
  expressMiddleware({
    cache,
    ttl: 60000,
    key: "users:all",
    tags: ["users"],
  }),
  async (req, res) => {
    const users = await db.users.findMany();
    res.json(users);
  }
);

// Invalidate on update
app.post("/api/users", async (req, res) => {
  const user = await db.users.create(req.body);
  await cache.invalidateByTag("users");
  res.json(user);
});
```

### IndexedDB Storage (Browser)

```typescript
import { cacheFn } from "@cachefn/core";

const cache = cacheFn({
  name: "offline-cache",
  storage: "indexeddb",
  defaultTTL: 300000,
});

// Data persists across page reloads
await cache.set("user:profile", userData);
```

## API Reference

### CacheFn Class

#### Constructor

```typescript
const cache = cacheFn({
  name: string;           // Cache instance name
  storage?: 'memory' | 'indexeddb' | 'localstorage' | 'auto';  // Storage backend (default: 'memory')
  maxSize?: number;       // Max entries (memory only, default: 1000)
  defaultTTL?: number;    // Default TTL in ms
  namespace?: string;     // Key namespace prefix
});
```

#### Methods

**Basic Operations**

- `get(key: string): Promise<T | undefined>` - Get a value
- `set(key: string, value: T, options?: SetOptions): Promise<void>` - Set a value
- `has(key: string): Promise<boolean>` - Check if key exists
- `delete(key: string): Promise<boolean>` - Delete a value
- `clear(): Promise<void>` - Clear all values

**Batch Operations**

- `getMany(keys: string[]): Promise<Array<T | undefined>>` - Get multiple values
- `setMany(entries: Array<{key, value, options}>): Promise<void>` - Set multiple values
- `deleteMany(keys: string[]): Promise<void>` - Delete multiple values

**Utility Methods**

- `keys(pattern?: string): Promise<string[]>` - Get all keys (with optional glob pattern)
- `size(): Promise<number>` - Get cache size
- `getOrFetch(key, fetcher, options?): Promise<T>` - Cache-aside pattern
- `touch(key: string): Promise<void>` - Update last access time
- `entries(options?): Promise<Array<{key, value}>>` - Get entries with optional pattern/limit

**Invalidation**

- `invalidate(key: string): Promise<boolean>` - Invalidate a single key
- `invalidateByTag(tag: string): Promise<void>` - Invalidate by tag
- `invalidateByTags(tags: string[]): Promise<void>` - Invalidate by multiple tags
- `invalidateByPattern(pattern: string | RegExp): Promise<void>` - Invalidate by pattern

**Analytics**

- `getStats(): Promise<CacheStats>` - Get cache statistics
- `on(event: string, handler: Function): void` - Register event listener
- `off(event: string, handler: Function): void` - Unregister event listener

### Memoization

```typescript
memoize<T extends (...args: any[]) => any>(
  fn: T,
  options?: {
    keyGenerator?: (...args) => string;
    ttl?: number;
    maxSize?: number;
    storage?: 'memory' | 'indexeddb' | 'localstorage' | 'auto';
    tags?: string[];
  }
): ((...args: Parameters<T>) => Promise<Awaited<ReturnType<T>>>) & {
  clear: () => Promise<void>;
  delete: (...args) => Promise<void>;
  stats: () => Promise<CacheStats>;
}
```

### Middleware

**Express**

```typescript
expressMiddleware({
  cache?: CacheFn;
  ttl?: number;
  key?: string | ((req) => string);
  tags?: string[] | ((req) => string[]);
  condition?: (req) => boolean;
})
```

**Hono**

```typescript
honoMiddleware({
  cache?: CacheFn;
  ttl?: number;
  key?: string | ((c) => string);
  tags?: string[] | ((c) => string[]);
  condition?: (c) => boolean;
})
```

**Fastify**

```typescript
fastifyPlugin(fastify, {
  cache: CacheFn;
})
```

## Events

CacheFn emits events for all cache operations:

```typescript
cache.on("hit", (event) => {
  console.log(`Cache hit: ${event.key} (${event.accessTime}ms)`);
});

cache.on("miss", (event) => {
  console.log(`Cache miss: ${event.key}`);
});

cache.on("set", (event) => {
  console.log(`Set: ${event.key}`);
});

cache.on("delete", (event) => {
  console.log(`Delete: ${event.key}`);
});

cache.on("eviction", (event) => {
  console.log(`Evicted: ${event.key} (${event.reason})`);
});

cache.on("invalidate", (event) => {
  console.log(`Invalidated: ${event.pattern} (${event.count} keys)`);
});
```

## Examples

See the `examples/` directory for complete examples:

- `basic-usage.ts` - Basic cache operations
- `memoization.ts` - Function memoization examples
- `express-api.ts` - Express API with caching
- `browser-app.html` - Browser app with IndexedDB

## Type-Safe Caching

Define a schema for type-safe cache access:

```typescript
type CacheSchema = {
  "user:*": { id: string; name: string; email: string };
  "post:*": { title: string; content: string };
  "session:*": { token: string; userId: string };
};

const cache = cacheFn<CacheSchema>({
  name: "typed-cache",
  storage: "memory",
});

// Inferred as { id: string; name: string; email: string } | undefined.
const user = await cache.get("user:123");
await cache.set("post:1", { title: "Hello", content: "World" });
// cache.set("user:123", { title: "Wrong shape" }); // Compile-time error.
// cache.get("unknown:123"); // Compile-time error.
```

Schema keys support literal strings and `*` wildcards (including multiple wildcards).
Exact entries take precedence over wildcard matches; overlapping wildcard patterns
produce a union of their value types. Batch reads preserve tuple positions when
passed an `as const` tuple, and writes/fetchers are checked against their key.
This is compile-time validation, not runtime validation of external input. Schema
factories use a typed view of the same cache implementation. Existing
`new CacheFn<Value>(config)` consumers retain arbitrary string keys and a uniform
value type; `cacheFn(config)` without a schema remains untyped. Schema types require
TypeScript 5.4 or newer.

## Automatic browser storage

```typescript
const cache = cacheFn({
  name: 'browser-cache',
  storage: 'auto',
  fallbackOrder: ['indexeddb', 'localstorage', 'memory'],
  localStorageMaxBytes: 4 * 1024 * 1024,
  storageProbeTimeoutMs: 1500,
  maxSize: 1000,
});
```

Automatic mode probes each persistent tier by writing, reading, and cleaning up
an isolated temporary cache. The default order is IndexedDB, localStorage, memory.
`fallbackOrder` can reorder or omit persistent tiers; memory always terminates the
sequence, including when explicitly placed earlier. Memory is also the default
backend when `storage` is omitted. Explicit backend modes never silently switch.

Security restrictions, quota exhaustion, and storage availability errors cause
an automatic instance to advance and retry the operation on the next tier.
Unsupported values and programming errors propagate. Selection and operations
are serialized within the instance; it never returns to a failed tier. Probe
timeouts allow selection to continue, with cleanup when the pending probe settles.

Failover does not migrate existing data: entries in the previous tier become cold
misses. Each new instance probes independently and may reuse older persistent data
until its TTL expires. Invalidation/clear affects the currently selected tier only;
it cannot remove inaccessible old-tier data. Use versioned cache names when an
application must prevent reuse after such an invalidation. This is a cache, not a
durable write queue or a synchronization mechanism.

localStorage uses an atomic snapshot per cache name, preserving typed serialized
values, expiration, tags, and metadata. Its default cap is 4 MiB measured as UTF-16
key plus payload bytes, with a default 1,000-entry LRU cap; browsers can impose a
smaller origin quota. Oversized individual values reject in explicit mode and
trigger failover in automatic mode. Caps apply to the entire named snapshot,
including all its namespaces. Namespace reads, clears, and tag invalidation remain
isolated, but capacity eviction can remove entries in another namespace. Use
separate names for independent quotas. Cross-tab updates use last-write-wins
snapshots rather than cross-tab transactions. localStorage is synchronous and
whole-snapshot work is proportional to cache size.

## Adaptive browser memory eviction

```typescript
const cache = cacheFn({
  name: 'adaptive-cache',
  storage: 'memory',
  eviction: 'adaptive',
  memoryMonitoring: { enabled: true, threshold: 0.8, checkInterval: 10000 },
});
await cache.set('prefetch', data, { priority: 'low' });
await cache.set('important', importantData, { priority: 'high' });
await cache.clear({ priority: 'low' }); // optional manual priority clearing
cache.dispose(); // stop monitoring when its owning component/service is released
```

When the browser exposes valid `performance.memory` data at construction, adaptive
mode samples `usedJSHeapSize / jsHeapSizeLimit` every `checkInterval` milliseconds.
A sample strictly above `threshold` removes the lowest remaining priority group:
`low`, then `normal` (the default for entries), then `high`. Each interval removes
at most one group; sustained pressure can eventually remove all groups. Removing
references permits collection but cannot force garbage collection or guarantee
that total browser heap usage falls. Evictions emit `reason: 'memory-pressure'`
and maintain tag indexes and eviction statistics.

Monitoring defaults to enabled with threshold 0.8 and interval 10000 ms when
`eviction: 'adaptive'` is selected. Default `lru` mode retains existing capacity
behavior. Both modes retain LRU eviction at `maxSize`; priorities apply to memory
pressure and explicit filtered clearing. Unsupported browsers, disabled monitors,
and explicit persistent backends allocate no monitoring timer. Automatic storage
monitors only its selected memory tier, never clearing persistent data to address
heap pressure. The heap API is browser-specific and may be unavailable or coarse.

`clear({ priority })` removes only matching entries in the current namespace and
backend, preserving other entries and accumulated statistics. An unfiltered
`clear()` retains its original behavior. `dispose()` is idempotent, stops future
samples, and preserves cached data; call it to release the monitoring timer.
Timers do not keep Node.js processes alive. Monitoring does not implement the
separate offline queue or synchronization requirements.

## Runtime and performance requirements

The build targets ES2021. Use a modern browser with native IndexedDB (for that
backend), Promise, Map/Set, BigInt and `performance.now`, or Node.js 18+ for memory
caching. Explicit `indexeddb` and `localstorage` modes reject unavailable storage;
`auto` probes and falls back as described below. Historical browser version floors from the original design are not a supported compatibility matrix.
See the readiness evidence for the runtimes actually exercised.

Memory lookups and LRU bookkeeping use maps and a linked list. Expiration cleanup,
key enumeration, patterns and tag scans may traverse entries. Latency depends on
cache size, values, browser storage and runtime; original sub-millisecond targets
are design goals, not measured guarantees. `memoryUsage` is an estimate, not a
memory quota. Adaptive eviction uses the browser heap sample described above.

## License

MIT

## Contributing

Contributions are welcome! Please see the main [super-functions repository](https://github.com/21nCo/super-functions) for contribution guidelines.

### Namespace isolation and persistent-cache compatibility

Cache operations (`get`, `keys`, `size`, `entries`, `clear`, and invalidation)
are scoped to the configured namespace. The default namespace (including an
empty namespace string) is isolated from named namespaces. Namespace names may
contain colons or other delimiters: `a`, `a:b`, and the default namespace cannot
overwrite or clear each other's entries in a shared IndexedDB database. Memory
cache instances retain independent storage even when their names match.

Storage keys now use an unambiguous versioned encoding. Existing IndexedDB
entries written with the old `namespace:key` or raw-key encoding are not read by
`CacheFn`: applications will experience a cold cache after upgrading. Ambiguous
legacy keys cannot be safely assigned to namespaces automatically. If reclaiming
that disk space is necessary, delete the old `cachefn-<name>` IndexedDB database
when no application instances are using it, or select a new cache name. Public
keys returned by `keys` and `entries` remain unchanged. Event keys retain the
existing `namespace:key` format (or raw keys in the default namespace); event
strings should not be used as cross-namespace storage identifiers.

IndexedDB promises resolve after their transaction commits and reject on abort.
Expired entries are excluded from key, count, metadata, and tag queries and are
removed during those operations. Tags are stored on each entry, so updates,
replacement, expiration, and deletion cannot leave a separate tag index out of
sync. Tag queries scan entries; choose a bounded cache size appropriate to the
application. Historical `tags` object stores from older versions are ignored.

### Concurrent cache-aside operations

`getOrFetch` shares pending work within a single CacheFn instance. Local writes and invalidation prevent older pending work from overwriting the cache. Coordination does not span separate instances or browser tabs. Tag invalidation conservatively supersedes all pending fills in the instance.

Default memoization keys distinguish primitive types, dates, arrays and plain objects. Cyclic values, functions, symbols and custom objects require a `keyGenerator`. Canonical keys replace short hashes to avoid returning another argument set's result after a hash collision.

`undefined` is a supported cached value. Since `get` also returns it for a miss, use `has` to distinguish presence. Statistics, `entries`, and `getOrFetch` perform that check internally; separate reads are not atomic against concurrent mutation.

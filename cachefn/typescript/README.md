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

The published package remains `@cachefn/core` to preserve existing consumers.
The unscoped npm name `cachefn` belongs to an unrelated maintainer/project; this
is a compatibility exception to the monorepo's plain core-package naming rule.

```bash
npm install @cachefn/core
```

The existing published package remains `@cachefn/core` as a compatibility exception
to the repository's plain-name convention. The npm name `cachefn` belongs to the
unrelated Darkhogg/node-cachefn project; renaming would select a different library
and break existing consumers.

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

## Factory convenience methods

`cacheFn.middleware`, `cacheFn.hono`, and `cacheFn.fastify` refer to the same
implementations as `expressMiddleware`, `honoMiddleware`, and `fastifyPlugin`.
All standalone imports remain supported.

`cacheFn.memoize(fn, options)` preserves synchronous return values with memory
storage, including recursive functions. Promise-returning functions remain
asynchronous, share pending work, retry rejected calls, and start TTL after
successful completion. Persistent storage always returns a Promise. The standalone
`memoize` retains its always-async contract; `memoizeSync` and
`cacheFn.memoizeSync` retain their synchronous, memory-only contract.

```typescript
const increment = cacheFn.memoize((n: number) => n + 1, {
  keyGenerator: n => String(n),
});
increment(1); // 2, synchronously
await increment.cache.set('1', 10);
increment(1); // 10, from the same backing cache
await increment.cache.delete('1');
await cacheFn.memoize.clear(increment); // also available as increment.clear()
```

Factory-memoized functions and standalone async memoized functions expose their
actual `CacheFn` as `.cache`. Its keys are the generated memoization keys. Direct
cache writes, deletes, clears, and tag/pattern invalidations share entries and
invalidate pending fills; `.stats()` and `.cache.getStats()` report the same
counters. The memory convenience cache stores the function's return values, so
Promise-returning functions require Promise-valued manual writes. The standalone
async wrapper and persistent convenience modes store awaited result values.

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
Timers do not keep Node.js processes alive.

## Offline reads, refresh, and queued updates

```typescript
const cache = cacheFn({
  name: 'offline-data',
  storage: 'indexeddb',
  offlineStrategy: 'cache-first',
  offlineQueue: {
    maxSize: 1000,
    sync: async ({ id, key, value, attempt }) => {
      const response = await fetch('/api/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': id },
        body: JSON.stringify({ key, value }),
      });
      if (!response.ok) throw new Error(`Update failed: ${response.status}`);
    },
  },
});
const data = await cache.getOrFetch('api:/data', {
  fetcher: async () => {
    const response = await fetch('/api/data');
    if (!response.ok) throw new Error(`Fetch failed: ${response.status}`);
    return response.json();
  },
  offlineFallback: () => ({ data: [], cached: false }),
});
const id = await cache.queueUpdate('api:/data', updatedData);
const pending = await cache.queuedUpdates();
// await cache.sync(); // retry retained jobs explicitly while online
// await cache.cancelQueuedUpdate(id); // cancel an undelivered job
// await cache.refresh(); // re-fetch registered keys while online
cache.dispose();
```

Both `getOrFetch(key, fetcher, options)` and the object overload prefer a cached
value, including cached `undefined`. In cache-first mode an offline miss invokes
`offlineFallback`, or rejects if none is supplied. Placeholders are returned but
not cached. The object overload's fallback also observes offline state without
requiring the configuration flag. Online fetch failures propagate; navigator's
online flag does not prove that a server is reachable. Node environments without
navigator are treated as online.

**Refresh registration retention:** callbacks are now bounded independently of
cached values. `maxRegisteredFetchers` defaults to 1000 (a nonnegative safe
integer); zero disables retention without disabling `getOrFetch`. After more
unique registered keys, the least recently requested callback is released. This
changes refresh coverage from the previous unbounded registry: applications that
must refresh a larger working set should set an appropriate finite limit and
re-request keys when needed. Normal reads/fetches still succeed at capacity;
registration eviction never deletes cached entries or durable queued writes.

`refresh()` re-fetches the retained keys registered by the object overload or
cache-first `getOrFetch` calls, bypassing cache hits. An explicit request or
callback replacement updates registration recency; background refresh does not.
Concurrent refresh calls share one run. Each traversal snapshots its keys, then
checks the live registration before each fetch: removed/evicted keys are skipped,
replacements use the latest callback, and newly added keys wait for the next
traversal. `cache.unregisterFetcher(key)` releases a registration and returns
whether one existed. It leaves the cached value and queued writes intact; an
already-running request can still finish. A subsequent qualifying `getOrFetch`
registers the key again.
It stops on the first fetch error, preserves previous entries on error, and skips
keys with pending updates. A newer local write/delete suppresses a fetch already
in progress. Registered fetchers are instance-local, so register them again after
reopening. Future explicit refreshes intentionally re-fetch registered keys,
including previously invalidated keys that remain registered. Offline/disposed
refresh calls reject. The ordinary function overload does not retain a callback
unless `offlineStrategy: 'cache-first'` is enabled.

`queueUpdate` is an explicit remote-write operation; ordinary `set` changes only
the cache. It persists a delivery record before applying the optimistic cache
write. A config-level `offlineQueue.sync` handler enables reload persistence on
IndexedDB/localStorage. Records use a separate store for the cache name and
namespace: cache TTL, adaptive/LRU eviction, and `clear()` cannot discard them.
A full queue rejects new jobs instead of evicting old work. Values are serialized
snapshots; unsupported values reject. If the optimistic cache write fails after
record persistence, the job remains visible through `queuedUpdates()` and can be
cancelled or delivered. Queue storage errors propagate rather than silently
falling back and losing work.

Queue storage defaults to the selected backend; `auto` caches use explicit
IndexedDB for their queue. Set `offlineQueue.storage` to `indexeddb`, `localstorage`,
or `memory` to choose explicitly. Memory queues do not survive reload. Per-call
`queueUpdate(key, value, { sync })` callbacks are a convenience for ephemeral jobs;
closures cannot be restored after reload. Do not use them for durable updates.
Use one active delivery owner per named queue; coordinate ownership across tabs
or workers in the application. The SDK does not provide a distributed consumer
lease or cross-tab conflict resolution.

Online construction with a configured queue, an `online` event, or a new online
queued update triggers delivery. Reconnection syncs queued writes before refreshing
registered reads. `sync()` delivers FIFO and is single-flight within the instance.
Success removes the persisted job; failure retains it, increments its attempt
count, and blocks later jobs until an explicit retry, a later online event, or
cancellation. `queuedUpdates()` reports pending/syncing/failed state; the exception
object is instance-local, while status and attempts persist. `synced` and
`sync-error` events expose background outcomes.

Delivery is at least once: an acknowledgement may be lost after the server commits
but before the queue record is removed. The stable job `id` must be used by the
server for idempotency. Server version checks/conflict resolution belong in the
handler; rejecting a conflict retains the job. A handler's return value never
overwrites newer optimistic local data. Cancellation refuses an active delivery,
removes an undelivered record, and does not roll back its local value. Deleting a
cache entry does not cancel a separately queued remote update.

`dispose()` detaches online listeners, clears retained refresh callbacks, and
stops starting queued deliveries and refreshes. Later `getOrFetch` calls retain
the existing one-shot read behavior but do not register callbacks or cache late
results on the disposed instance. An already-running remote request may finish and acknowledge its job;
remaining durable jobs survive for a reconstructed instance. It also prevents
late refresh results from writing into the cache. Disposal cannot retract a
remote operation that the server has already accepted.

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

## Ecosystem integration examples

[examples/ecosystem.ts](examples/ecosystem.ts) demonstrates current package APIs:

- SearchFn's `@searchfn/adapter-memory` with option-aware cached queries and
  resource-tag invalidation after indexing/removal. Requests with caller-owned
  abort signals bypass shared fills to preserve cancellation ownership.
- AuthFn's `AuthFnServer.provider.authenticate` on every request, caching only
  non-authoritative per-user profile data. Revoking a session still rejects the
  next request even while profile data remains cached.
- BotFn's `@superfunctions/botfn-slack-core` signature verification before
  concurrent event deduplication. This is process-local retry protection, not
  distributed exactly-once delivery. Failed processing is not cached.

From this monorepo, run `npm --prefix cachefn/typescript run test:ecosystem`.
The script typechecks and bundles the current workspace source packages, then runs
actual indexing, issued/revoked AuthFn sessions, and signed Slack requests without
external services. It tests source integration, not registry publication or live
provider delivery. No runtime dependencies are added to CacheFn itself. TestFn fixture integration uses Vitest's `beforeAll`/`afterAll` lifecycle hooks,
with the public `testFn(config).run()` API executing the actual framework tests.
The original specification's `testFn.beforeAll`/`afterAll` calls are not exported
by TestFn. Run the fixture acceptance with built CacheFn and an explicit TestFn build:

```sh
CACHEFN_TESTFN_CORE=/absolute/path/to/testfn/typescript/dist/index.js node cachefn/typescript/scripts/testfn-acceptance.mjs
```

The script validates cached fixture reuse, concurrent consumers, cleanup after
success and failure, and propagation of an intentional failed assertion. It uses
the installed Vitest CLI; it does not replace the framework with a fake adapter.
TestFn source is tracked but omitted from the current sparse checkout. The
recorded run used the sibling TestFn readiness build, not a published package.

Run `npm --prefix cachefn/typescript run test:coverage` for the four V8 coverage
metrics; the V0 specification's general 95% claim does not identify a metric.
A fresh consumer of locally packed CacheFn/TestFn/shared dependencies also passes
the same fixture lifecycle and failure checks. Run it with already built packages:

```sh
CACHEFN_TESTFN_WORKTREE=/absolute/path/to/testfn-readiness-worktree node cachefn/typescript/scripts/testfn-packed-acceptance.mjs
```

`CACHEFN_NPM_CLI` optionally selects an installed npm CLI JavaScript entrypoint.
The recorded run used npm11.21.0 after npm10.8.2 encountered an internal
`edgesOut` resolution failure, without force or legacy peer flags. SDK and Vitest
resolution is checked inside the disposable consumer; no workspace module aliases
are used. Registry publication and native Safari/Firefox host acceptance remain; WebKit acceptance is not native Safari evidence.


### Unpublished dependency validation

CacheFn admin 0.1.0 requires `@cachefn/core` 0.0.3 and shared admin 0.1.5,
which in turn requires MCP core 0.0.6. Publish the prerequisite packages before
installing CacheFn admin from the registry. For pre-publication validation, build
and pack both shared prerequisites, then run from this package:

```sh
MCP_CORE_TARBALL=/absolute/path/mcpfn-core-0.0.6.tgz SHARED_ADMIN_TARBALL=/absolute/path/superfunctions-admin-0.1.5.tgz node scripts/delivery-acceptance.mjs
```

The script copies CacheFn into a disposable workspace, installs the explicit
tarballs, builds/typechecks/tests both packages, verifies packed consumers, and
audits the isolated production graph. It leaves repository manifests and lockfile
unchanged. Set `PLAYWRIGHT_MODULE_PATH` to run browser acceptance too;
`BROWSER_ENGINE=webkit` selects WebKit instead of Chromium.

If npm 10 encounters its `edgesOut` workspace-resolution failure with Vitest 4,
set `NPM_CLI=/absolute/path/to/npm11/bin/npm-cli.js` for this isolated validation.

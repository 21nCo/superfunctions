# CacheFn TypeScript SDK

> Self-hosted caching solution with multi-tier storage and function memoization

CacheFn is a developer-first caching library that provides memory and IndexedDB storage, intelligent invalidation strategies, function memoization, and framework middleware - all with zero external dependencies.

## Features

✅ **Zero Dependencies** - No Redis, Memcached, or external services required  
✅ **Multi-tier Storage** - Memory and IndexedDB backends  
✅ **Type-Safe** - Full TypeScript support with type inference  
✅ **Function Memoization** - Cache expensive function results  
✅ **Tag-based Invalidation** - Flexible cache invalidation strategies  
✅ **Framework Middleware** - Express, Hono, and Fastify support  
✅ **Analytics** - Built-in hit/miss tracking and statistics  
✅ **Browser + Node.js** - Works everywhere

## Installation

```bash
npm install cachefn
```

## Quick Start

### Basic Usage

```typescript
import { cacheFn } from "cachefn";

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
await cache.set("session:abc", sessionData, {
  ttl: 3600000, // 1 hour
  tags: ["sessions", "user:123"],
});

// Invalidate by tag
await cache.invalidateByTag("sessions");
```

### Function Memoization

```typescript
import { memoize } from "cachefn";

// Memoize a function
const fibonacci = memoize(
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

### Express Middleware

```typescript
import express from "express";
import { cacheFn, expressMiddleware } from "cachefn";

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
import { cacheFn } from "cachefn";

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
  storage?: 'memory' | 'indexeddb';  // Storage backend (default: 'memory')
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
    storage?: 'memory' | 'indexeddb';
    tags?: string[];
  }
): T & {
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

// TypeScript knows the return type!
const user = await cache.get("user:123");
```

## Performance

- **Memory Cache**: <1ms access time
- **IndexedDB Cache**: 1-10ms access time
- **LRU Eviction**: O(1) operations
- **Pattern Matching**: O(n) where n = total keys

## Browser Support

- Chrome/Edge 24+
- Firefox 16+
- Safari 10+
- Node.js 18+

## License

MIT

## Contributing

Contributions are welcome! Please see the main [super-functions repository](https://github.com/21nCo/super-functions) for contribution guidelines.

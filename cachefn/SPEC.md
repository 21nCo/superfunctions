# CacheFn Full Specification

> Comprehensive self-hosted caching platform for developers

## Overview

CacheFn is a developer-first caching solution that combines multi-tier caching, intelligent invalidation strategies, function memoization, and analytics into a single self-hosted platform. It builds on the super-functions ecosystem, reusing proven patterns from searchfn, testfn, and secfn.

**Version**: 1.0.0  
**Target Release**: Q2 2026  
**Status**: Specification

## Core Philosophy

- **Self-hosted first**: No Redis/Memcached dependencies, works anywhere
- **Browser AND Node.js**: Platform-specific optimizations with unified API
- **Developer experience**: Simple SDK, works locally, minimal configuration
- **Multi-tier by default**: Automatic optimization across memory, disk, and database
- **Comprehensive**: Function memoization, API caching, query results, and custom strategies
- **Performance**: Sub-millisecond cache hits, efficient memory usage
- **Type-safe**: First-class TypeScript support with full type inference
- **Composable**: Built for the super-functions ecosystem with seamless integrations
- **Zero-config hybrid caching**: Intelligent tier management out of the box

## Architecture

```
cachefn/
├── ts-sdk/
│   ├── src/
│   │   ├── core/              # Cache orchestration & coordination
│   │   ├── storage/           # Multi-tier storage backends
│   │   ├── strategies/        # Eviction & invalidation strategies
│   │   ├── serialization/     # Compression & encoding
│   │   ├── memoization/       # Function result caching
│   │   ├── middleware/        # Framework integrations
│   │   ├── distributed/       # Pub/sub & coordination
│   │   ├── analytics/         # Metrics & monitoring
│   │   ├── query-cache/       # Database query caching
│   │   └── utils/             # Hashing, key generation
│   └── examples/
├── py-sdk/                    # Python SDK (future)
├── dashboard/                 # Static HTML cache inspector
└── cli/                       # Cache management CLI
```

## Storage Tiers

### Tier 1: Memory Cache
**Performance**: <1ms access time  
**Capacity**: RAM-limited (configurable)  
**Persistence**: None (session-only)  
**Use cases**: Hot data, frequently accessed values

**Implementation**:
- LRU/LFU/FIFO eviction policies
- Configurable max size (count or bytes)
- TTL support with lazy cleanup
- Reuse patterns from `searchfn/src/cache/lru-cache.ts`

### Tier 2: IndexedDB Cache
**Performance**: 1-10ms access time  
**Capacity**: Hundreds of MB per origin  
**Persistence**: Survives page reloads  
**Use cases**: Browser apps, offline-first, user preferences

**Implementation**:
- Reuse `searchfn/src/storage/indexeddb-manager.ts` patterns
- Structured storage with indexes
- Batch operations for performance
- Background cleanup workers

### Tier 3: File System Cache
**Performance**: 5-50ms access time  
**Capacity**: GB+ (disk-limited)  
**Persistence**: Survives restarts  
**Use cases**: Server-side apps, build artifacts, large assets

**Implementation**:
- Directory-based storage with hash sharding
- Atomic writes with temp files
- File-based locking for concurrent access
- Automatic cleanup based on disk usage

### Tier 4: Database Cache
**Performance**: 10-100ms access time  
**Capacity**: Unlimited (cloud DB)  
**Persistence**: Distributed, replicated  
**Use cases**: Multi-instance apps, shared caches

**Implementation**:
- Integration with `@superfunctions/db`
- Support for PostgreSQL, SQLite, MySQL
- Connection pooling and prepared statements
- Pub/sub for cross-instance invalidation

### Hybrid Tier Strategy
**Automatic tier promotion/demotion**:
- Hot data promoted to faster tiers
- Cold data demoted to cheaper tiers
- Access pattern analysis
- Cost-aware optimization

```typescript
interface HybridCacheConfig {
  tiers: CacheTier[];
  promotionThreshold: number;
  demotionThreshold: number;
  syncStrategy: 'write-through' | 'write-behind' | 'write-around';
  replicationFactor?: number;
}

const cache = cacheFn({
  storage: 'hybrid',
  tiers: [
    { type: 'memory', maxSize: 1000, maxBytes: 50 * 1024 * 1024 },
    { type: 'indexeddb', maxSize: 10000, maxBytes: 500 * 1024 * 1024 },
    { type: 'db', maxSize: 100000 }
  ],
  promotionThreshold: 10,
  demotionThreshold: 2
});
```

## Core Features

### 1. Basic Cache Operations

```typescript
interface CacheFnConfig {
  name: string;
  storage: 'memory' | 'indexeddb' | 'file' | 'db' | 'hybrid';
  maxSize?: number;
  maxMemorySize?: number;
  eviction?: 'lru' | 'lfu' | 'fifo' | 'ttl' | 'custom';
  defaultTTL?: number;
  compression?: boolean | 'auto';
  serialization?: 'json' | 'msgpack' | 'custom';
  analytics?: boolean;
  namespace?: string;
}

const cache = cacheFn({
  name: 'app-cache',
  storage: 'hybrid',
  maxSize: 10000,
  eviction: 'lru',
  defaultTTL: 3600000,
  compression: 'auto',
  analytics: true
});

await cache.set('user:123', userData, { 
  ttl: 60000, 
  tags: ['user', 'profile'],
  priority: 'high'
});

const value = await cache.get('user:123');

const exists = await cache.has('user:123');

await cache.delete('user:123');

await cache.clear();
```

### 2. Advanced Cache Patterns

#### Stale-While-Revalidate
```typescript
const data = await cache.getOrFetch('api:/posts', {
  strategy: 'stale-while-revalidate',
  ttl: 60000,
  staleWhileRevalidate: 300000,
  fetcher: async () => {
    return await fetch('/api/posts').then(r => r.json());
  }
});
```

#### Cache-Aside (Lazy Loading)
```typescript
const getUser = async (id: string) => {
  return await cache.getOrFetch(`user:${id}`, {
    fetcher: async () => await db.users.findById(id),
    ttl: 300000
  });
};
```

#### Write-Through
```typescript
await cache.set('product:456', product, {
  writeThrough: true,
  persister: async (key, value) => {
    await db.products.upsert({ id: '456', data: value });
  }
});
```

#### Write-Behind (Async)
```typescript
const cache = cacheFn({
  name: 'write-behind',
  storage: 'memory',
  writeBehind: {
    enabled: true,
    flushInterval: 5000,
    maxBatchSize: 100,
    persister: async (entries) => {
      await db.bulkUpsert(entries);
    }
  }
});
```

#### Read-Through
```typescript
const cache = cacheFn({
  name: 'read-through',
  storage: 'memory',
  readThrough: {
    enabled: true,
    loader: async (keys) => {
      return await db.findMany(keys);
    }
  }
});

const value = await cache.get('user:789');
```

### 3. Function Memoization

```typescript
interface MemoizeOptions<T> {
  keyGenerator?: (...args: any[]) => string;
  ttl?: number;
  maxSize?: number;
  storage?: StorageType;
  serialize?: boolean;
  tags?: string[];
  condition?: (...args: any[]) => boolean;
}

const fibonacci = cacheFn.memoize(
  (n: number): number => {
    if (n <= 1) return n;
    return fibonacci(n - 1) + fibonacci(n - 2);
  },
  {
    keyGenerator: (n) => `fib:${n}`,
    ttl: Infinity,
    storage: 'memory'
  }
);

const expensiveAPI = cacheFn.memoize(
  async (userId: string, options: object) => {
    return await complexAPICall(userId, options);
  },
  {
    keyGenerator: (userId, options) => `api:${userId}:${hash(options)}`,
    ttl: 60000,
    serialize: true,
    condition: (userId, options) => !options.skipCache
  }
);

const result = await expensiveAPI('user123', { filter: 'active' });

cacheFn.memoize.clear(expensiveAPI);

cacheFn.memoize.delete(expensiveAPI, 'user123', { filter: 'active' });
```

### 4. Invalidation Strategies

#### Time-Based (TTL)
```typescript
await cache.set('session:abc', sessionData, { ttl: 3600000 });
```

#### Tag-Based
```typescript
await cache.set('post:1', post1, { tags: ['posts', 'user:123'] });
await cache.set('post:2', post2, { tags: ['posts', 'user:456'] });

await cache.invalidateByTag('posts');

await cache.invalidateByTags(['user:123', 'posts']);
```

#### Dependency-Based
```typescript
await cache.set('user:123', user, {
  dependencies: ['roles:admin', 'settings:global']
});

await cache.invalidate('roles:admin');
```

#### Pattern-Based
```typescript
await cache.invalidateByPattern('user:*');

await cache.invalidateByPattern(/^session:\d+$/);
```

#### Event-Driven
```typescript
cache.on('user.updated', async (event) => {
  await cache.invalidate(`user:${event.userId}`);
  await cache.invalidateByTag(`user:${event.userId}`);
});

emitEvent('user.updated', { userId: '123' });
```

#### Conditional Invalidation
```typescript
await cache.invalidateWhere((key, value, metadata) => {
  return metadata.tags?.includes('stale') || 
         value.lastModified < Date.now() - 86400000;
});
```

### 5. Batch Operations

```typescript
await cache.setMany([
  { key: 'user:1', value: user1, options: { ttl: 60000 } },
  { key: 'user:2', value: user2, options: { ttl: 60000 } },
  { key: 'user:3', value: user3, options: { ttl: 60000 } }
]);

const users = await cache.getMany(['user:1', 'user:2', 'user:3']);

await cache.deleteMany(['user:1', 'user:2']);

const allKeys = await cache.keys();

const userKeys = await cache.keys('user:*');

const entries = await cache.entries({ 
  pattern: 'session:*', 
  limit: 100 
});
```

### 6. Query Result Caching

```typescript
interface QueryCacheConfig {
  storage: StorageType;
  maxEntries: number;
  defaultTTL: number;
  keyGenerator?: (query: string, params: any[]) => string;
  normalizer?: (query: string) => string;
}

const queryCache = cacheFn.createQueryCache({
  storage: 'indexeddb',
  maxEntries: 5000,
  defaultTTL: 120000,
  normalizer: (query) => query.toLowerCase().replace(/\s+/g, ' ')
});

const users = await queryCache.query(
  'SELECT * FROM users WHERE active = ? AND role = ?',
  [true, 'admin'],
  {
    ttl: 300000,
    tags: ['users', 'admin-users']
  }
);

await queryCache.invalidateByTable('users');

await queryCache.invalidateByPattern('SELECT * FROM users*');
```

### 7. HTTP Response Caching

```typescript
import { cacheFn } from 'cachefn';
import express from 'express';

const app = express();

app.get('/api/users', 
  cacheFn.middleware({
    ttl: 60000,
    key: (req) => `users:page:${req.query.page}`,
    vary: ['Authorization', 'Accept-Language'],
    condition: (req) => req.method === 'GET' && !req.headers['cache-control']?.includes('no-cache'),
    tags: (req) => ['users', 'api'],
    storage: 'memory'
  }),
  async (req, res) => {
    const users = await db.users.findMany();
    res.json(users);
  }
);

app.post('/api/users/:id/invalidate', async (req, res) => {
  await cacheFn.invalidateByTag('users');
  res.json({ success: true });
});
```

### 8. Distributed Caching

```typescript
interface DistributedCacheConfig extends CacheFnConfig {
  pubsub: {
    type: 'redis' | 'nats' | 'db';
    url?: string;
    channel?: string;
  };
  coordination: {
    lockTimeout?: number;
    heartbeatInterval?: number;
  };
  replication?: {
    factor: number;
    strategy: 'primary-backup' | 'multi-primary';
  };
}

const distributedCache = cacheFn.createDistributed({
  name: 'shared-cache',
  storage: 'db',
  pubsub: {
    type: 'db',
    channel: 'cache-events'
  },
  coordination: {
    lockTimeout: 5000
  }
});

await distributedCache.set('shared:config', config);

await distributedCache.lock('resource:123', async () => {
  const value = await distributedCache.get('resource:123');
  await processResource(value);
});
```

### 9. Cache Warming & Preloading

```typescript
interface WarmingStrategy {
  type: 'scheduled' | 'predictive' | 'manual';
  schedule?: string;
  predictor?: (history: AccessPattern[]) => string[];
  priority?: 'high' | 'medium' | 'low';
}

const cache = cacheFn({
  name: 'warmed-cache',
  storage: 'hybrid',
  warming: {
    enabled: true,
    strategies: [
      {
        type: 'scheduled',
        schedule: '0 6 * * *',
        fetcher: async () => {
          return await db.popularProducts.findMany();
        }
      },
      {
        type: 'predictive',
        predictor: (history) => {
          return history
            .filter(p => p.hits > 100)
            .map(p => p.key);
        }
      }
    ]
  }
});

await cache.warm(['user:123', 'user:456'], {
  fetcher: async (keys) => await db.users.findMany(keys),
  priority: 'high'
});

const warmingStatus = await cache.getWarmingStatus();
```

### 10. Compression & Serialization

```typescript
interface CompressionConfig {
  enabled: boolean;
  algorithm: 'gzip' | 'brotli' | 'lz4' | 'zstd';
  minSize: number;
  level?: number;
}

interface SerializationConfig {
  format: 'json' | 'msgpack' | 'protobuf' | 'custom';
  customSerializer?: {
    serialize: (value: any) => Buffer;
    deserialize: (buffer: Buffer) => any;
  };
}

const cache = cacheFn({
  name: 'compressed-cache',
  storage: 'indexeddb',
  compression: {
    enabled: true,
    algorithm: 'lz4',
    minSize: 1024,
    level: 5
  },
  serialization: {
    format: 'msgpack'
  }
});

await cache.set('large:dataset', bigData);
```

### 11. Analytics & Monitoring

```typescript
interface CacheStats {
  hits: number;
  misses: number;
  hitRate: number;
  sets: number;
  deletes: number;
  evictions: number;
  size: number;
  memoryUsage: number;
  avgAccessTime: number;
  p50AccessTime: number;
  p95AccessTime: number;
  p99AccessTime: number;
}

interface CacheAnalytics {
  topKeys: Array<{ key: string; hits: number; lastAccess: number }>;
  coldKeys: Array<{ key: string; hits: number; size: number }>;
  memoryDistribution: Record<string, number>;
  evictionHistory: Array<{ key: string; reason: string; timestamp: number }>;
  invalidationHistory: Array<{ pattern: string; count: number; timestamp: number }>;
}

const stats = await cache.getStats();

const analytics = await cache.getAnalytics({
  timeRange: { start: Date.now() - 86400000, end: Date.now() },
  includeTopKeys: 100,
  includeColdKeys: 50
});

cache.on('hit', (event) => {
  console.log(`Cache hit: ${event.key} (${event.accessTime}ms)`);
});

cache.on('miss', (event) => {
  console.log(`Cache miss: ${event.key}`);
});

cache.on('eviction', (event) => {
  console.log(`Evicted: ${event.key} (reason: ${event.reason})`);
});

const report = await cache.generateReport({
  format: 'html',
  period: '24h',
  includeRecommendations: true
});
```

### 12. Custom Eviction Policies

```typescript
interface EvictionPolicy {
  name: string;
  shouldEvict: (entry: CacheEntry, context: EvictionContext) => boolean;
  selectVictim: (entries: CacheEntry[]) => CacheEntry;
}

const customPolicy: EvictionPolicy = {
  name: 'cost-aware',
  shouldEvict: (entry, context) => {
    const cost = entry.size * (Date.now() - entry.lastAccess);
    return context.memoryPressure > 0.8 && cost > threshold;
  },
  selectVictim: (entries) => {
    return entries.reduce((victim, entry) => {
      const victimCost = victim.size * (Date.now() - victim.lastAccess);
      const entryCost = entry.size * (Date.now() - entry.lastAccess);
      return entryCost > victimCost ? entry : victim;
    });
  }
};

const cache = cacheFn({
  name: 'custom-eviction',
  storage: 'memory',
  eviction: 'custom',
  evictionPolicy: customPolicy
});
```

### 13. Browser-First Optimizations

Following **searchfn**'s browser-first approach, cachefn provides native browser caching capabilities:

#### Service Worker Integration
```typescript
import { cacheFn } from 'cachefn';
import { registerCacheServiceWorker } from 'cachefn/sw';

const swCache = await registerCacheServiceWorker({
  scope: '/api',
  strategies: {
    '/api/users': 'cache-first',
    '/api/posts': 'stale-while-revalidate',
    '/api/realtime': 'network-only'
  },
  precache: ['/api/config', '/api/user/me'],
  maxAge: 86400000
});

await swCache.invalidate('/api/posts');
```

#### Cache Storage API
```typescript
const cache = cacheFn({
  name: 'offline-cache',
  storage: 'cache-storage',
  cacheName: 'app-cache-v1',
  maxEntries: 500
});

await cache.set('https://api.example.com/data', response, {
  headers: true,
  status: 200
});

const cachedResponse = await cache.get('https://api.example.com/data');
```

#### LocalStorage Fallback
```typescript
const cache = cacheFn({
  name: 'persistent-cache',
  storage: 'auto',
  fallbackOrder: ['indexeddb', 'localstorage', 'memory'],
  quota: 5 * 1024 * 1024
});
```

#### Memory-Conscious Eviction
```typescript
const cache = cacheFn({
  name: 'browser-cache',
  storage: 'memory',
  eviction: 'adaptive',
  memoryMonitoring: {
    enabled: true,
    threshold: 0.8,
    checkInterval: 10000,
    onPressure: (level) => {
      if (level > 0.9) {
        cache.clear({ priority: 'low' });
      }
    }
  }
});

if (performance.memory) {
  const usage = performance.memory.usedJSHeapSize / performance.memory.jsHeapSizeLimit;
  console.log(`Memory usage: ${(usage * 100).toFixed(2)}%`);
}
```

#### Offline-First Patterns
```typescript
const offlineCache = cacheFn({
  name: 'offline-first',
  storage: 'hybrid',
  tiers: [
    { type: 'memory', maxSize: 100 },
    { type: 'indexeddb', maxSize: 1000 },
    { type: 'cache-storage', maxSize: 5000 }
  ],
  offlineStrategy: 'cache-first-network-fallback'
});

const data = await offlineCache.getOrFetch('api:/data', {
  fetcher: async () => {
    const response = await fetch('/api/data');
    if (!navigator.onLine) {
      throw new Error('Offline');
    }
    return await response.json();
  },
  offlineFallback: (error) => {
    return { cached: true, data: [] };
  }
});
```

### 14. Type-Safe Caching

```typescript
type CacheSchema = {
  'user:profile': { id: string; name: string; email: string };
  'post:*': { title: string; content: string; author: string };
  'search:results': Array<{ id: string; score: number }>;
  'config:*': Record<string, any>;
};

const typedCache = cacheFn<CacheSchema>({
  name: 'typed-cache',
  storage: 'indexeddb'
});

const profile = await typedCache.get('user:profile');

const post = await typedCache.get('post:123');

await typedCache.set('user:profile', {
  id: '123',
  name: 'John Doe',
  email: 'john@example.com'
});

const searchResults = await typedCache.get('search:results');
```

### 15. Middleware & Plugin System

```typescript
import { cacheFn } from 'cachefn';
import { loggingMiddleware } from 'cachefn/middleware/logging';
import { compressionMiddleware } from 'cachefn/middleware/compression';
import { encryptionMiddleware } from 'cachefn/middleware/encryption';
import { metricsMiddleware } from 'cachefn/middleware/metrics';

const cache = cacheFn({
  name: 'app-cache',
  storage: 'hybrid'
});

cache.use(loggingMiddleware({
  level: 'info',
  includeValues: false
}));

cache.use(compressionMiddleware({
  algorithm: 'brotli',
  minSize: 1024,
  level: 6
}));

cache.use(encryptionMiddleware({
  key: process.env.ENCRYPTION_KEY,
  algorithm: 'aes-256-gcm'
}));

cache.use(metricsMiddleware({
  provider: 'prometheus',
  labels: { service: 'api', env: 'production' }
}));

const customMiddleware = {
  name: 'custom',
  async onGet(key, context, next) {
    console.log(`Getting: ${key}`);
    const value = await next();
    console.log(`Got: ${key}`);
    return value;
  },
  async onSet(key, value, options, context, next) {
    console.log(`Setting: ${key}`);
    await next();
    console.log(`Set: ${key}`);
  }
};

cache.use(customMiddleware);
```

### 16. Advanced Integration Patterns

#### Cache-Aside with Automatic Invalidation
```typescript
import { cacheFn } from 'cachefn';
import { db } from './database';

const userCache = cacheFn({
  name: 'users',
  storage: 'memory',
  defaultTTL: 300000
});

db.on('users.updated', async (userId) => {
  await userCache.invalidate(`user:${userId}`);
  await userCache.invalidateByTag(`user:${userId}`);
});

db.on('users.deleted', async (userId) => {
  await userCache.delete(`user:${userId}`);
});

const getUser = async (id: string) => {
  return await userCache.getOrFetch(`user:${id}`, {
    fetcher: async () => await db.users.findById(id),
    tags: [`user:${id}`, 'users']
  });
};
```

#### Multi-Level Cache with Fallback Chain
```typescript
const l1Cache = cacheFn({ name: 'l1', storage: 'memory', maxSize: 100 });
const l2Cache = cacheFn({ name: 'l2', storage: 'indexeddb', maxSize: 1000 });
const l3Cache = cacheFn({ name: 'l3', storage: 'db', maxSize: 10000 });

const getWithFallback = async (key: string) => {
  let value = await l1Cache.get(key);
  if (value) return value;

  value = await l2Cache.get(key);
  if (value) {
    await l1Cache.set(key, value);
    return value;
  }

  value = await l3Cache.get(key);
  if (value) {
    await l2Cache.set(key, value);
    await l1Cache.set(key, value);
    return value;
  }

  value = await fetchFromSource(key);
  await Promise.all([
    l1Cache.set(key, value),
    l2Cache.set(key, value),
    l3Cache.set(key, value)
  ]);
  return value;
};

const multiLevelCache = cacheFn.createMultiLevel({
  levels: [l1Cache, l2Cache, l3Cache],
  strategy: 'write-through',
  promoteOnHit: true
});

const value = await multiLevelCache.get('user:123');
```

#### Progressive Cache Warming
```typescript
const cache = cacheFn({
  name: 'progressive-warm',
  storage: 'hybrid',
  warming: {
    enabled: true,
    progressive: {
      enabled: true,
      batchSize: 50,
      delayBetweenBatches: 1000,
      priority: 'background'
    }
  }
});

await cache.warmProgressive(popularUserIds, {
  fetcher: async (ids) => {
    return await db.users.findMany(ids);
  },
  onProgress: (completed, total) => {
    console.log(`Warmed ${completed}/${total} entries`);
  },
  onComplete: () => {
    console.log('Cache warming complete');
  }
});
```

## Integration Examples

### With SearchFn
```typescript
import { SearchFn } from 'searchfn';
import { cacheFn } from 'cachefn';

const searchCache = cacheFn({
  name: 'search-cache',
  storage: 'memory',
  maxSize: 1000
});

const cachedSearch = cacheFn.memoize(
  async (query: string) => {
    const engine = new SearchFn({ name: 'docs', fields: ['content'] });
    return await engine.search(query);
  },
  {
    keyGenerator: (query) => `search:${query}`,
    ttl: 300000
  }
);

const searchEngine = new SearchFn({ name: 'docs', fields: ['title', 'content'] });

searchEngine.on('index:updated', async () => {
  await searchCache.invalidateByTag('search');
});

const resultCache = cacheFn({
  name: 'search-results',
  storage: 'indexeddb',
  defaultTTL: 600000
});

const search = async (query: string, options: any = {}) => {
  return await resultCache.getOrFetch(`search:${query}:${hash(options)}`, {
    fetcher: async () => {
      const results = await searchEngine.search(query, options);
      return results;
    },
    tags: ['search', `query:${query}`],
    ttl: options.fresh ? 0 : 600000
  });
};

const tokenCache = cacheFn({
  name: 'tokenization-cache',
  storage: 'memory',
  maxSize: 10000
});

const cachedTokenize = cacheFn.memoize(
  (text: string) => searchEngine.tokenize(text),
  { keyGenerator: (text) => `token:${hash(text)}`, storage: tokenCache }
);
```

### With AuthFn
```typescript
import { authFn } from 'authfn';
import { cacheFn } from 'cachefn';

const sessionCache = cacheFn({
  name: 'sessions',
  storage: 'indexeddb',
  defaultTTL: 3600000
});

authFn.use(async (ctx, next) => {
  const cached = await sessionCache.get(`session:${ctx.sessionId}`);
  if (cached) {
    ctx.user = cached;
    return next();
  }
  
  const user = await authFn.verifySession(ctx.sessionId);
  await sessionCache.set(`session:${ctx.sessionId}`, user);
  ctx.user = user;
  return next();
});

const permissionCache = cacheFn({
  name: 'permissions',
  storage: 'memory',
  defaultTTL: 900000
});

const hasPermission = async (userId: string, permission: string) => {
  return await permissionCache.getOrFetch(`perm:${userId}:${permission}`, {
    fetcher: async () => await authFn.checkPermission(userId, permission),
    tags: [`user:${userId}`, 'permissions']
  });
};

const tokenValidationCache = cacheFn({
  name: 'token-validation',
  storage: 'memory',
  defaultTTL: 300000
});

const validateToken = cacheFn.memoize(
  async (token: string) => await authFn.verify(token),
  {
    keyGenerator: (token) => `token:${hash(token)}`,
    storage: tokenValidationCache
  }
);

const rateLimitCache = cacheFn({
  name: 'rate-limits',
  storage: 'memory',
  defaultTTL: 60000
});

const checkRateLimit = async (userId: string, action: string) => {
  const key = `ratelimit:${userId}:${action}`;
  const current = await rateLimitCache.get(key) || 0;
  
  if (current >= 100) {
    throw new Error('Rate limit exceeded');
  }
  
  await rateLimitCache.set(key, current + 1, { ttl: 60000 });
};
```

### With TestFn
```typescript
import { testFn } from 'testfn';
import { cacheFn } from 'cachefn';

const fixtureCache = cacheFn({
  name: 'test-fixtures',
  storage: 'file',
  compression: true
});

testFn.beforeAll(async () => {
  const cached = await fixtureCache.get('large-dataset');
  if (!cached) {
    const data = await generateLargeDataset();
    await fixtureCache.set('large-dataset', data);
    return data;
  }
  return cached;
});

const snapshotCache = cacheFn({
  name: 'visual-snapshots',
  storage: 'file',
  serialization: { format: 'custom' },
  compression: { enabled: true, algorithm: 'brotli' }
});

testFn.visualTest('homepage renders correctly', async () => {
  const screenshot = await takeScreenshot();
  const baseline = await snapshotCache.get('homepage-baseline');
  
  if (!baseline) {
    await snapshotCache.set('homepage-baseline', screenshot);
    return;
  }
  
  const diff = await compareImages(screenshot, baseline);
  expect(diff.percentage).toBeLessThan(0.1);
});

const testMetadataCache = cacheFn({
  name: 'test-metadata',
  storage: 'db',
  defaultTTL: Infinity
});

testFn.afterEach(async (result) => {
  await testMetadataCache.set(`test:${result.id}`, {
    duration: result.duration,
    status: result.status,
    timestamp: Date.now()
  });
});
```

### With BotFn
```typescript
import { botFn } from 'botfn';
import { cacheFn } from 'cachefn';

const discordResponseCache = cacheFn({
  name: 'discord-responses',
  storage: 'memory',
  defaultTTL: 300000
});

botFn.on('messageCreate', async (message) => {
  const cacheKey = `discord:msg:${message.content}`;
  
  const cached = await discordResponseCache.get(cacheKey);
  if (cached) {
    await message.reply(cached);
    return;
  }
  
  const response = await generateResponse(message.content);
  await discordResponseCache.set(cacheKey, response);
  await message.reply(response);
});

const conversationCache = cacheFn({
  name: 'conversation-context',
  storage: 'indexeddb',
  defaultTTL: 3600000
});

const getConversationContext = async (userId: string) => {
  return await conversationCache.get(`conversation:${userId}`) || [];
};

const webhookDedupeCache = cacheFn({
  name: 'webhook-dedupe',
  storage: 'memory',
  defaultTTL: 60000
});

botFn.on('webhook', async (payload) => {
  const payloadHash = hash(payload);
  
  if (await webhookDedupeCache.has(payloadHash)) {
    console.log('Duplicate webhook, ignoring');
    return;
  }
  
  await webhookDedupeCache.set(payloadHash, true);
  await processWebhook(payload);
});
```

### With SecFn
```typescript
import { secFn } from 'secfn';
import { cacheFn } from 'cachefn';
import { encryptionMiddleware } from 'cachefn/middleware/encryption';

const secureCache = cacheFn({
  name: 'secure-cache',
  storage: 'indexeddb'
});

secureCache.use(encryptionMiddleware({
  key: await secFn.getEncryptionKey(),
  algorithm: 'aes-256-gcm'
}));

await secureCache.set('user:sensitive', sensitiveData);

const auditCache = cacheFn({
  name: 'audit-logs',
  storage: 'db',
  defaultTTL: Infinity
});

auditCache.on('set', async (event) => {
  await secFn.log('cache.set', {
    key: event.key,
    userId: event.context.userId,
    timestamp: Date.now()
  });
});

const credentialCache = cacheFn({
  name: 'credentials',
  storage: 'memory',
  defaultTTL: 300000
});

const getCredential = async (service: string) => {
  return await credentialCache.getOrFetch(`cred:${service}`, {
    fetcher: async () => {
      const encrypted = await secFn.getSecret(service);
      return await secFn.decrypt(encrypted);
    },
    ttl: 300000
  });
};
```

## Unique Differentiators

CacheFn stands out in the caching ecosystem with several key innovations:

### 1. Unified API Across All Storage Tiers
Single, consistent interface whether using memory, IndexedDB, file system, or database storage. No need to learn different APIs for different storage backends.

```typescript
const memCache = cacheFn({ storage: 'memory' });
const dbCache = cacheFn({ storage: 'db' });

await memCache.set('key', value);
await dbCache.set('key', value);
```

### 2. Zero-Config Hybrid Caching
Intelligent automatic tier management without manual configuration. The cache automatically promotes hot data to faster tiers and demotes cold data to cheaper tiers based on access patterns.

```typescript
const cache = cacheFn({ storage: 'hybrid' });
```

### 3. First-Class TypeScript Support
Full type inference with schema definitions, catching cache key typos and type mismatches at compile time.

```typescript
type Schema = { 'user:*': User; 'post:*': Post };
const cache = cacheFn<Schema>();
const user = await cache.get('user:123');
```

### 4. Browser AND Node.js with Platform-Specific Optimizations
Not just a Node.js library ported to browsers. Native browser APIs (Service Worker, Cache Storage API, IndexedDB) with fallbacks and Node.js file system optimizations.

### 5. Composable with Other SuperFunctions
Purpose-built to integrate seamlessly with searchfn, authfn, testfn, botfn, and secfn. Shared patterns, types, and infrastructure.

### 6. Self-Hosted First
No external dependencies like Redis or Memcached required. Works anywhere JavaScript runs - from edge functions to embedded devices.

### 7. Developer Experience Focused
- Simple API that works out of the box
- Comprehensive TypeScript types
- Built-in analytics and monitoring
- Clear error messages and debugging support
- Extensive documentation and examples

### 8. Advanced Invalidation Strategies
Not just TTL-based expiration. Tag-based, dependency-based, pattern-based, event-driven, and conditional invalidation strategies built-in.

### 9. Function Memoization as First-Class Citizen
Not an afterthought - memoization is a core feature with advanced key generation, conditional caching, and serialization support.

### 10. Production-Ready Observability
Built-in metrics, analytics, performance monitoring, and debugging tools. No need to integrate external APM solutions.

## Performance Targets

- **Memory cache**: <1ms (p99)
- **IndexedDB cache**: <10ms (p99)
- **File cache**: <50ms (p99)
- **Database cache**: <100ms (p99)
- **Compression overhead**: <20% of access time
- **Memory efficiency**: <100 bytes per entry overhead
- **Batch operations**: 10,000+ ops/sec
- **Concurrent access**: 1,000+ operations/sec
- **Cache warmup**: <100ms for 1000 entries
- **Serialization overhead**: <5% of total access time

## Security Considerations

- Encryption at rest for sensitive data
- Key namespacing to prevent collisions
- Access control integration with authfn
- Audit logging for cache operations
- Rate limiting for cache mutations
- DoS protection via max entry limits

## Testing Strategy

- Unit tests for each storage tier
- Integration tests with framework adapters
- Performance benchmarks vs Redis/Memcached
- Browser compatibility tests (Chrome, Firefox, Safari)
- Memory leak detection
- Concurrent access stress tests
- Distributed cache coordination tests

## Documentation Requirements

### Core Documentation
- **Getting started guide**: Zero-to-production in 5 minutes
- **API reference**: Complete TypeScript API documentation with examples
- **Migration guide**: From Redis, Memcached, and other caching solutions
- **Performance tuning guide**: Optimization strategies for different use cases
- **Best practices**: Patterns and anti-patterns
- **Troubleshooting guide**: Common issues and solutions

### Framework Integration Guides
- Next.js / React
- Express / Hono / Fastify
- Cloudflare Workers / Deno Deploy
- Electron / Tauri
- Chrome Extensions
- Service Workers

### Advanced Topics
- **Multi-tier caching strategies**: When to use hybrid vs single-tier
- **Distributed caching**: Coordination and consistency patterns
- **Cache warming**: Predictive and scheduled warming strategies
- **Observability**: Metrics, monitoring, and debugging
- **Security**: Encryption, access control, and audit logging
- **Testing**: How to test cached applications

### Integration Documentation
- **With SearchFn**: Search result caching, tokenization caching
- **With AuthFn**: Session management, permission caching, rate limiting
- **With TestFn**: Fixture caching, snapshot management
- **With BotFn**: Response caching, conversation context
- **With SecFn**: Encrypted caching, credential management

### Code Examples
- Basic usage examples
- Real-world use cases (API caching, database query caching)
- Performance benchmarks
- Comparison with other solutions
- Interactive playground

## License

Apache-2.0

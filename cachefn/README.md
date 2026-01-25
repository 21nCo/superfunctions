# CacheFn

> Self-hosted caching platform for developers

CacheFn is a developer-first caching solution that combines multi-tier caching, intelligent invalidation strategies, function memoization, and analytics into a single self-hosted platform.

## Status

- **Version**: 0.1.0 (V0)
- **TypeScript SDK**: ✅ Complete
- **Python SDK**: ✅ Complete

## Features

✅ **Zero Dependencies** - No Redis, Memcached, or external services required  
✅ **Multi-tier Storage** - Memory and IndexedDB backends  
✅ **Type-Safe** - Full TypeScript support with type inference  
✅ **Function Memoization** - Cache expensive function results  
✅ **Tag-based Invalidation** - Flexible cache invalidation strategies  
✅ **Framework Middleware** - Express, Hono, and Fastify support  
✅ **Analytics** - Built-in hit/miss tracking and statistics  
✅ **Browser + Node.js** - Works everywhere

## Quick Start

### Installation

```bash
cd cachefn/ts-sdk
npm install
```

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

// Invalidate by tag
await cache.set("session:abc", sessionData, {
  ttl: 3600000,
  tags: ["sessions", "user:123"],
});
await cache.invalidateByTag("sessions");
```

### Function Memoization

```typescript
import { memoize } from "cachefn";

const fibonacci = memoize(
  (n: number): number => {
    if (n <= 1) return n;
    return fibonacci(n - 1) + fibonacci(n - 2);
  },
  { keyGenerator: (n) => `fib:${n}` }
);

console.log(fibonacci(40)); // Computed
console.log(fibonacci(40)); // Cached!
```

## Documentation

- **TypeScript SDK**: See [ts-sdk/README.md](ts-sdk/README.md) for complete API documentation
- **Full Specification**: See [SPEC.md](SPEC.md) for the complete feature roadmap
- **V0 Specification**: See [V0_SPEC.md](V0_SPEC.md) for current implementation details

## Examples

See the `ts-sdk/examples/` directory:

- `basic-usage.ts` - Basic cache operations
- `memoization.ts` - Function memoization examples
- `express-api.ts` - Express API with caching
- `browser-app.html` - Browser app with IndexedDB

## Architecture

```
cachefn/
├── ts-sdk/          # TypeScript SDK (v0.1.0)
│   ├── src/         # Source code
│   ├── __tests__/   # Tests (37 passing)
│   └── examples/    # Usage examples
├── python/          # Python SDK (planned)
├── SPEC.md          # Full specification
└── V0_SPEC.md       # V0 specification
```

## Development

### Build

```bash
cd ts-sdk
npm run build
```

### Test

```bash
npm test
```

### Type Check

```bash
npm run typecheck
```

## Integration with SuperFunctions

CacheFn integrates seamlessly with other superfunctions:

- **SearchFn**: Cache search results
- **AuthFn**: Cache sessions and permissions
- **TestFn**: Cache test fixtures
- **BotFn**: Cache bot responses

See the [V0_SPEC.md](V0_SPEC.md) for integration examples.

## License

MIT

## Contributing

Contributions are welcome! Please see the main [super-functions repository](https://github.com/21nCo/super-functions) for contribution guidelines.

# CacheFn

> Self-hosted caching platform for developers

CacheFn is a developer-first caching solution that combines multi-tier caching, intelligent invalidation strategies, function memoization, and analytics into a single self-hosted platform.

## Status

- TypeScript: `@cachefn/core` 0.0.2 (memory and IndexedDB), `@cachefn/admin` 0.1.0.
- Python: `cachefn` 0.0.1 (memory storage).
- Production-readiness validation is in progress. `SPEC.md` describes the broader roadmap; `V0_SPEC.md` is the original design, and the SDK READMEs describe the implemented APIs.

## Features

✅ **No external cache service** - No Redis, Memcached, or external services required\
✅ **Multi-tier Storage** - Memory and IndexedDB backends\
✅ **Type-Safe** - Full TypeScript support with type inference\
✅ **Function Memoization** - Cache expensive function results\
✅ **Tag-based Invalidation** - Flexible cache invalidation strategies\
✅ **Framework Middleware** - Express, Hono, and Fastify support\
✅ **Analytics** - Built-in hit/miss tracking and statistics\
✅ **Browser + Node.js** - Works everywhere

## Quick Start

### Installation

```bash
cd cachefn/typescript
npm install
```

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

// Invalidate by tag
await cache.set("session:abc", { userId: "123" }, {
  ttl: 3600000,
  tags: ["sessions", "user:123"],
});
await cache.invalidateByTag("sessions");
```

### Function Memoization

```typescript
import { memoizeSync } from "@cachefn/core";

const fibonacci = memoizeSync(
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

- **TypeScript SDK**: See [typescript/README.md](typescript/README.md) for complete API documentation
- **Full Specification**: See [SPEC.md](SPEC.md) for the complete feature roadmap
- **V0 Specification**: See [V0_SPEC.md](V0_SPEC.md) for the original design

## Examples

See the `typescript/examples/` directory:

- `basic-usage.ts` - Basic cache operations
- `memoization.ts` - Function memoization examples
- `express-api.ts` - Express API with caching
- `browser-app.html` - Browser app with IndexedDB

## Architecture

```
cachefn/
├── typescript/          # TypeScript SDK
│   ├── src/         # Source code
│   ├── __tests__/   # Tests
│   └── examples/    # Usage examples
├── python/          # Python SDK
├── SPEC.md          # Full specification
└── V0_SPEC.md       # V0 specification
```

## Development

### Build

```bash
cd typescript
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

TypeScript: MIT. Python: Apache-2.0 (see `python/LICENSE`).

## Contributing

Contributions are welcome! Please see the main [super-functions repository](https://github.com/21nCo/super-functions) for contribution guidelines.

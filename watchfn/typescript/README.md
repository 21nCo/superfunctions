# WatchFn core

Install `@watchfn/core` for collection, storage and the shared HTTP router. Framework integrations use explicit subpaths, so a core-only installation does not install Express, Fastify, Hono, Next.js or SvelteKit.

```ts
import { watchFn } from '@watchfn/core';

const watch = watchFn({ name: 'api', storage: 'memory', infra: { enabled: false } });
watch.start();
// Mount watch.httpRouter using the shared adapter for your framework.
// Before shutdown, await watch.stop() to finish admitted writes.
```

For Express, install `express` and `@superfunctions/http-express`. Mount the shared router with its adapter and import request tracking separately:

```ts
import express from 'express';
import { toExpress } from '@superfunctions/http-express';
import { createExpressMiddleware } from '@watchfn/core/adapters/express';

const app = express();
app.use(createExpressMiddleware(watch));
app.use('/watch', toExpress(watch.httpRouter));
```

Equivalent integration entry points are `@watchfn/core/adapters/fastify`, `/hono`, `/next`, and `/sveltekit`. Install the corresponding framework and `@superfunctions/http-<framework>` package when using that integration. Integration-specific router helpers remain available from these subpaths.

## Import migration

Framework helpers are no longer exported from the package root. Change, for example, `import { createExpressMiddleware } from '@watchfn/core'` to `import { createExpressMiddleware } from '@watchfn/core/adapters/express'`. Core imports such as `watchFn`, `WatchFn`, and `createWatchFnRouter` remain at the root. Both ESM and CommonJS runtime entry points are provided.

## Readiness limits

This is an ongoing readiness branch. Native provider, lifecycle, query aggregation and other original specification gates remain open. SvelteKit's currently resolved dependency graph has a low-severity `cookie` advisory with no automatic npm fix. Keeping that integration optional avoids installing it for unrelated core consumers; it does not remediate the SvelteKit-specific advisory.

## Storage lifecycle

`track()` and capture methods remain synchronous. Call `await watch.flush()` to wait for writes admitted before the call and receive retained storage failures. `await watch.stop()` closes collection immediately, removes owned listeners and waits for admitted writes, including complete ingestion batches. Restart only after that promise settles. A failed stop retains failures for a later flush; flush reports and consumes them. Querying previously stored data after stop remains supported.

Storage adapters must settle their writes: shutdown has no timeout, and bounded failure retention/backpressure are still pending. Process-fatal exception monitoring preserves Node's default exit behavior; it cannot guarantee asynchronous persistence before the process exits. Node rejection policies that avoid fatal escalation require explicit capture.

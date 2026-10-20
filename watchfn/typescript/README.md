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

## Canonical bug reports and BotFn issues

Opt in with `botfn` to transactionally persist canonical CatchFn/WatchFn `bug_report` events with a delivery outbox. Use a durable shared DB adapter with transactions, configure an ingestion API key, and migrate both `getWatchFnSchema()` and `getBugIssueSchema()` before enabling intake. WatchFn wraps the incoming adapter with those schemas internally; do not pass `adapterSchema` yourself.

This is **one trusted application/API-key boundary**. Every holder of the configured Watch API key can choose any configured app route and query all stored events. `namespace` separates outbox identities, claims and status; it does not provide tenant isolation for Watch's existing query API. Use separate deployments and databases for mutually untrusted tenants.

```ts
import { WatchFn, getWatchFnSchema, getBugIssueSchema } from '@watchfn/core';
import { GitHubClient } from '@botfn/github-integration';

// Apply your database migration using this combined schema before accepting traffic.
const schema = { ...getWatchFnSchema(), ...getBugIssueSchema() };
const watch = new WatchFn({
  name: 'checkout', storage: 'database', database,
  auth: { apiKey: process.env.WATCH_INGEST_KEY! },
  botfn: {
    namespace: 'checkout-production',
    routes: [{ app: 'checkout', target: 'github', project: 'acme/bugs',
      client: new GitHubClient({ appId, installationId, privateKey }) }],
  },
});
watch.start();
// Mount watch.httpRouter with the shared HTTP adapter. Schedule this on the server:
await watch.processBugIssues(20);
const status = await watch.getBugIssueStatus({ app: 'checkout', reportId });
// An operator may recover an ambiguous create only by verifying the existing issue:
await watch.reconcileBugIssue({ app: 'checkout', reportId }, '123');
await watch.stop();
```

A Linear route uses `target: 'linear'`, `project: teamId`, and BotFn's `LinearClient`. The existing BotFn packages expose TypeScript source; use the repository build/runtime configuration that supports those clients. No BotFn provider credential or request-client object is persisted by WatchFn.

Clients may send `integration: { target: 'github', project: 'acme/bugs' }` only to select a matching server route. With one matching route, the hint is optional. Client-supplied `issueId`/`issueUrl` are rejected when this integration is enabled. HTTP 202 means canonical event and pending delivery state are committed, **not that an issue already exists**. Same namespace/app/report ID and identical content deduplicates; changed content returns 409. Each report is its own transaction: a later failure in a batch can follow earlier committed reports. Retry canonical reports with their original IDs and content.

Delivery claims use database CAS and leases. A failed, timed-out, expired or malformed create outcome enters `reconciliation` and is never automatically created again. The privileged server reconciliation method reads the selected issue from the configured provider and verifies repository/team, report marker, issue ID and allowed HTTPS URL before atomically linking it back into the canonical event. Do not expose these server methods without your own operator authorization. Querying the canonical event after linkage returns its `integration.issueId` and `integration.issueUrl`.

Scheduling and migration remain the host's responsibility. `processBugIssues` examines at most 1–100 candidates per call (default 20); repeat calls to drain the queue and recover expired leases. `stop()` waits for already admitted work; it does not automatically process pending reports. The default provider wait is 10 seconds and lease is 30 seconds. Linear's existing client does not accept an abort signal, and existing BotFn clients parse full provider JSON: a timeout bounds worker waiting, not all network activity or provider-response memory. Unknown remote side effects require operator reconciliation. See [the migration, acceptance and remaining limits](../.conduct/botfn-issue-readiness.md).

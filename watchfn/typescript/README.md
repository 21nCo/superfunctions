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

Authenticated clients can read `POST /issues/status` with `{app,reportId}` to obtain pending/processing/reconciliation/linked state and verified provider linkage. It returns 404 for an absent report and 503 if issue integration is unavailable. This read-only route uses the same full Watch API key as ingestion and query; it does not expose operator reconciliation. The browser package's `readBugIssueStatus` derives `/mount/issues/status` from `/mount/ingest`, or accepts an explicit `issueStatusEndpoint` for custom routes. Reads are bounded and cancelable; see [status-read behavior](../.conduct/issue-status-readiness.md).

### Canonical event indexes and existing databases

The shared database schema includes type/app/time, type/app/severity, issue, session and replay indexes. Apply the additive nullable columns and indexes from `getWatchFnSchema()` before starting the new writer. Existing reports remain visible through a compatibility scan until an offline, idempotent `DatabaseStorage.backfillEventProjections({ after, limit })` traversal completes. Stop writers, workers and queries during backfill; continue with `nextCursor` until null. Never manually mark partial projections complete. See [the migration contract and tested SQLite DDL](../.conduct/event-index-readiness.md).

Only conservative exact-field and time-range predicates are pushed down. Tags, broad result sets and aggregations can still require memory proportional to matching events. Indexes alone do not implement retention; canonical arrival-time cleanup is available through the explicit policy below.

### Canonical retention and bug-report TTL

Configure `retention: { apps: ["shop"], defaultTtlMs: 30 * 86400000, bugReportTtlMs: 90 * 86400000 }` on shared transactional database storage, then schedule bounded `watch.cleanupRetention({ after, limit })` calls, following `nextCursor` until null. The default is 30 days; bugs inherit it unless overridden. TTL uses server arrival time and the fixed application allowlist. Cleanup has no public HTTP route or automatic timer.

Apply the new nullable `receivedAt` column before starting the writer. Old rows remain protected until an explicit offline anchor backfill. Unresolved issue deliveries remain protected; linked payloads may expire while outbox receipts remain indefinitely to preserve exact-replay deduplication and verified status. See [migration, failure semantics and limits](../.conduct/event-retention-readiness.md). General non-app metrics, hybrid-tier retention and receipt archival remain open.

### Query memory and ordering

Shared-database queries now read bounded 128-row keyset pages. Projected and
legacy compatibility candidates are merged in storage-ID order; no input limit
is pushed ahead of residual filtering or aggregation. Queries with `limit` and
no `orderBy` retain only the requested result rows while still completing the
scan so a later storage failure cannot acknowledge an incomplete query.

Count, sum, min, max and rate retain per-group counters rather than event
payloads. Exact averages and percentiles retain finite numeric samples; distinct
counts retain scalar sets. Group order, exact floating-point arithmetic, metric
suffix fallback, filtering, and post-aggregation ordering/limits are preserved.

This does not make every query bounded in memory. Unlimited raw results and
ordered raw results still materialize output/candidates. Numeric sample counts,
distinct cardinality, group cardinality and individual payload size can also
consume memory. Projected scans perform an ID-only ordering preflight; incompatible
custom database collations or legacy IDs use the original materialized sort
before returning any rows. Legacy `queryEvents` adapters still return arrays.
Keyset reads are live across pages, not a snapshot of concurrent writes or
retention cleanup. See [native query acceptance and remaining limits](../.conduct/query-streaming-readiness.md).

### Durable alert lifecycle

`watch.alerts` now persists definitions, notes, acknowledgement and resolution
with the shared database adapter. Migrate the exported `getAlertSchema()` tables
before use. Run `await watch.alerts.evaluate()` and
`await watch.alerts.processNotifications()` from your host scheduler; both accept
bounded pages and participate in shutdown draining. Configure `alerts.emailSender`
or `alerts.pagerDutySender` for those channels, including after restart. Webhook
and Slack destinations supplied at creation are retained in the database; public
alert results hide their credentials. Memory storage remains process-local.

See [public alert manager behavior and remaining limits](../.conduct/public-alert-manager-readiness.md)
for cap, recovery, delivery and credential-storage semantics.

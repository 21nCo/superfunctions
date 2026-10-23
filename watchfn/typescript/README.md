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
bounded pages and participate in shutdown draining. Email currently requires
`alerts.emailSender`, including after restart. PagerDuty has a built-in Events v2
client; `alerts.pagerDutySender` remains a legacy host-owned override. Webhook
and Slack destinations supplied at creation are retained in the database; public
alert results hide their credentials. Memory storage remains process-local.

See [public alert manager behavior and remaining limits](../.conduct/public-alert-manager-readiness.md)
for cap, recovery, delivery and credential-storage semantics.

Alert definition updates replace optional metadata and recovery policy; omitted
`enabled` retains its current value. Evaluation conflicts when an alert changes
during its observation scan and must be retried with fresh observations. Missing
database or unsupported hybrid alert storage fails explicitly. Sender completion
after its deadline or lease expiry does not acknowledge delivery; providers should
deduplicate by notification ID where supported. Unknown provider outcomes, expired
leases, and failed receipt commits are never permission for automatic replay.

### Separate HTTP credentials by operation

The TypeScript server accepts an `auth.provider` implementing the shared
`@superfunctions/auth` `AuthProvider` contract. The provider authenticates each
request and returns a valid `AuthSession` with explicit scopes:

- `watchfn:ingest` permits `/ingest`.
- `watchfn:query` permits `/query`.
- `watchfn:issues:status` permits `/issues/status`.

Use your server-side AuthFn/provider integration to issue ingestion-only browser
credentials; add issue-status scope only when the reporter needs issue links.
Operator credentials can separately receive query scope. Provider authentication
runs before body parsing. Missing/malformed/expired sessions return401, missing
scope returns403, and provider failures return a sanitized503. Wildcard scopes
are not implicitly granted. A configured provider takes precedence over the
legacy `apiKey`, with no fallback, and cannot be combined with `enabled:false`.
The synchronous `authorizeIngest` compatibility method returnsfalse when a
provider is configured; HTTP routes use asynchronous `authorizeHttp` instead.

Without a provider, existing API-key/no-auth configuration retains its behavior.
Keep the legacy full-access key server-side. Provider lifecycle, key rotation,
revocation, authentication deadlines and origin/rate policy are host-owned.
These scopes are operation-level authority within one trusted deployment, not
per-app or tenant filtering: a query-scoped session can query all retained data,
and status scope can look up configured apps' report IDs. Session resource IDs
and tenant metadata do not automatically restrict those reads. Use separate
trusted storage/deployments for mutually untrusted tenants until tenant-aware
query enforcement is implemented. Programmatic methods are trusted host APIs;
health remains public. Python HTTP routes do not yet implement this contract.

Scalar suffix aggregates preserve exact metric precedence before residual filters.
For example, an existing `request.duration` event outside the selected time range
prevents interpreting in-range `request` events' `duration` fields as that metric.
Filtered suffix queries first probe the unfiltered storage iterator for exact
presence, stopping at the first match, then retain the ordinary projected query
for aggregation. Other query forms are unchanged. Database pages remain bounded
at128 rows, but an absent exact metric can require an additional full scan; this
is a memory bound, not a total-row or latency bound. The probe and candidate scan
are live and do not provide a transactional snapshot across concurrent changes.

Alert observation exact-name precedence is scoped to each condition's requested window. An
out-of-window exact event no longer suppresses dotted-property fallback in memory;
this corrects a discrepancy with projected database reads. In-window exact events
still suppress fallback even when their value is invalid. Scalar aggregate's
unfiltered global exact-name precedence is unchanged.

### Alert dispatcher ownership migration

Migrate all tables returned by `getAlertSchema()`, including
`watchfn_alert_runtime`, before lifecycle or delivery operations. Stop and drain
all older writers first: historical releases cannot enforce the current ownership
rules. Current TS mutation/dispatch owns `ts-v3`, while Python owns `python-v2`;
each rejects the other protocol before mutation or sending. Read-only inspection
remains available. Existing rows without a marker require explicit ownership
migration; the runtime does not infer ownership from the missing marker.

For a stopped **ts-v1** namespace without unresolved legacy PagerDuty jobs or active
incidents, call `await watch.alerts.migrateStoppedLegacyNamespace({limit:100})`.
This trusted host operation reads at most `limit+1` alerts and jobs (limit1..1000)
and rejects overflow, unexpected receipts, or legacy PagerDuty obligations before
changing state. In one shared transaction it parks attempted non-PD jobs unknown,
retains pending counts, and conditionally advances the exact marker. It never sends
notifications or fabricates incident identifiers. Larger namespaces and legacy PD
obligations require explicit offline migration; this API does not silently remove
them. No migration is safe while old writers or provider operations remain active.

### Built-in PagerDuty Events v2

The specification's `type:'pagerduty'`, `integrationKey`, and optional channel
`severity` work without a sender callback. The host may configure a trusted
`alerts.pagerDutyEndpoint`; it defaults to PagerDuty's official HTTPS endpoint.
Keep routing keys in trusted definitions and protect database payloads at rest.
Public lists/notifications expose metadata; successful or reconciled receipts
remove routing credentials. No hosted provider is contacted during local tests.

Each triggered incident persists an episode and stable dedup key. Acknowledgement
and resolution wait for a retained delivered predecessor on the same route. A new
incident waits for the prior resolution, then uses a different dedup key. Routes
cannot change while an incident or unresolved route obligation remains. Missing
legacy episode metadata fails before claim. Channel severity overrides alert
severity. The bounded client accepts only a202 JSON success response with the
expected dedup key; this proves API acceptance, not human notification.

`notifications()` now retains delivered/dismissed receipts and exposes `outcome`.
Unknown/rejected deliveries remain counted against the pending cap. Reconcile
only after independent verification:

```typescript
await watch.alerts.reconcileNotification(jobId, {
  outcome: 'delivered', // or 'dismissed'; dismissal does not unblock a PD successor
  actor: 'operator',
  reason: 'Provider acceptance independently verified',
});
```

`dismissNotification(id)` remains an explicit legacy dismissal wrapper. Delivered
reconciliation can unblock a predecessor chain; dismissal cannot assert provider
acceptance. Terminal receipts have no automatic TTL. Use the bounded host-driven
receipt maintenance described below; route tails and unresolved obligations remain pinned.

Dispatch pages use `after`/`nextCursor`. Traverse all pages and start a new scan to
avoid starving jobs behind missing senders or blocked predecessors. Slack retries
only a validated429 Retry-After rejection; transport failures, callback errors,
5xx responses and expired leases park unknown without replay. Legacy callbacks
must settle and honor AbortSignal; arbitrary callbacks cannot provide a hard
shutdown deadline or built-in Events v2 response validation.

Shared Kysely SQLite body contention can retry a DB-only transaction at most three
times with a50ms monotonic retry scheduling budget and short jitter. The exact
callback sentinel must propagate only after rollback; COMMIT-stage, rollback,
unrecognized and exhausted failures remain visible. This budget does **not** bound
individual database lock waits or rollback duration. Provider I/O and listeners
remain outside retried transaction closures. The shared memory adapter's existing
serialization is retained, without a second queue in WatchFn.

See [TS durable PagerDuty acceptance](../.conduct/ts-pagerduty-readiness.md).

### Bounded receipt maintenance

Successful/dismissed receipts are eligible for explicit host maintenance:

```typescript
let after: { completedAt: number; id: string } | undefined;
do {
  const page = await watch.alerts.pruneNotifications({
    completedBefore: Date.now() - 30 * 24 * 60 * 60 * 1000, // host policy, example only
    limit: 100,
    after,
  });
  after = page.nextCursor ?? undefined;
} while (after);
```

The boundary is exclusive and must not be in the future. No default receipt TTL
is imposed. The host must schedule maintenance and finish all cursor pages, then
start a fresh scan on its next scheduled run. Equal timestamps use the full ID as
a compound cursor; IDs are not truncated. Page limits are 1..1000. This bounds
work and returned rows per call, not database lock time or total disk usage.

Pending, sending, unknown and rejected jobs are never deleted. Current PagerDuty
route tails are always pinned. Incoming operational predecessor references also
pin receipts, including dismissed work that still blocks a successor. Authoritative
delivered receipts release their own predecessor dependency while keeping episode,
route and predecessor history in their payload. A shared transaction conditionally
advances the owning alert revision before deleting an unpinned terminal receipt;
concurrent lifecycle operations cannot introduce a lost predecessor. Pruning never
refunds pending counts or resends notifications. Dismissed blocked chains can remain
indefinitely; maintenance is not a hard capacity guarantee. Hosts need storage
monitoring/admission policy and explicit incident reconciliation.

**Schema and protocol upgrade:** install the current Watch-owned schema additions
and indexes before maintenance: outbox `completedAt`, `predecessorId`, and runtime
`migrationPhase`, `migrationCursor`, `migrationRevision`. Runtime is now `ts-v3`;
Python's independent namespace runtime is `python-v2`. Stop and drain *all* old
writers and provider operations first. Then repeatedly call
`await watch.alerts.migrateReceiptRetention({limit:100})` on an exact `ts-v2`
namespace until `done` is true. Each transaction persists a bounded keyset page
through backfill, alert-tail validation and dependency validation. The intermediate
marker fences creation, lifecycle, dispatch and pruning; read-only inspection and
`receiptRetentionStatus()` remain available. A crash resumes the saved phase and
cursor. Invalid/missing dependencies fail without advancing that page. Repair and
restart requirements must be assessed offline; do not rewrite the marker to bypass
validation. Migration activates `ts-v3` only after all phases finish. Empty new
namespaces claim `ts-v3` directly. The older bounded `ts-v1` migration remains a
separate first step to `ts-v2`, with its legacy PagerDuty/overflow restrictions.

Native SQLite acceptance checks the receipt range, incoming dependency and keyset
indexes; equivalent physical indexes must be applied by hosts for other adapters.
The schema wrapper does not automatically migrate a production database. Projection
integrity assumes cooperating supported writers on an owned database. Missing or
inconsistent projections encountered by dispatch/maintenance fail closed.
See [receipt-retention acceptance](../.conduct/receipt-retention-readiness.md).

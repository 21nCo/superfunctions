# ContentFn

ContentFn stores structured content with datasets, schemas, drafts, optimistic patches,
publication, revision history, assets, webhooks, scheduled publication, and live events.
The TypeScript packages share the root Superfunctions workspace; there is no Python SDK.

```ts
import { createContentfnServer } from '@contentfn/server';
import { memoryAdapter } from '@superfunctions/db/adapters/memory';

const content = createContentfnServer({
  db: memoryAdapter(),
  authorize: async (context, action, resource) => true, // replace with application policy
  search: { enabled: true },
  webhooks: { maxAttempts: 5, timeoutMs: 10_000 },
});
await content.api.datasets.create({ dataset: 'production' });
await content.api.schema.upsert({
  dataset: 'production',
  schema: { version: 1, documentTypes: [{ name: 'article', fields: [
    { name: 'title', type: { kind: 'primitive', type: 'string' }, required: true },
  ] }] },
});
const created = await content.api.docs.create({
  dataset: 'production', id: 'welcome', type: 'article',
  doc: { title: 'Welcome' }, asDraft: true,
});
if (created.ok) await content.api.docs.publish({
  dataset: 'production', id: 'welcome', ifRev: created.result._rev,
});
```

Use a persistent shared database adapter in production. ContentFn applies its own
schema internally; consumers do not supply `adapterSchema`. SQLite JSON fields use
DB 0.4.0's explicit text codec. The incoming adapter must support transactions.
Use the shared HTTP framework adapter with `content.router`, or use
`content.handler` with Node's HTTP server. There are no re-exported framework adapters.
The router's `/contentfn` prefix must remain reachable under the client's base URL.

`authorize(context, action, resource)` applies to HTTP and programmatic calls.
Bind application context with `content.forContext(context)`; HTTP can use the
`context(request)` resolver. Without an authorization callback, access is unrestricted.
Deployments must restrict schema changes, imports, asset uploads, webhook registration,
and `webhooks.deliveries` to their appropriate roles. A context `subject` is recorded
as the actor. Webhook destinations are application-authorized network destinations;
redirects are refused and each request has a timeout.

## Client and CLI

```ts
import { createContentfnClient } from '@contentfn/client';
const client = createContentfnClient({ baseUrl: 'https://cms.example.com' });
const page = await client.docs.query({ dataset: 'production', types: ['article'] });
```

The typed client uses fetch in browsers and Node, supports request headers,
credentials and timeout configuration, and returns canonical success/error envelopes.
Expected validation, authorization and storage failures are envelopes. Inspect `ok`
before accessing `result`. HTTP mutation requests can provide `Idempotency-Key`;
reusing a key with different input fails, while replaying the same input returns the
stored result. Idempotency records are durable database data.

The `contentfn` CLI supports schema validation/upsert, dataset export/import, and
document get/patch. Run `contentfn --help`; configure `--server` or `CONTENTFN_SERVER`.

## Content rules

System identity and revision fields are generated internally. Patches cannot change
system fields. Required values reject null/undefined; optional null values are allowed.
Numeric min/max rules bound numbers and string/array lengths. Regex/enum rules apply
to text, and unique arrays compare structural JSON values independent of object key
order. Dates use YYYY-MM-DD; datetimes require an ISO timezone. Incompatible schema
rules fail at schema upsert. Nested objects and array unions are validated recursively.

Strong references must resolve to a declared target type. Missing weak references
require both schema `weak: true` and document `_weak: true`; existing targets must
still have the declared type. Draft references resolve draft first, then published.
Markdown normalization uses the shared MDFn packages without mutating input values.

Schema updates are backward compatible by default: updates that invalidate existing
content fail. An explicit `migration: { description: '...' }` acknowledges a planned
breaking migration; migrate the data with ordinary validated writes. Old revisions
remain readable, while restored/published content must satisfy the current schema.
The description acknowledges operator-owned migration steps; it does not execute them.

Queries use deterministic ordering with an ID tie-breaker, bounded projection
expansion, and cursor pagination. Enabled text matching uses normalized whole tokens
with AND semantics; disabled matching returns `QUERY_INVALID`. Search is evaluated
against dataset documents in process; plan deployment capacity accordingly.

## Durable work and live events

Schedule a captured draft revision with `docs.schedule({ dataset, id, publishAt })`.
The deployment scheduler calls `content.processScheduledPublishes()` periodically.
Schedules survive restart; a draft changed after scheduling fails rather than
publishing unapproved edits. Cancellation uses `docs.cancelSchedule`.

The deployment worker calls `content.processWebhookQueue()` periodically. Events and
subscribed deliveries are persisted in the mutation transaction. Retries use capped
exponential backoff and the configured attempt ceiling. Query the last 100 entries
for a webhook with `webhooks.deliveries({ dataset, webhookId })`; this returns status
and sanitized failure summaries, never its signing secret. Receivers should deduplicate
by eventId because delivery is at least once. Signing uses X-ContentFn-Signature.

GET `/contentfn/events?dataset=production` opens an authenticated SSE stream;
`docId` optionally filters it. `client.realtime.subscribe` exposes an async iterable.
Connections receive live content changes and presence join/leave events when the
context supplies a subject. Disconnect/abort releases subscriptions. The live stream
has bounded buffering and heartbeat comments; reconnect and query current content
after interruption. It does not provide a persisted replay cursor.

## Assets, backups, and credentials

Configure `createAssetStorageBackend` with a shared `@superfunctions/storage` adapter,
a target/prefix and a `urlForKey` function, or provide an `AssetStorageBackend`.
The default memory storage is for development. Uploads enforce payload limits and
persist metadata. Binary object storage and SQL are separate systems: operators must
reconcile orphan objects after an SQL failure and retain objects needed by backups.
Exports include asset metadata/URLs; back up binary objects separately.

Exports preserve document/revision snapshots and deterministic collection ordering.
Imports are transactional and reject malformed identities, duplicate records, schema
hash mismatches and conflicting schema versions. Historical snapshots are structurally
validated rather than revalidated against the latest field rules, preserving backups
across schema evolution and deleted references.

Document bodies, asset bytes and webhook secrets are sensitive persisted application
data. Configure encryption/access controls on the database and object store. Logs
contain operation metadata and sanitized failures, not raw content or signing secrets.

## 0.2 migration and prerequisites

Core, client and CLI retain Node 18.18+ support. The server requires Node 20.19+: its synchronous CommonJS entry loads the shared ESM HTTP router using Node's
require(ESM) support. ESM and CommonJS consumers receive matching declaration files.
Admin uses the shared administration runtime; the ContentFn capability remains folded
into CmsFn as in the original capability contract, rather than providing a standalone UI.

Release shared DB 0.4.0, shared HTTP 0.3.1, and shared admin 0.1.5/MCP core 0.0.6 before
publishing these packages. The HTTP router export is shared with BrowseFn. Versions
here are local release preparation, not evidence those prerequisites are published.

Existing deployments must apply schema changes before starting 0.2: add the new
`contentfn_schedules` and `contentfn_idempotency` tables from `ALL_TABLES`, and ensure
existing dataset/schema tables include their declared IDs. `runContentfnMigrations`
creates missing tables through the application's migration adapter; it does not alter
existing tables. Use your database migration tooling for existing-table changes.

Webhook workers use expiring database leases to avoid concurrent active deliveries.
A process crash can still cause redelivery after lease expiry, so receivers must keep
idempotency records. Document deletion and unpublication retain new immutable snapshots
for restoration; deleting a dataset removes its histories and idempotency records.

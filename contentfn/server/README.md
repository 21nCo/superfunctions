# @contentfn/server

ContentFn transactional content engine: schemas, datasets, documents/drafts, publication/scheduling, revisions, queries, assets, webhooks and SSE.

```ts
import { createContentfnServer } from '@contentfn/server';
import { memoryAdapter } from '@superfunctions/db/adapters/memory';
const content = createContentfnServer({ db: memoryAdapter() });
await content.api.datasets.create({ dataset: 'production' });
```

Use a persistent shared DB adapter and an application authorize callback in production. ContentFn applies its own schema internally. Expose content.router through a shared HTTP adapter, or use content.handler with Node HTTP. Call processWebhookQueue and processScheduledPublishes periodically from your deployment workers.

Version0.2.0 requires Node20.19+ for synchronous CommonJS loading of ESM shared dependencies, including the HTTP router and Markdown graph. Release prerequisites: sharedDB0.4.0 and HTTP0.3.1. Existing deployments must apply ALL_TABLES schema additions; runContentfnMigrations creates missing tables but does not alter existing ones.

Schema updates reject changes that invalidate stored content unless an explicit migration.description records operator-owned migration steps. Reads preserve old snapshots; restored and published content must satisfy current validation. Deletion/unpublication retain revision snapshots; dataset deletion removes retained history.

Assets require durable object storage in production. Exports contain metadata, not asset binaries. Database and object-storage transactions are separate; reconcile orphan objects after SQL failures. Webhook delivery is at least once with expiring leases; receivers must deduplicate eventId. SSE is a bounded live feed without persistent replay.

Webhook `maxAttempts` counts reserved attempts, including attempts interrupted by a worker crash. An expired final lease becomes failed without another request; its last outcome may be unknown, so operators should reconcile with the receiver before manually resending. Concurrent workers use compare-and-swap updates to settle the exhausted lease once.

See the [complete ContentFn documentation](https://github.com/21nCo/super-functions/tree/dev/contentfn) for contracts, migration details and deployment configuration.

## Draft authoring queries and creation

`docs.query({ dataset, perspective: 'draft' })` paginates the draft table; omitted perspective remains published. Draft queries use the distinct `query.drafts` authorization action. Update explicit application allowlists for editors without granting this action to public readers. Draft reference expansion prefers draft targets and falls back to published targets within the same dataset; published queries never expand draft content. These are separate perspectives, not a merged document list.

Opaque query cursors bind the dataset, perspective, filter/types, order, and projection. Restart pagination after changing these inputs. Legacy unbound cursors now return `QUERY_INVALID`; they cannot safely prove their original dataset or perspective.

`docs.fork({ dataset, id, ifRev })` creates a draft from the exact published revision and requires the distinct `docs.fork` permission. The source revision is conditionally locked inside the same transaction as draft/revision/event/audit insertion. It leaves published fields and revision unchanged, generates new draft identity/timestamps/revision, removes `_publishedAt`, and preserves application content fields. An existing draft returns `DOCUMENT_ALREADY_EXISTS` without exposing or overwriting its body; reading that draft still requires `docs.get` authorization. On `REV_CONFLICT`, refresh the published source before explicitly retrying. This endpoint is also available on the typed client and at `POST /contentfn/docs/fork`.

### Durable publish replay

When a trusted host `context(request)` resolver is configured, status advertises
`content.docs.publish.idempotency.v1`. For keyed `docs.publish` requests this
contract requires a nonempty `context.subject`, checks authorization on every
request, and binds the stored successful response to dataset, key, action, exact
input and subject. The resolver must authenticate the caller; copying an
unverified browser header into `subject` does not establish an identity.
Missing subjects deny keyed publication. Servers without a context resolver keep
the legacy anonymous idempotency behavior and do not advertise this capability.

A successful publication, audit entry and replay record commit atomically. Replay
works after the draft has been removed, including after database reopen. Reusing
the key with a different subject or input returns `VALIDATION_FAILED`; no cached
document is disclosed and no new write occurs. Unsuccessful results are not
recorded as successes. Callers must persist the original input and stable key
before sending, and keep the same verified subject during recovery.

Upgrade barrier: drain old writers before relying on actor-bound replay. Legacy
successful publish records have no verifiable actor provenance; their same
key/input produces a deterministic fingerprint conflict after enabling this
contract. Reconcile those operations explicitly rather than changing keys to
retry an unknown outcome. Keep replay records for the lifetime of pending
operations. Dataset deletion removes replay records; delete/recreate, database
rollback, or independent writes by older servers are outside this guarantee.

### Document history pagination

`docs.history` returns immutable full snapshots for both draft and published
versions of the requested document. Pages sort by recorded timestamp descending,
revision ascending, then storage identity ascending. Queries are scoped to the
dataset and base document identity and return at most `limit` snapshots (1–1000).
Version-2 opaque cursors bind a compact hash of that scope; `drafts.id` and `id`
address the same history, including unrestricted long public IDs. Safely parseable
version-1 dataset/document-bound cursors remain accepted. Old unbound
timestamp/revision-only cursors fail validation: restart from the first page. The existing `docs.history` authorization action is
checked before storage access. Snapshots may contain private draft content, so
hosts must grant this action only to authorized history readers. New revisions
inserted ahead of an existing cursor appear after refreshing the first page.

Each page materializes at most `6 * (limit + 1)` candidate rows using disjoint
keyset ranges for each exact base/draft identity. First pages use two queries;
continuations use six. The host must install the directional index below to avoid
scanning/sorting an entire document history. These are shared-adapter reads, not
an additional SQL runtime.

### Install the ordered history index

Existing and fresh databases can call `upgradeHistoryIndexSchema` after table
creation. It passes `getHistoryIndexDefinition()` to the host's idempotent
`ensureOrderedIndex` implementation:

```ts
import { upgradeHistoryIndexSchema } from "@contentfn/server";
// Supply the host's implemented schema migration adapter, not a no-op callback.
await upgradeHistoryIndexSchema(hostMigrations);
```

Required definition (SQLite syntax):

```sql
CREATE INDEX contentfn_revisions_history_v1
ON contentfn_revisions (dataset ASC, docId ASC, timestamp DESC, rev ASC, id ASC);
```

Do not treat `CREATE INDEX IF NOT EXISTS` alone as verification: a same-name
index with different columns/directions must fail readiness. Index creation is
additive and requires no row backfill; failures leave the previous data readable.
The hook is explicit and never runs at import/server construction. Deployments
choose maintenance/online-DDL policy appropriate to their database.

The shared `IndexSchema`/schema CLI currently cannot express mixed directions,
so this descriptor is separate and the CLI does not establish ordered-index
readiness. Keep this index in the host migration inventory. SQLite native tests
verify populated first/deep page plans use indexed range searches without a
temporary sort. PostgreSQL/MySQL execution plans and online migrations have not
been validated here. In particular, unrestricted public `docId` values are TEXT;
MySQL prefix indexes/byte budgets and PostgreSQL index-entry limits need a distinct
bounded-key design before claiming equivalent performance for all supported IDs.
Memory storage keeps functional behavior but has no physical index acceleration.

Richtext fields have a default limit of 5,000 blocks per field. Configure
`limits.maxRichtextBlocks` with a positive safe integer; status reports the resolved
value. The limit applies recursively through declared objects/array alternatives on
create, patch, draft fork, restore, manual and scheduled publication. Existing oversized
documents remain readable and can be patched down to the limit; failed writes do not
append content revisions, events or audit records. Schema compatibility checks also use
the configured limit unless an explicit migration is declared.

Imports check the declared richtext limit on current documents and revision snapshots
before writing. Archives carry only the latest schema, so removed historical fields or
unknown JSON cannot be classified as richtext; their contents remain compatible rather
than being truncated or reinterpreted. This is not a global archive-array cap. A later
restore or publish validates against the current schema and limit. Hosts upgrading from
uncapped versions should retain readable archives, inspect oversized fields and either
correct content or explicitly configure an appropriate limit before publication.

### Literal patch paths

Patch operations accept the existing dotted string path (`"section.title"`) or an
explicit array of literal string segments (`["section", "literal.title"]`). A dot
inside an array segment is part of the field name. Arrays are nonempty, contain
nonempty strings, and reject `__proto__`, `prototype` and `constructor` at every
level. Reserved document system fields remain immutable in either form. The server
detaches segment arrays before awaiting authorization/storage; `ifRev` conflict
semantics and schema validation remain unchanged. All patch operation kinds share
this path contract. Existing array-operation semantics are unchanged.

Realtime/webhook `changedPaths` remains a string array. Explicit paths whose segments
fit the legacy dotted grammar retain that representation (`["section","title"]`
becomes `"section.title"`). Paths containing literal dots or other non-legacy segment
characters use a JSON-array string (`'["section","literal.title"]'`). Consumers
filtering these fields should parse entries beginning with `[` as JSON segment arrays;
ordinary field filters remain unchanged. Install this producer/core prerequisite
before clients emit literal segment paths; older producers reject the new form.

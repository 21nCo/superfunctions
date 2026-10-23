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

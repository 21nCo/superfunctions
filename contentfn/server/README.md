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

See the [complete ContentFn documentation](https://github.com/21nCo/super-functions/tree/dev/contentfn) for contracts, migration details and deployment configuration.

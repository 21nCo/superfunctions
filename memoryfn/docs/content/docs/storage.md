---
title: Storage and migrations
description: PostgreSQL setup, connection ownership, transaction requirements, and custom adapters.
---

`kind: "memory"` provides a process-local adapter. Durable PostgreSQL needs the SQL in `memoryfn/typescript/migrations`: apply `0001-initial.sql`, then `0002-memory-lifecycle.sql`, then `0003-document-sources.sql`, using a migration role in the intended application schema. The first migration creates pgvector-backed tables with `vector(1536)`; the second adds revisions, tombstones, and an active-row index; the third adds nullable source-key, content-hash and chunk-index columns with a live-source index for source-keyed document chunks. No migration provisions a database, grants, or Hyperdrive. Exact vector search works without an approximate index.

## Inject a caller-owned PostgreSQL adapter

```ts
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { memoryfn } from "@memoryfn/core";
import { PostgresAdapter, memories, memoryRelationships } from "@memoryfn/core/storage/pg";

const client = postgres(connectionString, { prepare: false, max: 5 });
const adapter = new PostgresAdapter(
  drizzle(client, { schema: { memories, memoryRelationships } }),
);
const memory = memoryfn({ storage: { kind: "adapter", adapter } });

// The caller owns this client. Closing MemoryFn does not close it.
await memory.close();
await client.end();
```

Use an injected adapter when the host controls request or Worker lifetimes, pooling, and Hyperdrive options. `kind: "pg"` with a URL creates an owned client; `memory.close()` closes it. Passing a `connection` option to the factory's PostgreSQL branch is rejected: inject a `PostgresAdapter` instead.

PostgreSQL storage fixes embedding dimensions at 1536. The factory requests that dimension and rejects a conflicting embedder configuration, including with an injected `PostgresAdapter`.

The `StorageAdapter` contract requires scoped `insertMemories()`, `insertRelationships()`, `searchVectors()`, `getMemory()`, `updateMemory()` (compare-and-update), `deleteMemory()`, and the source-keyed document methods `getSourceState()`, `replaceSource()` and `deleteSource()`; `close()` and `transaction()` are optional. Immutable-ID tombstones and scope checks are required for equivalent behavior. A source is one tenant, the exact container tag set and a source key; `replaceSource()` must tombstone every live chunk of that source and insert the new chunks atomically, serialized per source, so concurrent replacements leave exactly one chunk set live. The PostgreSQL adapter runs source writes at READ COMMITTED; inside an enclosing transaction at another isolation level it rejects them with `MEMORY_SOURCE_ISOLATION_UNSUPPORTED` before writing. Its advisory lock is re-entrant within one database session, so each source write makes its whole change in one statement: writes through one transaction, from any adapter or savepoint on it, still leave exactly one chunk set live. Before that statement it row-locks the source's live chunks, so a relationship insert that already locked a chunk commits first and its relationship is removed with the chunk. Rolling back a savepoint undoes every later write in that transaction, including source writes from concurrently open savepoints. Source container tags must all be non-empty strings; a sparse tag array is rejected with `MEMORY_SCOPE_REQUIRED`. A conflict resolution that changes several records requires `transaction()`; an adapter without it rejects that conflict before writing.

`kind: "sqlite"` requires an explicit adapter. The factory does not create SQLite storage. `qdrant` is present in a legacy type union but has no factory implementation. Review the [source lifecycle guide](/docs/reference/storage-lifecycle) and [adapter interface](https://github.com/21nCo/super-functions/blob/dev/memoryfn/typescript/src/storage/adapter.ts) before implementing a custom store.

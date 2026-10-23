# REQUIREMENTS: DataFn Remaining Production-Readiness Fixes

## Table of Contents

### Scalability — IN_MEMORY Secondary Loading
- [INMEM-001](#inmem-001) Targeted secondary resource loading for relation filters
- [INMEM-002](#inmem-002) Targeted secondary resource loading for relation selects
- [INMEM-003](#inmem-003) Skip secondary loading when primary set is empty
- [INMEM-004](#inmem-004) Fallback to full load with warning

### Scalability — Unbounded getLatestServerSeq
- [SEQ-001](#seq-001) Fix getLatestServerSeq to use DESC + limit:1

### Throughput — Batch ServerSeq Allocation
- [BATCH-SEQ-001](#batch-seq-001) DatabaseSequenceStore.getNextN()
- [BATCH-SEQ-002](#batch-seq-002) SequenceStore interface update
- [BATCH-SEQ-003](#batch-seq-003) ChangeTrackingService.getNextServerSeqBatch()

### Throughput — Batch Change Recording
- [BATCH-CHG-001](#batch-chg-001) ChangeTrackingService.recordChanges()
- [BATCH-CHG-002](#batch-chg-002) Mutation execution uses batch recording

### Throughput — Relation Mutation Optimization
- [REL-OPT-001](#rel-opt-001) Batch target existence validation
- [REL-OPT-002](#rel-opt-002) Upsert for many-many join operations

### Client — Pull Pagination
- [CLIENT-PULL-001](#client-pull-001) Server emits hasMore in canonical pull response
- [CLIENT-PULL-002](#client-pull-002) Client catch-up loop
- [CLIENT-PULL-003](#client-pull-003) Max pull iterations safeguard
- [CLIENT-PULL-004](#client-pull-004) Hook and event semantics during catch-up

---

## Scalability — IN_MEMORY Secondary Loading

### INMEM-001

- **ID**: INMEM-001
- **Priority**: P0
- **Statement**: When the query planner classifies a query as `IN_MEMORY` and the query contains relation-based filters (`$any`/`$all`/`$none`), `DbDataStore.forQuery()` MUST load secondary resources using targeted `IN` queries scoped to IDs referenced by the pre-filtered primary resource set, instead of loading the entire secondary table.
- **Rationale**: The prior spec's SCALE-004 optimization only pre-filters the primary resource. A `tasks` query with `{ tags: { $any: { label: "urgent" } } }` on a 1M-row `tags` table still loads all 1M tag records into memory. This defeats the purpose of SCALE-004 for queries with relation filters.
- **Acceptance Criteria**:
  - For `many-one` forward relations: extract FK values from pre-filtered primary records, load secondary records with `where: [{ field: "id", operator: "in", value: fkValues }]`.
  - For `one-many` relations: extract primary record IDs, load secondary records with `where: [{ field: fkField, operator: "in", value: primaryIds }]`.
  - For `many-many` relations: load join table rows filtered by primary IDs first, extract secondary IDs from join rows, then load secondary records by those IDs.
  - Final query results MUST be identical to full-table-load execution for the same dataset.
  - Adapter `findMany` is called with the targeted `where` clause (verified via spy in tests).
- **Test Vectors**: TV-INMEM-SEC-001, TV-INMEM-SEC-002, TV-INMEM-SEC-003
- **Notes**: This optimization requires that the primary resource has already been loaded (with SCALE-004 pre-filtering) before secondary loading begins. The loading order is: primary → join tables (if many-many) → secondary resources.

### INMEM-002

- **ID**: INMEM-002
- **Priority**: P1
- **Statement**: When the query planner classifies a query as `IN_MEMORY` and the query contains relation select tokens (in addition to relation filters that caused IN_MEMORY classification), secondary resources needed for select materialization MUST also be loaded using targeted queries.
- **Rationale**: A query might be classified as IN_MEMORY due to a `$any` filter but also select `tags.*`. The select-path secondary loading should also be targeted.
- **Acceptance Criteria**:
  - Select-driven secondary resources are loaded with the same targeted approach as filter-driven secondary resources.
  - Resources needed for both filter evaluation and select materialization are loaded once (not duplicated).
- **Test Vectors**: TV-INMEM-SEC-004
- **Notes**: The `resourcesToLoad` set in `forQuery()` already collects resources from both filters and selects. The targeted loading logic applies uniformly.

### INMEM-003

- **ID**: INMEM-003
- **Priority**: P1
- **Statement**: When the pre-filtered primary resource set is empty (0 records), `DbDataStore.forQuery()` MUST skip loading all secondary resources entirely and return an empty store.
- **Rationale**: If no primary records matched the base-field pre-filter, there is zero benefit to loading secondary resources. This is a fast-path optimization.
- **Acceptance Criteria**:
  - When primary resource `findMany` returns 0 records, no secondary `findMany` calls are made.
  - The returned `DbDataStore` contains the primary resource with an empty array and no secondary resources.
  - Query execution returns an empty result set.
- **Test Vectors**: TV-INMEM-SEC-005
- **Notes**: This applies only when SCALE-004 pre-filtering was used. If no pre-filter was applicable (e.g., all filters are relation-based), the primary load returns all records and secondary loading proceeds normally.

### INMEM-004

- **ID**: INMEM-004
- **Priority**: P2
- **Statement**: If targeted secondary loading fails to determine the FK path between primary and secondary resources (e.g., schema metadata is insufficient), the system MUST fall back to loading all records of the secondary resource and MUST emit a warning log.
- **Rationale**: Robustness: targeted loading is an optimization, not a correctness requirement. Degrading to current behavior is preferable to crashing.
- **Acceptance Criteria**:
  - Fallback triggers when the relation definition lacks a usable `fkField`, `joinTable`, or `joinColumns`.
  - `console.warn("[datafn] Falling back to full secondary load for resource: {name}")` is emitted.
  - Query results remain correct (identical to full-load execution).
- **Test Vectors**: TV-INMEM-SEC-006
- **Notes**: This is defensive coding. Well-defined schemas should never trigger this fallback.

---

## Scalability — Unbounded getLatestServerSeq

### SEQ-001

- **ID**: SEQ-001
- **Priority**: P0
- **Statement**: `ChangeTrackingService.getLatestServerSeq()` MUST fetch at most 1 record using descending `server_seq` ordering and `limit: 1`, instead of fetching all change entries and reading the last element.
- **Rationale**: The current implementation loads ALL change entries for a resource into memory to find the latest `server_seq`. For a resource with 1M changes, this is O(N) memory and O(N) network transfer. The fix reduces this to O(1).
- **Acceptance Criteria**:
  - `db.internal.findMany` is called with `{ orderBy: "-server_seq", limit: 1 }`.
  - When changes exist, returns the `server_seq` of the single returned row.
  - When no changes exist, returns `0`.
  - Behavior is identical to the current implementation for all inputs.
- **Test Vectors**: TV-SEQ-001, TV-SEQ-002
- **Notes**: The Python equivalent (`get_latest_cursor`) already uses `sort=["serverSeq:desc"], limit=1`. This brings the TypeScript implementation to parity.

---

## Throughput — Batch ServerSeq Allocation

### BATCH-SEQ-001

- **ID**: BATCH-SEQ-001
- **Priority**: P0
- **Statement**: `DatabaseSequenceStore` MUST implement a `getNextN(namespace: string, count: number): Promise<number[]>` method that allocates `count` contiguous sequence numbers in a single CAS operation.
- **Rationale**: Relation mutations currently call `getNext()` per FK delta and per join delta. A relate with 5 items generates 10 individual `getNext()` calls, each potentially retrying under CAS contention. Batch allocation reduces this to 1 CAS operation.
- **Acceptance Criteria**:
  - `getNextN(ns, 3)` when `next_server_seq` is 10 returns `[10, 11, 12]` and sets `next_server_seq` to 13.
  - Uses the same CAS retry loop as `getNext()` but increments by `count` instead of 1.
  - `count` MUST be a positive integer ≤ 1000. Values outside this range throw an error.
  - `getNextN(ns, 1)` is functionally equivalent to `[getNext(ns)]`.
  - After implementation, `getNext(ns)` SHOULD be reimplemented as `(await this.getNextN(ns, 1))[0]` to avoid code duplication.
- **Test Vectors**: TV-BATCH-SEQ-001, TV-BATCH-SEQ-002, TV-BATCH-SEQ-003
- **Notes**: Under CAS contention, `getNextN` still retries up to MAX_RETRIES=10. The retry behavior is identical to `getNext` — the only difference is the increment amount.

### BATCH-SEQ-002

- **ID**: BATCH-SEQ-002
- **Priority**: P1
- **Statement**: The `SequenceStore` interface MUST be extended with `getNextN(namespace: string, count: number): Promise<number[]>`.
- **Rationale**: The interface must be updated so `FallbackSequenceStore` and any external implementations can provide batch allocation.
- **Acceptance Criteria**:
  - The `SequenceStore` interface includes `getNextN`.
  - `FallbackSequenceStore.getNextN()` delegates to `primary.getNextN()` with fallback to `fallback.getNextN()`, following the same health-check pattern as `getNext()`.
  - A default implementation exists for stores that don't natively support batch: loop `getNext()` N times.
- **Test Vectors**: TV-BATCH-SEQ-004
- **Notes**: Redis-based stores can optimize with `INCRBY` in a follow-up. The default loop implementation is acceptable for this spec.

### BATCH-SEQ-003

- **ID**: BATCH-SEQ-003
- **Priority**: P0
- **Statement**: `ChangeTrackingService` MUST implement `getNextServerSeqBatch(count: number): Promise<number[]>` that delegates to `sequenceStore.getNextN()`.
- **Rationale**: Provides a clean API for mutation execution to allocate sequences in bulk.
- **Acceptance Criteria**:
  - `getNextServerSeqBatch(5)` returns 5 contiguous sequence numbers.
  - Uses the configured `sequenceStore` (which may be DB, Redis, or fallback).
- **Test Vectors**: TV-BATCH-SEQ-001 (same — tested through ChangeTrackingService)
- **Notes**: Thin wrapper; primary logic is in `DatabaseSequenceStore.getNextN()`.

---

## Throughput — Batch Change Recording

### BATCH-CHG-001

- **ID**: BATCH-CHG-001
- **Priority**: P0
- **Statement**: `ChangeTrackingService` MUST implement a `recordChanges(entries: ChangeEntryInput[])` method that records multiple change entries in a single call.
- **Rationale**: Relation mutations record FK deltas and join deltas individually. A relate with 5 many-many items records 10 change entries via 10 separate `recordChange()` calls. Batch recording reduces call-site complexity and enables future adapter-level batching.
- **Acceptance Criteria**:
  - `recordChanges([entry1, entry2, entry3])` creates 3 rows in `__datafn_changes`.
  - Internal table ensure check runs once (not per entry).
  - Entries are inserted in array order (preserving serverSeq ordering).
  - If any insert fails, the error is propagated immediately (no partial-success semantics).
  - The existing `recordChange()` (singular) SHOULD be reimplemented as `recordChanges([entry])` to avoid code duplication.
- **Test Vectors**: TV-BATCH-CHG-001, TV-BATCH-CHG-002
- **Notes**: This does NOT add `createMany` to the adapter. It iterates and calls `create()` per entry within the helper. The benefit is reduced call-site boilerplate and a single table-ensure guard.

### BATCH-CHG-002

- **ID**: BATCH-CHG-002
- **Priority**: P0
- **Statement**: The mutation execution path in `execute.ts` MUST use `getNextServerSeqBatch()` + `recordChanges()` for relation mutations that produce multiple deltas, instead of per-delta `getNextServerSeq()` + `recordChange()`.
- **Rationale**: Directly reduces DB round-trips. A relate with 5 many-many items goes from 10 `getNextServerSeq` + 10 `recordChange` = 20 DB calls to 1 `getNextServerSeqBatch` + 5 `recordChanges` = ~6-7 DB calls.
- **Acceptance Criteria**:
  - FK deltas and join deltas are collected into arrays.
  - A single `getNextServerSeqBatch(totalDeltaCount)` allocates all sequences.
  - Sequences are assigned to deltas in order (FK deltas first, then join deltas).
  - A single `recordChanges(allDeltas)` records all entries.
  - Regular (non-relation) mutations continue to use `getNextServerSeq()` + `recordChange()` (they only record 1 change entry — no batching benefit).
  - Behavioral correctness: identical change entries are recorded as before, with the same serverSeq ordering.
- **Test Vectors**: TV-BATCH-CHG-003
- **Notes**: The critical optimization is `getNextServerSeqBatch` reducing CAS retries. `recordChanges` is a secondary improvement.

---

## Throughput — Relation Mutation Optimization

### REL-OPT-001

- **ID**: REL-OPT-001
- **Priority**: P0
- **Statement**: `executeRelate()` MUST validate that all target records exist using a single `findMany` with an `IN` filter on the target IDs, instead of calling `findOne` per target item.
- **Rationale**: A relate mutation with 10 items currently makes 10 `findOne` calls to validate targets exist. A single `findMany` with `IN` reduces this to 1 DB call.
- **Acceptance Criteria**:
  - All target IDs are collected into an array.
  - `adapter.findMany({ model: rel.to, where: [{ field: "id", operator: "in", value: targetIds }] })` is called once.
  - If any target ID is missing from the result, the mutation returns `{ ok: false, code: "NOT_FOUND", message: "Related record not found: {id}" }` — same error as current behavior.
  - The first missing ID (in input order) is reported in the error message.
- **Test Vectors**: TV-REL-OPT-001, TV-REL-OPT-002
- **Notes**: The `IN` operator is already supported by all adapter implementations (Drizzle, Kysely, Prisma, Memory).

### REL-OPT-002

- **ID**: REL-OPT-002
- **Priority**: P0
- **Statement**: `executeRelate()` for `many-many` relations MUST use `adapter.upsert()` per join item instead of `findOne` + conditional `create`/`update`.
- **Rationale**: The current code does `findOne` (check if join exists) → `create` or `update`. Using `upsert` reduces this from 2 DB calls to 1 per join item.
- **Acceptance Criteria**:
  - Each join item is processed via `adapter.upsert({ model: joinTable, where: [fromCol, toCol], create: { id, from, to, ...metadata }, update: metadata })`.
  - When the join row does not exist, it is created with the full data.
  - When the join row already exists and metadata is provided, only metadata fields are updated (merge semantics — existing fields preserved).
  - When the join row already exists and metadata is empty, the upsert is a no-op (no unnecessary writes).
  - Behavioral correctness: identical join state as current implementation for all inputs.
- **Test Vectors**: TV-REL-OPT-003, TV-REL-OPT-004
- **Notes**: When `Object.keys(item.metadata).length === 0`, the upsert `update` param is `{}`. Adapter behavior with empty update varies: Drizzle/Kysely will execute a no-op update (SET nothing), Prisma ignores empty updates, Memory merges empty object (no change). All produce correct results. However, to avoid unnecessary DB calls when metadata is empty and we only care about existence, we can check: if metadata is empty, use `upsert` with `update: {}` which is safe across all adapters.

---

## Client — Pull Pagination

### CLIENT-PULL-001

- **ID**: CLIENT-PULL-001
- **Priority**: P0
- **Statement**: The server's `executePullCanonical()` MUST include a `hasMore: boolean` field in the `PullResultCanonical` response, set to `true` when the total number of available changes exceeded the applied limit (i.e., changes were truncated).
- **Rationale**: Without `hasMore`, the client has no way to know whether the pull response is complete or truncated. It silently misses changes until the next sync cycle.
- **Acceptance Criteria**:
  - `hasMore` is `true` when `allChanges.length > limit` (before the `slice(0, limit)` truncation).
  - `hasMore` is `false` (or absent) when all available changes fit within the limit.
  - The `hasMore` field is included in the response JSON.
  - Existing clients that don't read `hasMore` continue to work (the field is additive).
- **Test Vectors**: TV-CLIENT-PULL-001, TV-CLIENT-PULL-002
- **Notes**: `allChanges` is the array collected across all resources before the `slice(0, limit)` call. If `allChanges.length > limit`, the response is truncated and `hasMore` MUST be true.

### CLIENT-PULL-002

- **ID**: CLIENT-PULL-002
- **Priority**: P0
- **Statement**: The client's `pullWithPerTableCursors()` MUST implement a catch-up loop that repeats the pull request with updated cursors when the server response includes `hasMore: true`.
- **Rationale**: Under high write throughput, a single pull batch may not contain all pending changes. The catch-up loop ensures the client fully synchronizes before returning.
- **Acceptance Criteria**:
  - When `response.result.hasMore` is true, the method updates `payload.cursors` from `response.result.cursors` and issues another pull.
  - When `response.result.hasMore` is false or absent, the loop exits.
  - Each iteration applies the pull result to storage via `applyPullResult()`.
  - The loop uses the same `remote.pull()` call as the initial request.
  - Cursor values monotonically increase across iterations (no cursor regression).
- **Test Vectors**: TV-CLIENT-PULL-003, TV-CLIENT-PULL-004
- **Notes**: The `pullInFlight` guard is set at the `pullNow()` level and covers all iterations. Individual iterations do not set/unset it.

### CLIENT-PULL-003

- **ID**: CLIENT-PULL-003
- **Priority**: P1
- **Statement**: The client catch-up loop MUST enforce a maximum iteration count (default: 50, configurable via `config.maxPullIterations`) to prevent infinite loops.
- **Rationale**: If the server is misconfigured or a bug causes `hasMore` to always be true, the client would loop forever. A safety cap prevents resource exhaustion.
- **Acceptance Criteria**:
  - After `maxPullIterations` iterations, the loop exits regardless of `hasMore`.
  - A warning is emitted: `console.warn("[datafn] Pull catch-up reached max iterations ({n}), stopping. Will resume on next sync cycle.")`.
  - The sync is NOT treated as failed — the `sync_applied` event is still emitted with the changes applied so far.
  - `maxPullIterations` is configurable via `DatafnClientConfig`.
- **Test Vectors**: TV-CLIENT-PULL-005
- **Notes**: 50 iterations × 200 batch size = 10,000 changes. This covers realistic catch-up scenarios. If more are needed, the next sync cycle continues from where this one stopped.

### CLIENT-PULL-004

- **ID**: CLIENT-PULL-004
- **Priority**: P1
- **Statement**: During the catch-up loop, `beforeSync` hooks MUST run once before the first pull iteration, and `afterSync` hooks MUST run once after the final iteration. The `sync_applied` event MUST be emitted once after all iterations complete.
- **Rationale**: Hooks and events represent a logical sync operation, not individual network requests. Running them per-iteration would be noisy and semantically incorrect.
- **Acceptance Criteria**:
  - `runBeforeSync()` is called once with the initial payload.
  - `runAfterSync()` is called once with the final result (from the last iteration).
  - `sync_applied` event is emitted once with combined `cursorDelta` across all iterations.
  - `sync_failed` event is emitted if any iteration fails (loop exits on first failure).
- **Test Vectors**: TV-CLIENT-PULL-006
- **Notes**: The initial `beforeSync` transforms the payload. The transformed payload is used for all iterations. The `afterSync` receives the last successful pull result.

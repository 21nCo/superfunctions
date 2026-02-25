# REQUIREMENTS: DataFn Production-Readiness Audit Fix

## Table of Contents

### Scalability — Query Push-Down
- [SCALE-001](#scale-001) Query planner classification
- [SCALE-002](#scale-002) Full push-down for simple queries
- [SCALE-003](#scale-003) Partial push-down for relation-select queries
- [SCALE-004](#scale-004) In-memory fallback with base-field pre-filtering
- [SCALE-005](#scale-005) DFQL-to-WhereClause filter conversion
- [SCALE-006](#scale-006) DFQL-to-OrderBy sort conversion
- [SCALE-007](#scale-007) Limit/offset pass-through to adapter

### Scalability — Bounded Sync
- [SYNC-001](#sync-001) Bounded getChangesSince
- [SYNC-002](#sync-002) Server-enforced pull limit
- [SYNC-003](#sync-003) Pull limit in server config

### Throughput — Mutation Optimization
- [MUT-001](#mut-001) Use upsert for merge operations
- [MUT-002](#mut-002) Eliminate pre-existence check for insert
- [MUT-003](#mut-003) Reduce push mutation round-trips

### Operational — Data Retention
- [RET-001](#ret-001) Change log pruning
- [RET-002](#ret-002) Idempotency record pruning
- [RET-003](#ret-003) Retention configuration
- [RET-004](#ret-004) Auto-prune on startup
- [RET-005](#ret-005) Periodic background pruning

### Operational — Rate Limiting
- [RATE-001](#rate-001) Rate limiting middleware
- [RATE-002](#rate-002) Redis-backed rate limiter
- [RATE-003](#rate-003) In-memory fallback rate limiter
- [RATE-004](#rate-004) Per-endpoint rate limit overrides
- [RATE-005](#rate-005) Rate limit configuration

### Observability
- [OBS-001](#obs-001) Query execution timing
- [OBS-002](#obs-002) Mutation execution timing
- [OBS-003](#obs-003) Sync execution timing
- [OBS-004](#obs-004) Timing configuration

### Python Fixes
- [PY-001](#py-001) Batch record fetching in Python pull
- [PY-002](#py-002) Bounded change fetching in Python

---

## Scalability — Query Push-Down

### SCALE-001

- **ID**: SCALE-001
- **Priority**: P0
- **Statement**: The server MUST implement a `QueryPlanner` module that classifies incoming DFQL queries into `FULL_PUSHDOWN`, `PARTIAL_PUSHDOWN`, or `IN_MEMORY` execution strategies.
- **Rationale**: The current implementation unconditionally pre-loads all records into memory. Classification enables targeted optimization without breaking complex query paths.
- **Acceptance Criteria**:
  - A function `classifyQuery(query, schema)` exists and returns one of three strategy types.
  - Queries with only base-field filters, sort, limit/offset, and scalar select tokens return `FULL_PUSHDOWN`.
  - Queries with relation select tokens (e.g., `tags.*`) but no relation filters return `PARTIAL_PUSHDOWN`.
  - Queries with `$any`/`$all`/`$none` filters, `groupBy`, `search`, or HTREE tokens return `IN_MEMORY`.
- **Test Vectors**: TV-PLAN-001, TV-PLAN-002, TV-PLAN-003, TV-PLAN-004
- **Notes**: The planner MUST be a pure function with no side effects.

### SCALE-002

- **ID**: SCALE-002
- **Priority**: P0
- **Statement**: For queries classified as `FULL_PUSHDOWN`, the server MUST execute the query entirely via the adapter's `findMany` method with filters, sort, limit, and offset pushed down, WITHOUT creating a `DbDataStore` instance.
- **Rationale**: This is the critical fix for the audit's "In-Memory Query Execution" finding. A `limit: 10` query on a 1M-row table MUST NOT load all 1M records.
- **Acceptance Criteria**:
  - DFQL filters are converted to `WhereClause[]` and passed to `findMany.where`.
  - DFQL sort is converted to `OrderBy[]` and passed to `findMany.orderBy`.
  - DFQL limit is passed to `findMany.limit` (as `limit + 1` for nextCursor detection).
  - DFQL offset is passed to `findMany.offset`.
  - No `DbDataStore.create()` or `DbDataStore.forQuery()` is called.
  - Query results are identical to in-memory execution for the same data.
- **Test Vectors**: TV-PUSHDOWN-001, TV-PUSHDOWN-002, TV-PUSHDOWN-003
- **Notes**: Cursor pagination (`cursor.after`/`cursor.before`) requires converting cursor values to additional where clauses (e.g., `id > cursor.id`).

### SCALE-003

- **ID**: SCALE-003
- **Priority**: P1
- **Statement**: For queries classified as `PARTIAL_PUSHDOWN`, the server MUST push base-field filters, sort, and limit to the adapter for the primary resource, then load only the needed related records for select materialization.
- **Rationale**: Many real-world queries include `tags.*` or `category.*` expansion but don't filter on those relations. The primary resource fetch can still be pushed down.
- **Acceptance Criteria**:
  - Primary resource records are fetched via `findMany` with pushed-down filters/sort/limit.
  - Related resources are loaded only for the IDs present in the primary result set (targeted loading).
  - `DbDataStore` is used only for relation materialization with a reduced record set.
  - Results are identical to full in-memory execution.
- **Test Vectors**: TV-PARTIAL-001, TV-PARTIAL-002
- **Notes**: For `many-one` relations, the FK values from primary records determine which related records to fetch. For `one-many` and `many-many`, the primary record IDs determine the join.

### SCALE-004

- **ID**: SCALE-004
- **Priority**: P1
- **Statement**: For queries classified as `IN_MEMORY`, the server MUST pass any applicable base-field filters as `where` clauses to the initial `findMany` call for the primary resource, reducing the in-memory working set.
- **Rationale**: Even complex queries often include simple equality/range filters on the primary resource. Pre-filtering at the DB level reduces memory usage.
- **Acceptance Criteria**:
  - Base-field filters (those not involving relations or dot-paths) are extracted and pushed down.
  - Relation-based filters remain evaluated in-memory.
  - The final result set is identical regardless of which filters were pushed down.
- **Test Vectors**: TV-INMEM-001
- **Notes**: This is a best-effort optimization. If filter extraction fails, the system MUST fall back to loading all records (current behavior).

### SCALE-005

- **ID**: SCALE-005
- **Priority**: P0
- **Statement**: The server MUST implement a `convertDfqlFilters(filters, resource, schema)` function that converts DFQL filter expressions to `WhereClause[]` format compatible with the `@superfunctions/db` adapter.
- **Rationale**: The adapter's `findMany` accepts `WhereClause[]`. A correct and complete conversion is prerequisite for push-down.
- **Acceptance Criteria**:
  - Supports operators: `$eq`, `$ne`, `$gt`, `$gte`, `$lt`, `$lte`, `$in`, `$like`, `$ilike`.
  - Supports non-$-prefixed operators: `eq`, `ne`, `gt`, `gte`, `lt`, `lte`, `in`, `like`, `ilike`.
  - Supports shorthand equality: `{ status: "active" }` → `{ field: "status", operator: "eq", value: "active" }`.
  - Supports `$and` (flattened to additional clauses with AND connector).
  - Returns `null` for any filter containing `$or`, relation quantifiers, or dot-path filters (these cannot be pushed down).
  - A partial extraction mode returns `{ pushable: WhereClause[], remaining: Record<string, unknown> }` for SCALE-004.
- **Test Vectors**: TV-CONVERT-001, TV-CONVERT-002, TV-CONVERT-003, TV-CONVERT-004
- **Notes**: `$or` is not supported by the current `WhereClause` interface. Dot-path filters require joins which the adapter does not support. Both MUST fall back to in-memory.

### SCALE-006

- **ID**: SCALE-006
- **Priority**: P0
- **Statement**: The server MUST implement a `convertDfqlSort(sort)` function that converts DFQL sort terms to `OrderBy[]` format compatible with the adapter.
- **Rationale**: The adapter's `findMany` accepts `OrderBy[]`. Sort push-down is required for correct pagination with limit.
- **Acceptance Criteria**:
  - `["name:asc", "-priority", "id"]` converts to `[{field: "name", direction: "asc"}, {field: "priority", direction: "desc"}, {field: "id", direction: "asc"}]`.
  - Default sort `id:asc` is appended when no sort is specified.
  - Returns `OrderBy[]` for all valid sort inputs.
- **Test Vectors**: TV-SORT-001
- **Notes**: The existing `parseSortTerms` in `sort.ts` already produces `SortTerm[]` which is structurally identical to `OrderBy[]`.

### SCALE-007

- **ID**: SCALE-007
- **Priority**: P0
- **Statement**: The server MUST pass DFQL `limit` and `offset` to the adapter's `findMany` parameters for push-down queries.
- **Rationale**: Without limit push-down, the adapter returns all rows even when the client only needs 10.
- **Acceptance Criteria**:
  - `findMany` is called with `limit: query.limit + 1` (for nextCursor detection) and `offset: query.offset`.
  - If query has no limit, `findMany` is called without a limit parameter.
  - `nextCursor` is computed from the `(limit + 1)`th record if present, then the result is trimmed to `limit`.
- **Test Vectors**: TV-PUSHDOWN-002
- **Notes**: Cursor-based pagination adds where clauses instead of offset. Both cannot be combined in a single query (existing validation prevents this).

---

## Scalability — Bounded Sync

### SYNC-001

- **ID**: SYNC-001
- **Priority**: P0
- **Statement**: `ChangeTrackingService.getChangesSince()` MUST accept and enforce a `limit` parameter, passing it to the internal `findMany` call.
- **Rationale**: The audit found that `getChangesSince()` fetches ALL changes for a resource since a cursor with no limit, causing memory exhaustion for long-dormant clients.
- **Acceptance Criteria**:
  - Method signature changes to `getChangesSince(params: { resource: string; sinceSeq: number; limit?: number })`.
  - When `limit` is provided, `findMany` is called with `{ limit }`.
  - When `limit` is omitted, behavior falls back to current (all records) for backward compatibility.
  - Results are still ordered by `server_seq ASC`.
- **Test Vectors**: TV-SYNC-BOUND-001, TV-SYNC-BOUND-002
- **Notes**: This is a non-breaking change. Existing callers without `limit` continue to work.

### SYNC-002

- **ID**: SYNC-002
- **Priority**: P0
- **Statement**: `executePullCanonical()` MUST enforce a server-side maximum on the total number of changes returned across all resources per pull request.
- **Rationale**: Even with per-resource limits, a client requesting changes for 100 resources could still cause excessive memory usage.
- **Acceptance Criteria**:
  - `executePullCanonical()` calls `getChangesSince()` with a limit derived from the request's `limit` parameter or a server-enforced maximum.
  - The server-enforced maximum is configurable via `limits.maxPullLimit` (default: 1000).
  - The cross-resource limit from `allChanges.slice(0, limit)` (existing) continues to work with the new per-resource limits feeding into it.
- **Test Vectors**: TV-SYNC-BOUND-003
- **Notes**: The existing `allChanges.slice(0, limit)` in `pull.ts` already limits the total. The fix ensures each individual `getChangesSince` call is also bounded.

### SYNC-003

- **ID**: SYNC-003
- **Priority**: P1
- **Statement**: `DatafnServerConfig.limits` MUST support a `maxPullLimit` field for configuring the server-enforced pull batch size.
- **Rationale**: Different deployments have different memory budgets and client sync patterns.
- **Acceptance Criteria**:
  - `limits.maxPullLimit` is added to the type definition with default 1000.
  - The value is passed through to `executePullCanonical()`.
  - Value must be a positive integer; invalid values fall back to default.
- **Test Vectors**: TV-SYNC-BOUND-003
- **Notes**: None.

---

## Throughput — Mutation Optimization

### MUT-001

- **ID**: MUT-001
- **Priority**: P0
- **Statement**: The `merge` mutation operation MUST use the adapter's `db.upsert()` method instead of the current `findOne` + conditional `create`/`update` pattern.
- **Rationale**: The audit found 5-9 round-trips per mutation. `merge` currently uses 3 round-trips (findOne + create/update + idempotency). Using `upsert` reduces the core operation to 1 round-trip.
- **Acceptance Criteria**:
  - `executeMutation` for `operation: "merge"` calls `db.upsert()` with `where: [{ field: "id", operator: "eq", value: mutation.id }]`, `create: { id, ...record }`, `update: { ...record }`.
  - The `merge` path in `executePush` follows the same pattern.
  - Behavioral correctness: merge creates if absent, updates if present — identical to current behavior.
  - No `findOne` call is made for merge operations.
- **Test Vectors**: TV-MUT-UPSERT-001, TV-MUT-UPSERT-002
- **Notes**: The `Adapter` interface already defines `upsert()`. All adapters (Drizzle, Prisma, Kysely, Memory) already implement it.

### MUT-002

- **ID**: MUT-002
- **Priority**: P1
- **Statement**: The `insert` mutation operation SHOULD attempt `db.create()` directly and handle unique constraint errors gracefully, instead of performing a `findOne` pre-check.
- **Rationale**: The current insert path does `findOne` → if exists return CONFLICT → else `create`. This is 2 round-trips. Direct `create` with error handling is 1 round-trip in the success case.
- **Acceptance Criteria**:
  - `executeMutation` for `operation: "insert"` calls `db.create()` directly.
  - If `create` throws a unique constraint / duplicate key error, the mutation returns `{ ok: false, code: "CONFLICT", message: "Record already exists" }`.
  - Behavior is identical to current implementation for both success and conflict cases.
  - The `executePush` insert path follows the same pattern (it already does direct create).
- **Test Vectors**: TV-MUT-INSERT-001, TV-MUT-INSERT-002
- **Notes**: Error detection depends on adapter error messages. A best-effort approach SHOULD check for common patterns ("unique constraint", "duplicate key", "UNIQUE constraint failed"). If detection fails, the error MUST be re-thrown as INTERNAL.

### MUT-003

- **ID**: MUT-003
- **Priority**: P1
- **Statement**: The push handler SHOULD reduce per-mutation round-trips by applying MUT-001 and MUT-002 patterns to the push execution path.
- **Rationale**: Push operations process multiple mutations sequentially. Reducing round-trips per mutation has multiplicative benefit.
- **Acceptance Criteria**:
  - `executePush` merge path uses `db.upsert()`.
  - `executePush` insert path uses direct `db.create()` with error handling.
  - Total round-trips for a merge mutation in push: 1 (upsert) + 1 (idempotency check) + 1 (change log) + 1 (idempotency set) = 4 max (down from 7-9).
- **Test Vectors**: TV-MUT-PUSH-001
- **Notes**: The push path already has slightly different code from the mutation path. Both MUST be updated consistently.

---

## Operational — Data Retention

### RET-001

- **ID**: RET-001
- **Priority**: P0
- **Statement**: `ChangeTrackingService` MUST implement a `pruneChanges(retentionDays: number)` method that deletes change entries older than the specified retention period.
- **Rationale**: The audit found that `__datafn_changes` grows indefinitely with no built-in pruning mechanism.
- **Acceptance Criteria**:
  - `pruneChanges(30)` deletes all rows in `__datafn_changes` where `created_at < (now - 30 days)` for the service's namespace.
  - Returns the number of rows deleted.
  - Does NOT delete rows from other namespaces.
  - The `__datafn_meta` table is never affected.
- **Test Vectors**: TV-RET-CHANGE-001, TV-RET-CHANGE-002
- **Notes**: Uses `db.internal.delete()` with appropriate where clauses. The `created_at` field stores ISO 8601 strings; comparison MUST account for string-based date ordering.

### RET-002

- **ID**: RET-002
- **Priority**: P0
- **Statement**: `DbIdempotencyStore` MUST implement a `pruneIdempotency(retentionDays: number)` method that deletes idempotency records older than the specified retention period.
- **Rationale**: Idempotency records accumulate indefinitely. After a reasonable window (default 7 days), they are no longer needed.
- **Acceptance Criteria**:
  - `pruneIdempotency(7)` deletes all rows in `__datafn_idempotency` where `created_at < (now - 7 days)` for the store's namespace.
  - Returns the number of rows deleted.
  - Does NOT affect rows from other namespaces.
- **Test Vectors**: TV-RET-IDEMP-001
- **Notes**: Same date comparison approach as RET-001.

### RET-003

- **ID**: RET-003
- **Priority**: P1
- **Statement**: `DatafnServerConfig` MUST support a `retention` configuration object with `changeLogDays`, `idempotencyDays`, `pruneOnStartup`, and `pruneIntervalMs` fields.
- **Rationale**: Retention policies must be configurable per deployment.
- **Acceptance Criteria**:
  - All fields are optional with documented defaults.
  - Invalid values (negative, non-integer) are rejected at startup with a clear error message.
  - When `retention` is omitted, no pruning occurs (backward compatible).
- **Test Vectors**: TV-RET-CONFIG-001
- **Notes**: None.

### RET-004

- **ID**: RET-004
- **Priority**: P2
- **Statement**: When `retention.pruneOnStartup` is true, the server MUST execute pruning during `createDatafnServer()` initialization.
- **Rationale**: Startup pruning ensures a clean state after server restarts without requiring external cron jobs.
- **Acceptance Criteria**:
  - Pruning runs after `db.initialize()` but before route registration.
  - Pruning errors are logged but do NOT prevent server startup.
  - Pruning results (rows deleted) are logged at `info` level.
- **Test Vectors**: TV-RET-STARTUP-001
- **Notes**: None.

### RET-005

- **ID**: RET-005
- **Priority**: P2
- **Statement**: When `retention.pruneIntervalMs` is set, the server MUST start a `setInterval` background task that periodically executes pruning.
- **Rationale**: Continuous operation deployments need automated pruning without restart.
- **Acceptance Criteria**:
  - The interval timer is created during server initialization.
  - The interval timer reference is stored so it can be cleared on server shutdown.
  - Errors during background pruning are logged but do NOT affect request handling.
  - Minimum interval is 60000ms (1 minute); values below this are clamped.
- **Test Vectors**: TV-RET-INTERVAL-001
- **Notes**: The `DatafnServer` return type SHOULD expose a `close()` method that clears the interval.

---

## Operational — Rate Limiting

### RATE-001

- **ID**: RATE-001
- **Priority**: P1
- **Statement**: The server MUST implement a rate limiting middleware that is applied BEFORE JSON body parsing and authorization.
- **Rationale**: Rate limiting should reject excessive requests as early as possible to minimize resource consumption.
- **Acceptance Criteria**:
  - Rate-limited requests receive HTTP 429 with body `{ ok: false, error: { code: "RATE_LIMITED", message: "Too many requests", details: { path: "$" } } }`.
  - Rate limiting is applied per-client, identified by a key extractor.
  - When `rateLimit.enabled` is false or omitted, no rate limiting occurs.
- **Test Vectors**: TV-RATE-001, TV-RATE-002
- **Notes**: None.

### RATE-002

- **ID**: RATE-002
- **Priority**: P1
- **Statement**: When a Redis adapter is configured, the rate limiter MUST use Redis atomic `INCR` with TTL for sliding window counters.
- **Rationale**: Redis provides atomic, distributed rate limiting suitable for multi-process deployments.
- **Acceptance Criteria**:
  - Key format: `ratelimit:{endpoint}:{clientKey}:{windowId}`.
  - `INCR` is called; if result > maxRequests, request is rejected.
  - TTL is set to `windowSeconds` on first increment.
  - If Redis is unavailable, falls back to in-memory (RATE-003).
- **Test Vectors**: TV-RATE-REDIS-001
- **Notes**: Uses the existing `RedisAdapter.incr()` method.

### RATE-003

- **ID**: RATE-003
- **Priority**: P1
- **Statement**: When Redis is not available, the rate limiter MUST fall back to an in-memory sliding window implementation.
- **Rationale**: Not all deployments have Redis. In-memory rate limiting is sufficient for single-process deployments.
- **Acceptance Criteria**:
  - Uses a `Map<string, { count: number; resetAt: number }>` structure.
  - Expired windows are lazily cleaned up on access.
  - Memory usage is bounded by the number of unique client keys within a window.
- **Test Vectors**: TV-RATE-MEMORY-001
- **Notes**: In-memory rate limiting does NOT work across multiple processes. This is documented as a known limitation.

### RATE-004

- **ID**: RATE-004
- **Priority**: P2
- **Statement**: The rate limiter MUST support per-endpoint override configurations.
- **Rationale**: Write endpoints (mutation, push) typically need stricter limits than read endpoints (query, pull).
- **Acceptance Criteria**:
  - `rateLimit.endpoints.mutation` can override the global `maxRequests` and `windowSeconds` for mutation requests.
  - Unspecified endpoints fall back to the global rate limit.
- **Test Vectors**: TV-RATE-OVERRIDE-001
- **Notes**: None.

### RATE-005

- **ID**: RATE-005
- **Priority**: P1
- **Statement**: `DatafnServerConfig` MUST support a `rateLimit` configuration object as defined in the SPEC.
- **Rationale**: Configuration must be declarative and type-safe.
- **Acceptance Criteria**:
  - Type definitions are added to `DatafnServerConfig`.
  - Default `keyExtractor` uses `authContextProvider.getContext(ctx).userId` when available, falls back to a static key `"anonymous"`.
  - `enabled: false` or omission disables rate limiting entirely.
- **Test Vectors**: TV-RATE-CONFIG-001
- **Notes**: IP-based key extraction is intentionally NOT the default because the server sits behind the `@superfunctions/http` abstraction which does not expose IP.

---

## Observability

### OBS-001

- **ID**: OBS-001
- **Priority**: P1
- **Statement**: When `observability.timing` is true, the query handler MUST emit an `ExecutionTimingEvent` with phase breakdown: `validate`, `plan`, `fetch`, `filter`, `sort`, `paginate`, `materialize`.
- **Rationale**: The audit found that diagnostic logging lacks depth, making it impossible to identify which execution phase is the bottleneck.
- **Acceptance Criteria**:
  - Each phase duration is measured in milliseconds.
  - The `total` field equals the sum of all phase durations (wall clock, not cumulative — concurrent phases are not expected).
  - Events are emitted after the response is computed but before it is sent.
  - For push-down queries, `filter`, `sort`, `paginate` phases report 0ms (handled by DB).
- **Test Vectors**: TV-OBS-QUERY-001
- **Notes**: Phase timing uses `performance.now()` or `Date.now()` depending on environment.

### OBS-002

- **ID**: OBS-002
- **Priority**: P1
- **Statement**: When `observability.timing` is true, the mutation handler MUST emit an `ExecutionTimingEvent` with phase breakdown: `validate`, `guard`, `execute`, `changeLog`, `idempotency`.
- **Rationale**: Mutation operations have multiple phases with varying costs. Timing reveals which phases dominate.
- **Acceptance Criteria**:
  - Phase durations are measured per individual mutation.
  - Batch mutations (push) emit one event per mutation in the batch.
  - The `guard` phase is 0ms when no `if` guard is specified.
- **Test Vectors**: TV-OBS-MUT-001
- **Notes**: None.

### OBS-003

- **ID**: OBS-003
- **Priority**: P2
- **Statement**: When `observability.timing` is true, the pull and push handlers MUST emit `ExecutionTimingEvent` objects with appropriate phase breakdowns.
- **Rationale**: Sync operations are critical performance paths that need visibility.
- **Acceptance Criteria**:
  - Pull events include: `validate`, `fetchChanges`, `buildResult`.
  - Push events include: `validate`, `execute`, `changeLog`.
- **Test Vectors**: TV-OBS-SYNC-001
- **Notes**: None.

### OBS-004

- **ID**: OBS-004
- **Priority**: P1
- **Statement**: `DatafnServerConfig` MUST support an `observability` configuration object with `timing` boolean and optional `onTiming` callback.
- **Rationale**: Timing must be opt-in to avoid overhead in production deployments that don't need it.
- **Acceptance Criteria**:
  - `timing: true` enables timing emission via the default `console.debug` handler.
  - `onTiming` overrides the default handler.
  - Errors thrown by `onTiming` are caught and logged via `console.warn`.
  - When `timing` is false or omitted, no timing overhead is incurred.
- **Test Vectors**: TV-OBS-CONFIG-001
- **Notes**: None.

---

## Python Fixes

### PY-001

- **ID**: PY-001
- **Priority**: P1
- **Statement**: The Python `handle_pull` implementation MUST batch-fetch full records for upserts instead of fetching them individually.
- **Rationale**: The audit identified N+1 query patterns in `datafn/python/datafn/handlers/sync.py` where records are fetched one at a time.
- **Acceptance Criteria**:
  - Record IDs for upserts are collected first, then fetched in a single batch query.
  - The batch query uses the Python adapter's `find_many` with an `IN` filter on IDs.
  - Behavior is identical: the same records are returned in the pull response.
- **Test Vectors**: TV-PY-BATCH-001
- **Notes**: The Python adapter interface must support `IN` filtering. If not, this is a prerequisite fix.

### PY-002

- **ID**: PY-002
- **Priority**: P1
- **Statement**: The Python `get_changes_since()` function MUST accept and enforce a `limit` parameter, mirroring SYNC-001 for the TypeScript implementation.
- **Rationale**: Same unbounded fetching issue exists in the Python codebase.
- **Acceptance Criteria**:
  - `get_changes_since(resource, since_seq, limit=None)` signature with optional limit.
  - When limit is provided, the database query includes `LIMIT`.
  - Results remain ordered by `server_seq ASC`.
- **Test Vectors**: TV-PY-BOUND-001
- **Notes**: None.

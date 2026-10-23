# SPEC: DataFn Production-Readiness Audit Fix

## Metadata

| Key | Value |
|---|---|
| **Timestamp** | 2026-02-24T20:15:00Z |
| **Agent** | Droid (Factory) |
| **Model** | Claude Opus 4.6 |
| **Launcher** | Factory Droid CLI |
| **Workspace** | /Users/serro/Documents/dev/n/superfunctions |
| **OS / Shell** | macOS (darwin 25.3.0) / zsh |
| **Git Branch** | heads/next |
| **Git Commit** | 2d1a0bf |
| **Git Dirty** | Yes |
| **spec_folder** | 2026-02-24-audit-fix-k9r4m7x3-spec |
| **spec_type** | audit-fix |
| **spec_id** | k9r4m7x3 |
| **Full Path** | datafn/.conduct/specs/2026-02-24-audit-fix-k9r4m7x3-spec |
| **Audit Reference** | datafn/.conduct/audits/2026-02-24-production-readiness-audit.md |
| **Auditor** | Gemini CLI |
| **Input Paths** | datafn/.conduct/audits/2026-02-24-production-readiness-audit.md, datafn/server/src/execution/db-store.ts, datafn/server/src/execution/sync/pull.ts, datafn/server/src/execution/sync/push.ts, datafn/server/src/execution/sync/change-tracking.ts, datafn/server/src/execution/mutation/execute.ts, datafn/server/src/execution/query/execute.ts, datafn/server/src/execution/query/filters.ts, datafn/server/src/execution/query/sort.ts, datafn/server/src/execution/query/select.ts, datafn/server/src/execution/idempotency-db.ts, datafn/server/src/execution/internal-tables.ts, datafn/server/src/server.ts, datafn/server/src/routes/query.ts, packages/db/src/adapter/types.ts |

---

## Overview

This specification addresses all findings from the 2026-02-24 production-readiness audit of the `datafn` libraries. The audit identified four categories of issues: scalability failures (in-memory query execution, unbounded change log fetching), throughput bottlenecks (mutation round-trip overhead, lack of push-down execution), missing operational primitives (no data retention policy, no rate limiting), and observability gaps (shallow diagnostic logging). This spec defines the exact changes required to bring `datafn` from its current "development-grade" state to production-readiness for datasets exceeding 100K records per resource.

---

## Glossary

| Term | Definition |
|---|---|
| **Push-down** | Delegating filter, sort, and pagination operations to the database adapter's `findMany` rather than executing them in-memory in the Node.js process. |
| **QueryPlanner** | A new module that analyzes a DFQL query and determines whether it can be fully or partially pushed down to the adapter, or must fall back to in-memory execution. |
| **Simple query** | A query with no relation-based filters (`$any`/`$all`/`$none`), no relation select tokens (`rel.*`), no `groupBy`, and no `search`. These queries are fully push-down eligible. |
| **Complex query** | A query requiring relation resolution (joins, quantifiers, HTREE traversals, or aggregations). These require partial or full in-memory execution. |
| **Adapter** | The `@superfunctions/db` `Adapter` interface providing CRUD, upsert, transaction, and internal CRUD operations. |
| **DbDataStore** | The current in-memory cache layer in `datafn/server/src/execution/db-store.ts` that pre-loads all records before query execution. |
| **ChangeTrackingService** | Service in `change-tracking.ts` that manages `__datafn_changes` and serverSeq generation. |
| **Retention policy** | Configurable time-based pruning of internal tables (`__datafn_changes`, `__datafn_idempotency`). |
| **CAS** | Compare-And-Swap: the retry loop pattern used for serverSeq generation in the database fallback path. |

---

## Goals

1. **MUST** eliminate the full-table-scan pre-loading pattern for queries that can be pushed down to the database adapter.
2. **MUST** enforce bounded change log fetching in sync pull operations to prevent memory exhaustion and DoS.
3. **MUST** reduce mutation round-trips from the current 5-9 per operation to 2-3 by leveraging native upsert and batch operations.
4. **MUST** implement configurable data retention policies for `__datafn_changes` and `__datafn_idempotency` tables.
5. **MUST** add configurable per-endpoint rate limiting with Redis-backed and in-memory fallback implementations.
6. **MUST** add structured execution-phase timing to query and mutation operations.
7. **MUST** batch-fetch records in the Python sync handler to eliminate N+1 query patterns.
8. **SHOULD** maintain full backward compatibility with the existing DFQL protocol and API surface.

## Non-Goals

- Horizontal scaling / sharding of the database layer (out of scope).
- Replacing the `@superfunctions/db` adapter interface (changes MUST be additive).
- Full SQL query compilation (the push-down strategy converts DFQL filters to the existing `WhereClause[]`/`OrderBy[]` format).
- Client-side performance optimizations (this spec covers server-side only).
- Implementing a distributed lock manager for multi-process deployments.

---

## Public API

### New Configuration Options (DatafnServerConfig)

```typescript
export interface DatafnServerConfig<TContext = any> {
  // ... existing fields ...

  /** Data retention configuration */
  retention?: {
    /** Number of days to retain change log entries. Default: unlimited. */
    changeLogDays?: number;
    /** Number of days to retain idempotency records. Default: 7. */
    idempotencyDays?: number;
    /** Whether to run pruning on server startup. Default: false. */
    pruneOnStartup?: boolean;
    /** Interval in milliseconds for periodic pruning. Default: disabled. */
    pruneIntervalMs?: number;
  };

  /** Rate limiting configuration */
  rateLimit?: {
    /** Enable rate limiting. Default: false. */
    enabled: boolean;
    /** Max requests per window per client. Default: 100. */
    maxRequests?: number;
    /** Window duration in seconds. Default: 60. */
    windowSeconds?: number;
    /** Per-endpoint overrides */
    endpoints?: Partial<Record<
      'query' | 'mutation' | 'transact' | 'push' | 'pull' | 'clone' | 'reconcile' | 'seed',
      { maxRequests: number; windowSeconds: number }
    >>;
    /** Key extractor for identifying clients. Default: uses authContext userId or IP. */
    keyExtractor?: (ctx: TContext) => string | Promise<string>;
  };

  /** Observability configuration */
  observability?: {
    /** Emit execution timing events. Default: false. */
    timing?: boolean;
    /** Custom timing event handler */
    onTiming?: (event: ExecutionTimingEvent) => void;
  };
}
```

### New Types

```typescript
export interface ExecutionTimingEvent {
  endpoint: string;
  resource?: string;
  operation?: string;
  phases: Record<string, number>; // phase name -> duration in ms
  totalMs: number;
  timestamp: string;
}

export interface PruneResult {
  changesDeleted: number;
  idempotencyDeleted: number;
}
```

### New Public Methods

```typescript
// ChangeTrackingService additions
class ChangeTrackingService {
  /** Delete change entries older than retentionDays */
  async pruneChanges(retentionDays: number): Promise<number>;
}

// DbIdempotencyStore additions
class DbIdempotencyStore {
  /** Delete idempotency records older than retentionDays */
  async pruneIdempotency(retentionDays: number): Promise<number>;
}
```

---

## Data Formats / Protocol

No changes to the DFQL wire protocol. All changes are internal to the server execution layer. The request/response envelopes remain identical.

---

## Semantics

### Query Push-Down

A **QueryPlanner** MUST classify each incoming DFQL query as one of:

1. **FULL_PUSHDOWN**: No relation filters, no relation select tokens, no groupBy, no search, no HTREE tokens. The entire query (filters, sort, limit, offset) is converted to `FindManyParams` and delegated to the adapter. The `DbDataStore` is NOT used.
2. **PARTIAL_PUSHDOWN**: Has relation select tokens (e.g., `tags.*`) but no relation filters. Base resource records are fetched from the adapter with filters/sort/limit pushed down. Related resources are loaded on-demand for materialization only.
3. **IN_MEMORY**: Has relation-based filters (`$any`/`$all`/`$none`), groupBy, search, or HTREE tokens. Falls back to the current `DbDataStore` pre-loading behavior with one improvement: MUST pass any applicable base-field filters as `where` clauses to the initial `findMany` call for the primary resource.

### Mutation Optimization

- `merge` operation MUST use `db.upsert()` instead of `findOne` + conditional `create`/`update`. This reduces round-trips from 3 to 1 for the core data operation.
- `insert` operation MAY skip the pre-existence check by catching unique constraint errors from `db.create()`, reducing round-trips from 2 to 1.
- Change log entries for batch push operations SHOULD use `db.internal.create()` calls within a single iteration but MAY be batched into `createMany` if the adapter supports it.

### Bounded Pull

- `getChangesSince()` MUST accept and enforce a `limit` parameter.
- `executePullCanonical()` MUST enforce a server-side maximum limit (configurable via `limits.maxPullLimit`, default 1000).
- The existing `getGlobalChanges()` already accepts limit and is unaffected.

### Data Retention

- Pruning MUST delete records where `created_at < (now - retentionDays)`.
- Pruning MUST be implemented using the `db.internal.delete()` method with appropriate where clauses.
- Pruning MUST NOT affect the `__datafn_meta` table.
- Auto-pruning (if configured) MUST run in a non-blocking background interval and MUST NOT block request handling.

### Rate Limiting

- Rate limiting MUST be applied BEFORE JSON body parsing and authorization.
- When Redis is available and configured, MUST use atomic `INCR` with TTL for sliding window counters.
- When Redis is unavailable, MUST fall back to an in-memory sliding window (Map-based).
- Rate-limited responses MUST return HTTP 429 with envelope `{ ok: false, error: { code: "RATE_LIMITED", message: "Too many requests" } }`.

---

## Invariants

1. **Backward compatibility**: All existing DFQL queries MUST produce identical results before and after the push-down refactor.
2. **Determinism**: Query results for the same data MUST be identical regardless of whether push-down or in-memory execution was used.
3. **Sort stability**: The default sort `id:asc` MUST be appended when no explicit sort is provided, maintaining current behavior.
4. **Idempotency**: Mutation idempotency guarantees MUST be preserved through all optimization changes.
5. **Ordering**: serverSeq monotonic ordering MUST be preserved through all sync optimization changes.
6. **Namespace isolation**: Multi-tenant namespace isolation MUST be preserved through all changes.

---

## Security

- Rate limiting key extraction MUST NOT log or expose user credentials.
- Pruning operations MUST respect namespace isolation (only prune within the configured namespace).
- Execution timing events MUST NOT include query payloads or record data — only structural metadata (resource name, operation type, durations).
- Rate limiting MUST use the auth context `userId` when available; IP-based fallback MUST be clearly documented as less secure.

---

## Limits / Caps

| Limit | Default | Configurable |
|---|---|---|
| Max pull batch size | 1000 | `limits.maxPullLimit` |
| Max query limit | 100 | `limits.maxLimit` (existing) |
| Rate limit requests/window | 100 / 60s | `rateLimit.maxRequests`, `rateLimit.windowSeconds` |
| Retention: change log | unlimited | `retention.changeLogDays` |
| Retention: idempotency | 7 days | `retention.idempotencyDays` |
| Prune interval | disabled | `retention.pruneIntervalMs` |

---

## Observability

### Timing Events

When `observability.timing` is true, the server MUST emit `ExecutionTimingEvent` objects for every query and mutation. Events MUST include phase breakdown:

- **Query phases**: `validate`, `plan`, `fetch`, `filter`, `sort`, `paginate`, `materialize`, `total`
- **Mutation phases**: `validate`, `guard`, `execute`, `changeLog`, `idempotency`, `total`
- **Pull phases**: `validate`, `fetchChanges`, `buildResult`, `total`
- **Push phases**: `validate`, `execute`, `changeLog`, `total`

The default `onTiming` handler MUST log to `console.debug`. Custom handlers MUST NOT throw — errors MUST be swallowed with `console.warn`.

### What MUST NOT be logged

- Record data or field values
- Query filter values
- Mutation record payloads
- Client IDs (unless in debug mode)
- Authentication tokens or credentials

---

## Compatibility / Versioning

- All changes are additive to `DatafnServerConfig`. Existing configurations without the new fields MUST continue to work with current behavior (no push-down, no retention, no rate limiting, no timing).
- The `QueryPlanner` classification is transparent to callers — they receive identical `QueryResult` shapes.
- The adapter interface (`@superfunctions/db`) is NOT modified. Push-down uses the existing `FindManyParams` interface which already supports `where`, `orderBy`, `limit`, and `offset`.

---

## Undefined / Explicitly User-Deferred

None. All audit findings are addressed in this spec. No items are deferred.

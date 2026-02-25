# SPEC: DataFn Remaining Production-Readiness Fixes

## Metadata

| Key | Value |
|---|---|
| **Timestamp** | 2026-02-25T18:30:00Z |
| **Agent** | Claude Code |
| **Model** | Claude Opus 4.6 |
| **Launcher** | VS Code (Claude Code Extension) |
| **Workspace** | /Users/serro/Documents/dev/n/superfunctions |
| **OS / Shell** | macOS (darwin 25.3.0) / zsh |
| **Git Branch** | heads/next |
| **Git Commit** | 2d1a0bf |
| **Git Dirty** | Yes |
| **spec_folder** | 2026-02-25-audit-fix-r7m4k9x2-spec |
| **spec_type** | audit-fix |
| **spec_id** | r7m4k9x2 |
| **Full Path** | datafn/.conduct/specs/2026-02-25-audit-fix-r7m4k9x2-spec |
| **Audit Reference** | datafn/.conduct/audits/2026-02-24-production-readiness-audit.md |
| **Auditor** | Gemini CLI |
| **Prior Spec** | datafn/.conduct/specs/2026-02-24-audit-fix-k9r4m7x3-spec (addressed bulk of audit; this spec covers remaining gaps) |
| **Input Paths** | datafn/.conduct/audits/2026-02-24-production-readiness-audit.md, datafn/server/src/execution/db-store.ts, datafn/server/src/execution/sync/change-tracking.ts, datafn/server/src/execution/sync/sequence-store.ts, datafn/server/src/execution/sync/pull.ts, datafn/server/src/execution/mutation/execute.ts, datafn/server/src/execution/mutation/relations.ts, datafn/client/src/sync/engine.ts, datafn/client/src/sync/apply.ts, datafn/client/src/sync/cloneUp.ts |

---

## Overview

The prior spec (`2026-02-24-audit-fix-k9r4m7x3-spec`) addressed the bulk of the production-readiness audit findings: query push-down (FULL/PARTIAL/IN_MEMORY strategies), bounded pull, upsert for merge, retention, rate limiting, and observability. This spec addresses the **remaining gaps** discovered during a follow-up codebase scan:

1. **IN_MEMORY secondary resource loading** — When the query planner classifies a query as `IN_MEMORY`, secondary/related resources (e.g., a `tags` table referenced via `$any`) are loaded entirely into memory without limits or filtering. Only the primary resource benefits from SCALE-004 pre-filtering.
2. **Unbounded `getLatestServerSeq()`** — Fetches ALL change entries for a resource (ascending, no limit) and reads the last element. The Python equivalent already uses `limit=1` with DESC ordering.
3. **Per-delta serverSeq allocation** — Relation mutations call `getNextServerSeq()` individually for each FK delta and join delta, multiplying CAS retry overhead under contention.
4. **Per-delta ChangeEntry insertion** — Each change delta is recorded via a separate `recordChange()` call (individual DB create), rather than batched.
5. **Per-item relation validation** — `executeRelate()` calls `findOne()` per related item to validate target existence, and again per item to check join existence before conditional create/update.
6. **Client-side pull pagination** — The sync engine's `pullWithPerTableCursors()` makes a single pull request. If the server's response is truncated by `maxPullLimit`, the client silently misses remaining changes until the next sync cycle, potentially falling behind under high write throughput.

---

## Glossary

| Term | Definition |
|---|---|
| **Secondary resource** | A resource loaded into `DbDataStore` during IN_MEMORY query execution that is NOT the primary (queried) resource. Example: `tags` when querying `tasks` with `{ tags: { $any: { label: "urgent" } } }`. |
| **CAS** | Compare-And-Swap: the retry loop in `DatabaseSequenceStore.getNext()` that reads the current sequence, attempts an atomic increment, and retries on conflict. |
| **Batch serverSeq** | Allocating a contiguous range of N sequence numbers in a single CAS operation instead of N separate operations. |
| **hasMore** | A boolean field added to the canonical pull response indicating the server truncated results and the client SHOULD immediately re-pull to catch up. |
| **Catch-up loop** | A client-side loop that repeats pull requests until `hasMore` is false, ensuring the client fully catches up even when changes exceed a single batch. |
| **Targeted secondary loading** | Loading only the subset of a secondary resource's records that are referenced by the primary resource's foreign keys or join table entries, instead of loading the entire table. |

---

## Goals

1. **MUST** apply targeted loading to secondary resources in IN_MEMORY queries, loading only records referenced by the (pre-filtered) primary resource set.
2. **MUST** fix `getLatestServerSeq()` to use DESC ordering with `limit: 1` instead of fetching all changes.
3. **MUST** implement batch serverSeq allocation (`getNextN(count)`) to reduce CAS round-trips for multi-delta mutations.
4. **MUST** implement batch change entry recording (`recordChanges(entries[])`) to reduce per-delta DB insert calls.
5. **MUST** batch relation target validation using `findMany` with `IN` filter instead of per-item `findOne`.
6. **MUST** use `upsert()` for many-many join operations instead of `findOne` + conditional create/update.
7. **MUST** add `hasMore` field to the canonical pull response when the server truncates results.
8. **MUST** implement a client-side catch-up loop that repeats pulls until `hasMore` is false.
9. **SHOULD** maintain full backward compatibility with existing DFQL protocol and API surface.
10. **SHOULD** preserve all existing test suites passing.

## Non-Goals

- Rewriting the IN_MEMORY query execution to eliminate the `DbDataStore` entirely (complex queries with relation filters genuinely need in-memory evaluation).
- Adding `createMany` to the `Adapter` interface (batch change recording will use sequential `create` calls within a single helper to minimize code change; future adapter-level batching is out of scope).
- Changing the `FallbackSequenceStore` Redis path (Redis already allocates atomically; only the DB fallback CAS path is optimized).
- Client-side offline queue changes.

---

## Public API

### Server — Changed Signatures

#### `ChangeTrackingService`

```typescript
// EXISTING (unchanged)
async getChangesSince(params: { resource: string; sinceSeq: number; limit?: number }): Promise<ChangeEntry[]>

// CHANGED — uses DESC + limit:1 instead of loading all rows
async getLatestServerSeq(params: { resource: string }): Promise<number>

// NEW — batch sequence allocation
async getNextServerSeqBatch(count: number): Promise<number[]>

// NEW — batch change recording
async recordChanges(entries: Array<{
  serverSeq: number;
  resource: string;
  id: string;
  op: "insert" | "merge" | "replace" | "upsert" | "delete";
  record: Record<string, unknown> | null;
}>): Promise<void>
```

#### `DatabaseSequenceStore`

```typescript
// NEW — allocate N contiguous sequences in a single CAS
async getNextN(namespace: string, count: number): Promise<number[]>
```

### Server — Pull Response (Changed)

```typescript
// PullResultCanonical — CHANGED: added hasMore
type PullResultCanonical = {
  ok: boolean;
  records: Record<string, Array<Record<string, unknown>>>;
  merged?: Record<string, Array<Record<string, unknown>>>;
  deleted: Record<string, string[]>;
  joins?: Record<string, {
    upsert: Array<Record<string, unknown>>;
    delete: Array<{ from: string; to: string }>;
  }>;
  cursors: Record<string, string>;
  hasMore?: boolean;  // NEW — true when server truncated results
};
```

### Client — Changed Behavior

```typescript
// pullWithPerTableCursors — CHANGED: loops when response.hasMore is true
// No public API change; internal behavior change only
```

---

## Data Formats / Protocol

### Canonical Pull Response Envelope (Updated)

```json
{
  "ok": true,
  "records": { "tasks": [{ "id": "1", "title": "Buy milk" }] },
  "deleted": { "tasks": ["5"] },
  "cursors": { "tasks": "42" },
  "hasMore": true
}
```

When `hasMore` is `true`, the client MUST immediately issue another pull with the updated `cursors` from this response. When `hasMore` is `false` or absent, the client has caught up.

### Batch serverSeq Allocation

`getNextN(namespace, 3)` returns `[10, 11, 12]` — a contiguous range starting from the current sequence counter. Internally, the CAS loop increments by `count` instead of by 1.

---

## Semantics

### Targeted Secondary Resource Loading (IN_MEMORY Queries)

When the query planner classifies a query as `IN_MEMORY`:
1. The primary resource is loaded with SCALE-004 pre-filtering (existing behavior — unchanged).
2. For each secondary resource discovered from relation filters/selects:
   a. Identify the join path between the primary and secondary resource.
   b. Extract the set of FK values or IDs from the already-loaded primary records that reference the secondary resource.
   c. Load only secondary records matching those FK values/IDs via `findMany` with an `IN` filter.
   d. For many-many relations: load join table rows filtered by primary record IDs first, then extract secondary IDs from join rows, then load secondary records by those IDs.
3. If the primary resource set is empty after pre-filtering, skip loading secondary resources entirely.
4. Fallback: If FK extraction fails or the relation path cannot be determined, fall back to loading all records of the secondary resource (current behavior). This MUST be logged as a warning.

### `getLatestServerSeq()` Fix

The current implementation:
```typescript
const changes = await this.db.internal.findMany("__datafn_changes", [...], { orderBy: "server_seq" });
return changes[changes.length - 1].server_seq;
```

MUST be changed to:
```typescript
const changes = await this.db.internal.findMany("__datafn_changes", [...], { orderBy: "-server_seq", limit: 1 });
return changes[0]?.server_seq ?? 0;
```

This reduces the query from O(N) to O(1) where N is the number of change entries for the resource.

### Batch serverSeq Allocation

`DatabaseSequenceStore.getNextN(namespace, count)`:
1. Read current `next_server_seq` from `__datafn_meta`.
2. CAS update: `next_server_seq = current + count` (where condition: `next_server_seq = current`).
3. On success, return `[current, current+1, ..., current+count-1]`.
4. On CAS failure, retry (same MAX_RETRIES=10 as `getNext`).

The existing `getNext(namespace)` SHOULD be reimplemented as `getNextN(namespace, 1)[0]` to avoid code duplication.

### Batch Change Recording

`ChangeTrackingService.recordChanges(entries)`:
1. Iterate over `entries` and call `db.internal.create()` for each.
2. This is a convenience method that reduces call-site boilerplate. Adapter-level `createMany()` is a future optimization (out of scope).
3. The method MUST ensure the internal table exists (same guard as `recordChange`).
4. If any individual create fails, the error MUST be propagated immediately (no partial success).

### Batch Relation Target Validation

`executeRelate()` currently validates each target individually:
```typescript
for (const item of items) {
  const targetExists = await adapter.findOne({ model: rel.to, where: [{ field: "id", ... }] });
}
```

MUST be changed to:
```typescript
const targetIds = items.map(i => i.toId);
const existing = await adapter.findMany({ model: rel.to, where: [{ field: "id", operator: "in", value: targetIds }] });
const existingIds = new Set(existing.map(r => r.id));
for (const id of targetIds) {
  if (!existingIds.has(id)) return { ok: false, code: "NOT_FOUND", ... };
}
```

This reduces N `findOne` calls to 1 `findMany` call.

### Many-Many Join Upsert

The current `executeRelate()` for many-many uses per-item findOne + conditional create/update. This MUST be replaced with `adapter.upsert()`:

```typescript
for (const item of items) {
  await adapter.upsert({
    model: tableName,
    where: [
      { field: fromCol, operator: "eq", value: mutation.id },
      { field: toCol, operator: "eq", value: item.toId },
    ],
    create: { id: `${mutation.id}:${item.toId}`, [fromCol]: mutation.id, [toCol]: item.toId, ...item.metadata },
    update: item.metadata,
    namespace,
  });
}
```

This reduces 2 DB calls per join item to 1.

### Client Pull Catch-Up Loop

`pullWithPerTableCursors()` MUST be modified to loop:

```typescript
let hasMore = true;
while (hasMore) {
  const response = await this.remote.pull(payload);
  // ...apply result...
  hasMore = response.result?.hasMore === true;
  if (hasMore) {
    // Update cursors from response for next iteration
    payload.cursors = response.result.cursors;
  }
}
```

Safeguards:
- A maximum iteration count (`maxPullIterations`, default 50) MUST prevent infinite loops if the server always returns `hasMore: true`.
- Each iteration MUST update the cursors from the response before re-pulling.
- All iterations within a single `pullNow()` call share the same `pullInFlight` guard.
- The `sync_applied` event MUST be emitted once after the final iteration, not per-iteration.
- Hooks (`beforeSync`/`afterSync`) MUST run once per `pullNow()` call (before the first pull and after the last).

---

## Invariants

1. **Result equivalence**: Targeted secondary loading MUST produce identical query results to full secondary loading for the same data set.
2. **Sequence contiguity**: `getNextN(ns, 3)` MUST return exactly 3 contiguous integers. No gaps, no duplicates.
3. **Backward compatibility**: Existing clients that do not check `hasMore` MUST continue to work without errors. `hasMore` is optional in the response type.
4. **Idempotency preservation**: All changes to mutation execution paths MUST preserve the existing idempotency behavior.
5. **Ordering preservation**: Batch change recording MUST insert entries in the same order as the input array, preserving serverSeq ordering.

---

## Security

No new security surfaces are introduced. All changes are internal optimizations. The `hasMore` field is read-only server output and cannot be spoofed by the client. Rate limiting, auth, and namespace isolation remain unchanged.

---

## Limits / Caps

| Limit | Value | Rationale |
|---|---|---|
| `maxPullIterations` | 50 (default, configurable) | Prevents infinite catch-up loops if server is misconfigured |
| `MAX_RETRIES` for CAS | 10 (unchanged) | Existing limit for serverSeq allocation retries |
| Batch serverSeq max count | 1000 | Prevents allocating excessively large sequence ranges in a single CAS |

---

## Observability

- `getLatestServerSeq()` fix: No new observability. Existing timing phases cover this.
- Batch serverSeq: The existing `changeLog` timing phase in mutation handlers covers the combined allocation + recording time.
- Client catch-up loop: The `sync_applied` event's `cursorDelta` field naturally reflects the total changes applied across all iterations.
- Targeted secondary loading: When fallback to full loading occurs, a `console.warn("[datafn] Falling back to full secondary load for resource: {name}")` MUST be emitted.

---

## Compatibility / Versioning

- **Server response**: Adding `hasMore` to `PullResultCanonical` is additive and non-breaking. Existing clients ignore unknown fields.
- **Client behavior**: The catch-up loop is an internal optimization. No public API changes.
- **`getNextN`**: New method on `SequenceStore` interface. Existing implementations (`RedisSequenceStore`, etc.) MUST also implement it. Default implementation: call `getNext()` N times (preserves current behavior, loses batching benefit for Redis).
- **`recordChanges`**: New method on `ChangeTrackingService`. Does not change existing `recordChange` (singular).

---

## Undefined / Explicitly Deferred

- **Adapter-level `createMany()`**: Not adding to the `Adapter` interface. Batch change recording uses sequential creates within a single helper. True DB-level batching (e.g., multi-row INSERT) is deferred to a future adapter enhancement.
- **Redis `getNextN` optimization**: The Redis sequence store could use `INCRBY` for batch allocation. This is a follow-up optimization, not required by this spec. The default implementation (N x `getNext`) is acceptable.
- **WebSocket push notification after catch-up**: The client catch-up loop only runs during explicit `pullNow()` or scheduled sync intervals. Real-time WebSocket push is orthogonal and unchanged.

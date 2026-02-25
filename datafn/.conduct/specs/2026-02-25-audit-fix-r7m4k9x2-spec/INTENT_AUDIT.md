# INTENT AUDIT: DataFn Remaining Production-Readiness Fixes

## Source Documents

1. `datafn/.conduct/audits/2026-02-24-production-readiness-audit.md` — authored by Gemini CLI, dated 2026-02-24.
2. Prior spec: `datafn/.conduct/specs/2026-02-24-audit-fix-k9r4m7x3-spec` — addressed bulk of audit; this spec covers remaining gaps.
3. Follow-up codebase scan conducted 2026-02-25 by Claude Code — identified the specific remaining issues.

---

## Intent Inventory

The following is an exhaustive extraction of every remaining issue discovered during the follow-up scan of the codebase after the prior spec's implementation.

### 1. IN_MEMORY Secondary Resource Loading Is Unbounded

**Finding**: When the query planner classifies a query as `IN_MEMORY`, secondary resources (e.g., a `tags` table referenced via `$any` filter) are loaded entirely into memory without limits. Only the primary resource benefits from SCALE-004 pre-filtering. A 1M-row `tags` table would still be fully loaded.
**Location**: `datafn/server/src/execution/db-store.ts`, lines 505-603 (resource discovery) and `DbDataStore.create()` lines 22-56.
**Prior spec gap**: SCALE-004 (pre-filtering) and SCALE-003 (partial pushdown targeted loading) were implemented but only apply to the primary resource or the PARTIAL_PUSHDOWN path. The IN_MEMORY path's secondary loading was not addressed.

- **SPEC Coverage**: Section "Semantics > Targeted Secondary Resource Loading"
- **Requirements**: INMEM-001, INMEM-002, INMEM-003, INMEM-004
- **Test Vectors**: TV-INMEM-SEC-001..006
- **Phase**: Phase 03

### 2. getLatestServerSeq() Fetches All Changes (Unbounded)

**Finding**: `ChangeTrackingService.getLatestServerSeq()` calls `findMany` with ascending `server_seq` order and NO limit, loading all change entries for a resource into memory to read the last element. For a resource with 1M changes, this is O(N). The Python equivalent already uses `limit=1` + DESC.
**Location**: `datafn/server/src/execution/sync/change-tracking.ts`, lines 325-350.
**Prior spec gap**: SYNC-001/002/003 bounded the `getChangesSince` and pull paths, but `getLatestServerSeq` was not included.

- **SPEC Coverage**: Section "Semantics > getLatestServerSeq() Fix"
- **Requirements**: SEQ-001
- **Test Vectors**: TV-SEQ-001, TV-SEQ-002
- **Phase**: Phase 00

### 3. Per-Delta ServerSeq Allocation via CAS Retry

**Finding**: Relation mutations call `getNextServerSeq()` individually for each FK delta and each join delta. A relate with 5 many-many items generates 10 separate `getNextServerSeq()` calls, each potentially retrying under CAS contention (up to 10 retries × 2 DB calls per retry).
**Location**: `datafn/server/src/execution/mutation/execute.ts`, lines 333-355; `datafn/server/src/execution/sync/sequence-store.ts`, lines 94-151.
**Prior spec gap**: MUT-001/002/003 addressed the mutation OPERATION (upsert, direct create) but not the change TRACKING overhead. The INTENT_AUDIT of the prior spec notes: "Individual change entry insertion (bottleneck c) is partially addressed — batch `createMany` is deferred as a follow-up."

- **SPEC Coverage**: Section "Semantics > Batch serverSeq Allocation"
- **Requirements**: BATCH-SEQ-001, BATCH-SEQ-002, BATCH-SEQ-003
- **Test Vectors**: TV-BATCH-SEQ-001..004
- **Phase**: Phase 01

### 4. Per-Delta ChangeEntry Insertion

**Finding**: Each change delta (FK delta, join delta) is recorded via a separate `recordChange()` call, each issuing an individual `db.internal.create()`. A relate with 5 many-many items records 10 separate change entries.
**Location**: `datafn/server/src/execution/mutation/execute.ts`, lines 333-355; `datafn/server/src/execution/sync/change-tracking.ts`, `recordChange()`.
**Prior spec gap**: Same as #3 — deferred by prior spec.

- **SPEC Coverage**: Section "Semantics > Batch Change Recording"
- **Requirements**: BATCH-CHG-001, BATCH-CHG-002
- **Test Vectors**: TV-BATCH-CHG-001..003
- **Phases**: Phase 01 (method), Phase 02 (integration)

### 5. Per-Item Relation Target Validation

**Finding**: `executeRelate()` calls `adapter.findOne()` per related item to validate that each target exists. A relate with 10 items makes 10 `findOne` calls. A single `findMany` with `IN` filter can do this in 1 call.
**Location**: `datafn/server/src/execution/mutation/relations.ts`, lines 88-103.
**Prior spec gap**: Not addressed by prior spec (MUT-001/002/003 focused on the mutation operation itself, not relation validation).

- **SPEC Coverage**: Section "Semantics > Batch Relation Target Validation"
- **Requirements**: REL-OPT-001
- **Test Vectors**: TV-REL-OPT-001, TV-REL-OPT-002
- **Phase**: Phase 02

### 6. Many-Many Join findOne + Conditional Create/Update

**Finding**: `executeRelate()` for many-many relations calls `findOne` to check if a join row exists, then conditionally calls `create` or `update`. This is 2 DB calls per join item. Using `adapter.upsert()` reduces it to 1.
**Location**: `datafn/server/src/execution/mutation/relations.ts`, lines 147-180.
**Prior spec gap**: MUT-001 applied upsert to the `merge` mutation operation but did not extend it to many-many join operations in `executeRelate`.

- **SPEC Coverage**: Section "Semantics > Many-Many Join Upsert"
- **Requirements**: REL-OPT-002
- **Test Vectors**: TV-REL-OPT-003, TV-REL-OPT-004
- **Phase**: Phase 02

### 7. Client-Side Pull Does Not Paginate

**Finding**: The sync engine's `pullWithPerTableCursors()` makes a single pull request with `limit: pullBatchSize ?? 200`. If the server response is truncated by `maxPullLimit`, the client silently misses remaining changes until the next sync cycle. The `PullResultCanonical` type has no `hasMore` or `nextCursor` field. Only the `cloneUp` path implements pagination.
**Location**: `datafn/client/src/sync/engine.ts`, lines 643-720; `datafn/client/src/sync/apply.ts`, `PullResultCanonical` type (lines 40-50); `datafn/server/src/execution/sync/pull.ts`, response construction (lines 327-344).
**Prior spec gap**: SYNC-001/002/003 bounded the server response but did not add a `hasMore` signal or client-side pagination. The client was left as a single-batch consumer.

- **SPEC Coverage**: Section "Semantics > Client Pull Catch-Up Loop"
- **Requirements**: CLIENT-PULL-001, CLIENT-PULL-002, CLIENT-PULL-003, CLIENT-PULL-004
- **Test Vectors**: TV-CLIENT-PULL-001..006
- **Phase**: Phase 04

---

## Coverage Summary

| # | Intent Item | SPEC Section | Requirement IDs | Test Vectors | Phase(s) | Status |
|---|---|---|---|---|---|---|
| 1 | IN_MEMORY secondary resource loading unbounded | Semantics > Targeted Secondary Resource Loading | INMEM-001..004 | TV-INMEM-SEC-001..006 | 03 | COVERED |
| 2 | getLatestServerSeq unbounded fetch | Semantics > getLatestServerSeq() Fix | SEQ-001 | TV-SEQ-001..002 | 00 | COVERED |
| 3 | Per-delta serverSeq CAS allocation | Semantics > Batch serverSeq Allocation | BATCH-SEQ-001..003 | TV-BATCH-SEQ-001..004 | 01 | COVERED |
| 4 | Per-delta ChangeEntry insertion | Semantics > Batch Change Recording | BATCH-CHG-001..002 | TV-BATCH-CHG-001..003 | 01, 02 | COVERED |
| 5 | Per-item relation target validation | Semantics > Batch Relation Target Validation | REL-OPT-001 | TV-REL-OPT-001..002 | 02 | COVERED |
| 6 | Many-many join findOne + conditional create/update | Semantics > Many-Many Join Upsert | REL-OPT-002 | TV-REL-OPT-003..004 | 02 | COVERED |
| 7 | Client pull does not paginate | Semantics > Client Pull Catch-Up Loop | CLIENT-PULL-001..004 | TV-CLIENT-PULL-001..006 | 04 | COVERED |

---

## Final Statement

**No missing intent items.** All 7 remaining issues from the follow-up codebase scan are fully covered by requirements, test vectors, and implementation phases. Each issue traces back to a specific gap in the prior spec (`2026-02-24-audit-fix-k9r4m7x3-spec`) that was either explicitly deferred or overlooked. This spec closes all remaining production-readiness gaps identified in the original Gemini CLI audit.

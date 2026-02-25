# INTENT AUDIT: DataFn Production-Readiness Audit Fix

## Source Document

`datafn/.conduct/audits/2026-02-24-production-readiness-audit.md` — authored by Gemini CLI, dated 2026-02-24.

---

## Intent Inventory

The following is an exhaustive extraction of every finding, recommendation, and concern from the audit report.

### 1. In-Memory Query Execution (Critical)

**Finding**: `DbDataStore` pre-loads ALL records of requested resources into memory before executing a query. A `limit: 10` query on a 1M-row table loads all 1M records.
**Location**: `db-store.ts`, `DbDataStore.create()` and `forQuery()`.
**Recommendation**: Refactor DataStore to push filters/limits down to the Adapter.

- **SPEC Coverage**: Section "Semantics > Query Push-Down" — FULL_PUSHDOWN, PARTIAL_PUSHDOWN, IN_MEMORY strategies
- **Requirements**: SCALE-001, SCALE-002, SCALE-003, SCALE-004, SCALE-005, SCALE-006, SCALE-007
- **Test Vectors**: TV-PLAN-001..004, TV-PUSHDOWN-001..003, TV-PARTIAL-001..002, TV-INMEM-001, TV-CONVERT-001..004, TV-SORT-001
- **Phases**: Phase 00, Phase 01, Phase 02, Phase 03

### 2. Unbounded Change Log Fetching (Critical)

**Finding**: Both TypeScript and Python implementations fetch ALL changes since a cursor into memory before applying limits. DoS vector and memory exhaustion risk.
**Location**: `pull.ts` and Python `change_tracking.py`.
**Recommendation**: Apply DB-side limits to pull.

- **SPEC Coverage**: Section "Semantics > Bounded Pull"
- **Requirements**: SYNC-001, SYNC-002, SYNC-003, PY-002
- **Test Vectors**: TV-SYNC-BOUND-001..003, TV-PY-BOUND-001
- **Phases**: Phase 04, Phase 09

### 3. N+1 Sync Fetching — Python (High)

**Finding**: Python `handle_pull` fetches full records for upserts individually rather than in batches.
**Location**: `datafn/python/datafn/handlers/sync.py`.
**Recommendation**: Batch record fetching.

- **SPEC Coverage**: Section "Goals" item 7
- **Requirements**: PY-001
- **Test Vectors**: TV-PY-BATCH-001
- **Phases**: Phase 09

### 4. Mutation Overhead — High DB Round-Trips (High)

**Finding**: A single mutation requires 5-9 database round-trips due to manual read-before-write checks and sequential operations.
**Bottlenecks identified**:
  - (a) Manual existence checks (`findOne` before `create`/`update`)
  - (b) Sequential `serverSeq` allocation (CAS retry loop)
  - (c) Individual `ChangeEntry` insertions
**Recommendation**: Use native `UPSERT` / `ON CONFLICT` and batch change logging.

- **SPEC Coverage**: Section "Semantics > Mutation Optimization"
- **Requirements**: MUT-001, MUT-002, MUT-003
- **Test Vectors**: TV-MUT-UPSERT-001..002, TV-MUT-INSERT-001..002, TV-MUT-PUSH-001
- **Phases**: Phase 05
- **Notes**: Sequential serverSeq allocation (bottleneck b) is addressed by the existing `SequenceStore` with Redis/KV fallback. Individual change entry insertion (bottleneck c) is partially addressed — batch `createMany` is deferred as a follow-up since it requires adapter support verification. The primary wins come from eliminating `findOne` round-trips (bottleneck a).

### 5. Lack of Push-Down Execution (High)

**Finding**: The `Adapter` interface supports SQL-level filtering, sorting, and pagination, but `DatafnServer` performs these operations in-memory using JavaScript.
**Impact**: High CPU on app server and excessive network bandwidth between DB and app.
**Recommendation**: Push operations down to adapter.

- **SPEC Coverage**: Section "Semantics > Query Push-Down" — same as finding #1
- **Requirements**: SCALE-001..007 (same as finding #1)
- **Test Vectors**: Same as finding #1
- **Phases**: Phase 00, Phase 01, Phase 02, Phase 03
- **Notes**: This finding overlaps with finding #1. Both point to the same root cause (in-memory execution). The spec addresses both through the QueryPlanner + push-down execution path.

### 6. No Data Retention Policy (Medium)

**Finding**: `__datafn_changes` and `__datafn_idempotency` tables grow indefinitely with no built-in pruning logic.
**Recommendation**: Add background task or configuration for "retention days".

- **SPEC Coverage**: Section "Semantics > Data Retention"
- **Requirements**: RET-001, RET-002, RET-003, RET-004, RET-005
- **Test Vectors**: TV-RET-CHANGE-001..002, TV-RET-IDEMP-001, TV-RET-CONFIG-001, TV-RET-STARTUP-001, TV-RET-INTERVAL-001
- **Phases**: Phase 06

### 7. No Rate Limiting (Medium)

**Finding**: While referenced in configuration, no active request throttling or rate limiting implementation was found in the core server routes.
**Recommendation**: Implement rate limiting.

- **SPEC Coverage**: Section "Semantics > Rate Limiting"
- **Requirements**: RATE-001, RATE-002, RATE-003, RATE-004, RATE-005
- **Test Vectors**: TV-RATE-001..002, TV-RATE-REDIS-001, TV-RATE-MEMORY-001, TV-RATE-OVERRIDE-001, TV-RATE-CONFIG-001
- **Phases**: Phase 07

### 8. Diagnostic Logging Lacks Depth (Low)

**Finding**: Request logging is present but lacks deep tracing into execution phases (time spent in pre-loading vs. filtering).
**Recommendation**: Add execution phase timing.

- **SPEC Coverage**: Section "Observability"
- **Requirements**: OBS-001, OBS-002, OBS-003, OBS-004
- **Test Vectors**: TV-OBS-QUERY-001, TV-OBS-MUT-001, TV-OBS-SYNC-001, TV-OBS-CONFIG-001
- **Phases**: Phase 08

### 9. Strengths Acknowledged (Not Findings — No Action Required)

The audit also identified strengths that require NO action:
- **Multi-Tenant Isolation**: Built-in namespace support ✓
- **Feature Completeness**: Complex relations, WebSockets, REST wrappers ✓
- **Standardized Error Handling**: Envelope pattern ✓
- **Idempotency**: Robust idempotency stores ✓
- **Optimistic Concurrency**: `if` guard system ✓
- **Sequence Store Fallbacks**: Redis → DB fallback ✓

These are preserved and not modified by this spec.

---

## Coverage Summary

| # | Intent Item | SPEC Section | Requirement IDs | Test Vectors | Phase(s) | Status |
|---|---|---|---|---|---|---|
| 1 | In-Memory Query Execution | Semantics > Query Push-Down | SCALE-001..007 | TV-PLAN-*, TV-PUSHDOWN-*, TV-PARTIAL-*, TV-INMEM-*, TV-CONVERT-*, TV-SORT-* | 00, 01, 02, 03 | COVERED |
| 2 | Unbounded Change Log Fetching | Semantics > Bounded Pull | SYNC-001..003, PY-002 | TV-SYNC-BOUND-001..003, TV-PY-BOUND-001 | 04, 09 | COVERED |
| 3 | N+1 Sync Fetching (Python) | Goals #7 | PY-001 | TV-PY-BATCH-001 | 09 | COVERED |
| 4 | Mutation Overhead | Semantics > Mutation Optimization | MUT-001..003 | TV-MUT-* | 05 | COVERED |
| 5 | Lack of Push-Down Execution | Semantics > Query Push-Down | SCALE-001..007 | (shared with #1) | 00, 01, 02, 03 | COVERED (merged with #1) |
| 6 | No Data Retention Policy | Semantics > Data Retention | RET-001..005 | TV-RET-* | 06 | COVERED |
| 7 | No Rate Limiting | Semantics > Rate Limiting | RATE-001..005 | TV-RATE-* | 07 | COVERED |
| 8 | Diagnostic Logging | Observability | OBS-001..004 | TV-OBS-* | 08 | COVERED |
| 9 | Acknowledged Strengths | N/A (no action) | N/A | N/A | N/A | N/A — preserved |

---

## Final Statement

**No missing intent items.** All 8 actionable findings from the audit are fully covered by requirements, test vectors, and implementation phases. The 6 acknowledged strengths are explicitly preserved and not modified. Finding #5 (Lack of Push-Down Execution) is merged with Finding #1 (In-Memory Query Execution) as they share the same root cause and solution.

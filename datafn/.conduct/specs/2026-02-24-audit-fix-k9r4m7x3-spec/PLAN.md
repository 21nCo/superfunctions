# PLAN: DataFn Production-Readiness Audit Fix

## Architecture Sketch

```
datafn/server/src/
├── execution/
│   ├── query/
│   │   ├── planner.ts         ← NEW: QueryPlanner (classify + convert)
│   │   ├── execute.ts         ← MODIFY: dispatch by strategy
│   │   ├── pushdown.ts        ← NEW: push-down execution path
│   │   ├── filters.ts         ← EXISTING (unchanged, used by IN_MEMORY path)
│   │   ├── sort.ts            ← EXISTING (unchanged, parseSortTerms reused)
│   │   ├── select.ts          ← EXISTING (unchanged, materialization)
│   │   └── pagination.ts      ← EXISTING (unchanged)
│   ├── mutation/
│   │   ├── execute.ts         ← MODIFY: upsert for merge, direct create for insert
│   │   └── relations.ts       ← EXISTING (unchanged)
│   ├── sync/
│   │   ├── change-tracking.ts ← MODIFY: add limit to getChangesSince, add pruneChanges
│   │   ├── pull.ts            ← MODIFY: pass limit to getChangesSince
│   │   └── push.ts            ← MODIFY: upsert for merge
│   ├── db-store.ts            ← MODIFY: add targeted loading for PARTIAL_PUSHDOWN
│   ├── idempotency-db.ts      ← MODIFY: add pruneIdempotency
│   └── internal-tables.ts     ← EXISTING (unchanged)
├── middleware/
│   ├── rate-limit.ts          ← NEW: rate limiting middleware
│   └── timing.ts              ← NEW: execution timing middleware
├── server.ts                  ← MODIFY: wire retention, rate limiting, observability
├── routes/
│   ├── query.ts               ← MODIFY: integrate planner + timing
│   ├── mutation.ts            ← MODIFY: integrate timing
│   └── sync.ts                ← MODIFY: integrate timing
└── core-types.ts              ← MODIFY: add config types

datafn/python/datafn/
├── handlers/sync.py           ← MODIFY: batch fetching + bounded changes
└── change_tracking.py         ← MODIFY: add limit parameter
```

## Dependency Graph

```
Phase 0 (Filter/Sort Conversion) ──→ Phase 1 (QueryPlanner) ──→ Phase 2 (Push-Down Execution)
                                                                       │
                                                                       ├──→ Phase 3 (Partial Push-Down)
                                                                       │
Phase 4 (Bounded Sync) ─── independent ───────────────────────────────┘
Phase 5 (Mutation Optimization) ─── independent
Phase 6 (Data Retention) ─── independent
Phase 7 (Rate Limiting) ─── independent
Phase 8 (Observability) ─── depends on Phases 2, 5 (for timing insertion points)
Phase 9 (Python Fixes) ─── independent
```

## Phases Overview

| Phase | Goal | Delivered Capability | Verification |
|---|---|---|---|
| **00** | DFQL-to-Adapter filter/sort/limit conversion utilities | `convertDfqlFilters()`, `convertDfqlSort()` functions with tests | Unit tests for TV-CONVERT-*, TV-SORT-001 |
| **01** | QueryPlanner classification | `classifyQuery()` function with tests | Unit tests for TV-PLAN-001..004 |
| **02** | Full push-down execution path | Simple queries bypass DbDataStore entirely | Integration tests for TV-PUSHDOWN-001..003, existing query tests pass |
| **03** | Partial push-down + in-memory pre-filtering | Relation-select queries use targeted loading; IN_MEMORY queries pre-filter | Integration tests for TV-PARTIAL-001..002, TV-INMEM-001 |
| **04** | Bounded sync pull | getChangesSince enforces limit; server maxPullLimit | Unit tests for TV-SYNC-BOUND-001..003, existing sync tests pass |
| **05** | Mutation optimization (upsert + direct create) | merge uses upsert, insert skips findOne | Unit tests for TV-MUT-*, existing mutation tests pass |
| **06** | Data retention (pruning) | pruneChanges, pruneIdempotency, config, startup/interval | Unit tests for TV-RET-*, integration test for startup pruning |
| **07** | Rate limiting | Rate limit middleware with Redis and in-memory backends | Unit tests for TV-RATE-*, integration test |
| **08** | Observability (execution timing) | Timing events for query/mutation/sync operations | Unit tests for TV-OBS-*, verify no overhead when disabled |
| **09** | Python fixes (batch fetch + bounded changes) | Python pull uses batch fetch; change queries bounded | Python unit tests for TV-PY-BATCH-001, TV-PY-BOUND-001 |

## Definition of Done (Global)

No phase is complete unless:
1. All listed test vectors pass.
2. All pre-existing tests in the affected packages continue to pass (`npm test` in `datafn/server`).
3. TypeScript compilation succeeds with no new errors (`npx tsc --noEmit` in `datafn/server`).
4. No regressions in DFQL protocol behavior — existing integration tests are the regression gate.

# PLAN: DataFn Remaining Production-Readiness Fixes

## Architecture Sketch

```
datafn/server/src/
├── execution/
│   ├── query/
│   │   └── planner.ts         ← EXISTING (unchanged)
│   ├── mutation/
│   │   ├── execute.ts         ← MODIFY: use batch seq + batch recording for relation deltas
│   │   └── relations.ts       ← MODIFY: batch validation, upsert for joins
│   ├── sync/
│   │   ├── change-tracking.ts ← MODIFY: fix getLatestServerSeq, add recordChanges, add getNextServerSeqBatch
│   │   ├── sequence-store.ts  ← MODIFY: add getNextN to DatabaseSequenceStore + interface
│   │   ├── pull.ts            ← MODIFY: add hasMore to response
│   │   └── clone.ts           ← benefits from SEQ-001 fix (no code change needed)
│   └── db-store.ts            ← MODIFY: targeted secondary loading in forQuery()
├── routes/
│   └── sync.ts                ← MAY MODIFY: pass hasMore through
└── core-types.ts              ← MODIFY: add maxPullIterations to client config type (if defined here)

datafn/client/src/
├── sync/
│   ├── engine.ts              ← MODIFY: add catch-up loop in pullWithPerTableCursors
│   └── apply.ts               ← MODIFY: add hasMore to PullResultCanonical type
└── client.ts                  ← MODIFY: add maxPullIterations to config type
```

## Dependency Graph

```
Phase 00 (SEQ-001: getLatestServerSeq fix) ─── independent, no dependencies
    │
Phase 01 (Batch serverSeq + batch change recording) ─── depends on Phase 00 (same file: change-tracking.ts)
    │
Phase 02 (Relation mutation optimization) ─── depends on Phase 01 (uses batch recording)
    │
Phase 03 (IN_MEMORY targeted secondary loading) ─── independent
    │
Phase 04 (Client pull pagination) ─── independent (server hasMore + client loop)
```

## Phases Overview

| Phase | Goal | Delivered Capability | Verification |
|---|---|---|---|
| **00** | Fix `getLatestServerSeq` unbounded fetch | O(1) latest sequence lookup instead of O(N) | Unit tests: TV-SEQ-001, TV-SEQ-002; existing sync tests pass |
| **01** | Batch serverSeq allocation + batch change recording | `getNextN()`, `recordChanges()` methods | Unit tests: TV-BATCH-SEQ-001..004, TV-BATCH-CHG-001..002 |
| **02** | Relation mutation optimization | Batch validation, upsert for joins, batch delta recording | Unit tests: TV-REL-OPT-001..004, TV-BATCH-CHG-003; existing mutation/relation tests pass |
| **03** | IN_MEMORY targeted secondary resource loading | Secondary resources loaded via targeted IN queries | Unit tests: TV-INMEM-SEC-001..006; existing query tests pass |
| **04** | Client pull pagination (server hasMore + client catch-up loop) | Client fully catches up even when changes exceed single batch | Unit tests: TV-CLIENT-PULL-001..006; existing sync/client tests pass |

## Definition of Done (Global)

No phase is complete unless:
1. All listed test vectors pass.
2. All pre-existing tests in affected packages continue to pass (`npm test` in `datafn/server`, `datafn/client`).
3. TypeScript compilation succeeds with no new errors (`npx tsc --noEmit` in affected packages).
4. No regressions in DFQL protocol behavior — existing integration tests are the regression gate.

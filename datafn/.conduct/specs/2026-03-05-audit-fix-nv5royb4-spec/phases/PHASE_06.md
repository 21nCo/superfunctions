# PHASE 06

## Phase goal
Fix execution-layer performance/safety gaps (omit-set caching, search chunking, no full-scan fallback).

## In scope / Out of scope
In scope:
- EXE-014, EXE-017, EXE-022.

Out of scope:
- Change-tracking batch insert capability.

## Deliverables
- `datafn/server/src/execution/query/select.ts`
- `datafn/server/src/execution/query/search.ts`
- `datafn/server/src/execution/db-store.ts`
- Related tests

## Requirements covered
- FIX-EXE-014
- FIX-EXE-017
- FIX-EXE-022

## Implementation tasks
- [ ] Cache FK omit-set computation outside per-record loops.
- [ ] Replace candidate truncation with deterministic chunk processing.
- [ ] Remove/replace `where: []` full-scan fallback for unhandled relation branches.

## Verification steps
- `cd datafn/server && npm test -- query-pushdown.test.ts execution/query/*.test.ts`
- Expected: TV-EXE-014, TV-EXE-017, TV-EXE-022 vectors pass.

## Stop condition
No silent search truncation and no fallback full scans in guarded paths.

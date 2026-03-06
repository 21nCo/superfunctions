# PHASE 07

## Phase goal
Add change-tracking batched write path with deterministic fallback.

## In scope / Out of scope
In scope:
- `recordChanges` batch-write capability path.

Out of scope:
- Reworking adapter APIs beyond minimal required extension.

## Deliverables
- `datafn/server/src/execution/sync/change-tracking.ts`
- Optional adapter/internal extension implementation and tests
- Reliability/performance tests for batch path

## Requirements covered
- FIX-EXE-018

## Implementation tasks
- [ ] Add batch capability detection in change-tracking writes.
- [ ] Implement batched write path.
- [ ] Preserve deterministic fallback path when capability unavailable.
- [ ] Ensure fail-fast error behavior remains unchanged.

## Verification steps
- `cd datafn/server && npm test -- reliability-critical.test.ts performance.test.ts`
- Expected: TV-EXE-018 vectors pass.

## Stop condition
Batch-capable path uses one grouped write call; fallback path remains correct and deterministic.

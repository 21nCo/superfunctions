## Phase goal

Add reconcile/repair (counts-based) to detect and correct drift between local and server state, mirroring Flux’s reconcile behavior.

## In scope

- Server `/datafn/reconcile` endpoint returns deterministic counts for resources and join stores.
- Client `sync.reconcileNow()` compares local counts and triggers re-clone for mismatches.
- Sync events emitted for reconcile phase.
- Tests for mismatch detection and error cases.

## Out of scope

- Hash/digest reconcile beyond counts (Undefined unless later added).

## Deliverables

- Modify server:
  - `datafn/server/src/routes/sync.ts` (add reconcile route)
  - `datafn/server/src/execution/sync/reconcile.ts` (new) OR extend existing sync module
- Modify client:
  - `datafn/client/src/sync/engine.ts` (expose reconcile)
  - `datafn/client/src/storage.ts` (local count APIs if missing)
- Add/modify tests:
  - `datafn/server/__tests__/sync.test.ts`
  - `datafn/client/__tests__/sync.test.ts`

## Requirements covered

- SYNC-007
- EVT-003 (reconcile phase event emission)

## Implementation tasks

- [ ] Server reconcile:
  - validate requested resources exist
  - compute counts deterministically (records) and joinCounts (join stores)
  - return `{ counts, joinCounts, latestCursor }`
- [ ] Client reconcile:
  - compute local counts for requested resources and join stores
  - compare to server counts
  - for mismatches, trigger paginated clone for those resources and (if needed) join stores
  - emit `sync_applied` or `sync_failed` with `context.phase: "reconcile"`
- [ ] Tests:
  - TV-RECON-001/TV-RECON-001N

## Verification steps

```bash
npm test -w @datafn/server && npm test -w @datafn/client
```

## Stop condition

Before starting Phase 08, report:

- The exact local counting implementation used (adapter methods vs scans) and performance implications.


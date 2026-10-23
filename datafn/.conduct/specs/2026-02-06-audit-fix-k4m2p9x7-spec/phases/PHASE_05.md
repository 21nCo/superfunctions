## Phase goal

Implement join propagation via clone/pull and make per-table cursors the canonical pull protocol while keeping legacy global-cursor pull compatibility.

## In scope

- Server pull:
  - canonical per-table cursor request/response
  - returns record upserts/deletes grouped per resource
  - returns join deltas grouped per join-store key
- Legacy global-cursor pull compatibility (accept and respond with legacy envelope).
- Client apply logic:
  - apply record changes to record stores
  - apply join deltas to join stores
  - update per-table cursors
- Client SyncEngine uses per-table cursors for pulls when storage is enabled.
- Tests for protocol, compatibility, and join routing.

## Out of scope

- Paginated clone and hydration plan (Phase 06).
- Reconcile endpoint (Phase 07).

## Deliverables

- Modify server:
  - `datafn/server/src/execution/sync/pull.ts`
  - `datafn/server/src/routes/sync.ts` (request shape detection for legacy vs canonical)
  - `datafn/server/src/execution/sync/change-tracking.ts` (per-table pull helpers)
- Modify client:
  - `datafn/client/src/sync/engine.ts`
  - `datafn/client/src/sync/apply.ts`
  - `datafn/client/src/storage.ts` (cursor persistence for per-table cursors)
- Add/modify tests:
  - `datafn/server/__tests__/sync.test.ts`
  - `datafn/server/__tests__/sync-ordering.test.ts`
  - `datafn/client/__tests__/sync.test.ts`
  - `datafn/client/__tests__/sync-apply.test.ts`

## Requirements covered

- SYNC-003
- SYNC-004
- SYNC-006

## Implementation tasks

- [ ] Server pull:
  - accept `{ cursors: { [resource]: cursor }, limit, includeJoins }`
  - validate cursor format deterministically
  - query change tracking per resource (or query once and bucket deterministically)
  - return grouped `{ records, deleted, joins, cursors }`
- [ ] Join deltas:
  - include changes where `resource` matches join-store key prefix `join_`
  - group them under `joins[joinStoreKey].upsert/delete`
- [ ] Legacy pull:
  - detect legacy request by presence of `cursor` (string/int) and absence of `cursors`
  - return legacy `{ changes, nextCursor }` unchanged for existing clients
- [ ] Client apply:
  - route record changes: `storage.upsertRecord/deleteRecord`
  - route join deltas: `storage.upsertJoinRow/deleteJoinRow`
  - ensure join-store key existence; reject deterministically if unknown
- [ ] Client cursor persistence:
  - persist per-table cursors in meta store
  - derive global cursor as `max(perTableCursors)` for ws wakeups
- [ ] Update SyncEngine pull loop to use per-table cursors:
  - request cursors for known resources (and join-store resources if needed)
  - update cursors after each pull apply
- [ ] Tests:
  - TV-SYNC-003/TV-SYNC-003N (canonical pull)
  - TV-SYNC-004/TV-SYNC-004N (legacy pull compatibility)
  - TV-REL-002/TV-REL-002N (join routing)

## Verification steps

```bash
npm test -w @datafn/server && npm test -w @datafn/client
```

- Expected outcomes:
  - Both pull protocols work.
  - Join deltas are applied to join stores and are visible to offline relation expansions.

## Stop condition

Before starting Phase 06, report:

- Whether per-table pull reads change tracking per resource or via global bucket, and why.
- Confirmation that join-store keys never collide with user resource names (or the explicit collision policy).


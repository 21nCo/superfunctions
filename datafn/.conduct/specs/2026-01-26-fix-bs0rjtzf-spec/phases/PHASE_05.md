# PHASE_05
## Phase goal
Implement the client pull engine (clone vs pull, triggers, pagination loop, cursor monotonic updates) using the server sync v1 protocol.

## In scope
- Startup behavior: clone for fresh installs, pull for existing installs.
- HTTP pull loop with pagination until `nextCursor === null`.
- Cursor storage and monotonic update rule.
- Pull triggers when `ws:false`:
  - visibility/appear event when available
  - push response cursor hint

## Out of scope
- Advanced conflict resolution policies beyond “server ordering is source of truth”.

## Deliverables
- Create or modify: `datafn/client/src/sync/engine.ts` (pull logic)
- Modify: `datafn/client/src/sync/apply.ts` (apply change-entry based pull)
- Modify: `datafn/client/src/client.ts` (wire start/stop/pullNow/cloneNow)
- Add tests:
  - `datafn/client/__tests__/sync.test.ts` (clone/pull + pagination)

## Requirements covered
- SYNC-QUERY-001
- SYNC-PULL-001
- SYNC-PULL-002
- SYNC-PULL-003

## Implementation tasks
1. Define how the client determines “fresh install” using storage hydration state and/or cursor presence.
2. Implement `cloneNow()`:
   - call `${remote}/clone`
   - apply clone data into storage
   - mark hydration state `ready`
   - initialize stored cursor
3. Implement `pullNow()`:
   - read stored cursor
   - call `${remote}/pull` with `{ cursor, limit }`
   - apply returned `changes` deterministically in order
   - update cursor monotonically
   - continue while `nextCursor !== null`
4. Implement triggers when `ws:false`:
   - after push returns cursor greater than stored cursor
   - on visibilitychange (browser only)
5. Add tests for:
   - clone on not hydrated
   - pull on hydrated
   - pagination loop
   - invalid cursor response handling

## Verification steps
- `npm --prefix datafn/client test`
- `npm --prefix datafn/client build`

Expected outcomes:
- Tests pass.
- Build passes.

## Stop condition
Report the cursor storage strategy and confirm pagination tests pass before starting PHASE_06.

# PHASE_03
## Phase goal
Implement the client push engine and local-first mutation pipeline for offlinability mode.

## In scope
- Local-first mutation path when table hydration state is `ready`.
- Changelog append ordering (append before apply).
- Push batching via `pushInterval` and `pushBatchSize`.
- Retry capping via `pushMaxRetries`.
- Emitting `sync_failed` after exhausting retries.

## Out of scope
- Complex local application of relation mutations beyond basic record upserts/deletes.

## Deliverables
- Modify: `datafn/client/src/mutate.ts`
- Modify: `datafn/client/src/offline/mutate.ts` (or replacement local-first path)
- Create: `datafn/client/src/sync/engine.ts`
- Modify: `datafn/client/src/client.ts` (wire sync engine start/stop)
- Add tests:
  - `datafn/client/__tests__/offline-mutate.test.ts` (or new tests for local-first path)
  - `datafn/client/__tests__/sync.test.ts` (push engine behavior)

## Requirements covered
- SYNC-MUT-001
- SYNC-PUSH-001
- SYNC-PUSH-002

## Implementation tasks
1. Introduce a sync engine component responsible for:
   - tracking whether a push is in flight
   - reading the changelog in batches
   - sending a push request to `${remote}/push`
   - acknowledging successfully pushed entries via `changelogAck`
2. Update mutation execution so that in offlinability mode and hydration state `ready`:
   - write to changelog first
   - apply locally
   - schedule push according to `pushInterval` (or immediate)
3. Implement retry with deterministic attempt counts and event emission.
4. Add tests for:
   - ordering (append before apply)
   - batch size default (100)
   - max retries default (3)
   - `sync_failed` emission after failure

## Verification steps
- `npm --prefix datafn/client test`
- `npm --prefix datafn/client build`

Expected outcomes:
- Tests pass.
- Build passes.

## Stop condition
Report which tests validate batching/retry/event behavior and confirm they pass before starting PHASE_04.

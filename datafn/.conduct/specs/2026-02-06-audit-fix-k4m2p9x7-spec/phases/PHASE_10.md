## Phase goal

Run client sync hooks for all sync phases and emit deterministic sync lifecycle events so Nucleus can observe sync status without Flux.

## In scope

- Client runs `beforeSync/afterSync` hooks for:
  - seed, clone, pull, push, cloneUp, reconcile
- Client emits:
  - `sync_applied` on success
  - `sync_failed` on failure
- Tests for hook ordering and event payload determinism.

## Out of scope

- Server-side hook changes (client-focused phase).

## Deliverables

- Modify:
  - `datafn/client/src/sync/engine.ts` (wrap phase execution with hooks)
  - `datafn/client/src/sync.ts` (event emission integration)
  - `datafn/client/src/hooks.ts` (if hook runner exists but isn’t used)
- Add/modify tests:
  - `datafn/client/__tests__/sync.test.ts`
  - `datafn/client/__tests__/events.test.ts`

## Requirements covered

- HOOK-001
- EVT-003

## Implementation tasks

- [ ] Identify all sync phase entrypoints in client:
  - `sync.start()` loop calls to pull/push
  - manual `clone()`, `seed()`, `cloneUp()`, `reconcileNow()`
- [ ] Wrap each phase with:
  - `runBeforeSync({ phase, payload })` fail-closed
  - execute phase
  - `runAfterSync({ phase, resultOrError })` fail-open
- [ ] Emit events:
  - on success: `sync_applied` with `{ phase, cursors?, cursorDelta?, resources? }`
  - on failure: `sync_failed` with `{ phase, error: { code, message } }`
- [ ] Ensure determinism:
  - stable key ordering for context objects
  - consistent error code mapping for transport vs validation vs internal errors
- [ ] Tests:
  - TV-HOOK-001/TV-HOOK-001N
  - TV-EVT-003/TV-EVT-003N

## Verification steps

```bash
npm test -w @datafn/client
```

## Stop condition

Before starting Phase 11, report:

- The complete list of phases covered and their emitted event shapes.
- Any hook ordering decisions (hooks vs codecs vs plugins).


## Phase goal

Finalize cloneUp safely: pullAfter catch-up, monotonic cursor updates, and changelog draining on success (and no local state changes on failure).

## In scope

- Implement pullAfter loop exactly as in `SPEC.md`:
  - starting cursor snapshot before cursor changes
  - `remote.pull({ clientId, cursor, limit: 100 })` loop until caught up
  - apply `changes[]` and advance cursor monotonically, including the `nextCursor === null && changes.length > 0` case
- Monotonic `__global_cursor__` update to max push cursor on success (post-pullAfter).
- Changelog drain on success (ack loop) when configured.
- Ensure failure leaves `__global_cursor__` and changelog unchanged.

## Out of scope

- Event emission (Phase 05).

## Deliverables

- Modify:
  - `datafn/client/src/sync/cloneUp.ts` (finalization logic)

- Tests:
  - Add/extend vectors covering pullAfter + drain + monotonic cursor.

## Requirements covered

- `CLONEUP-STATE-001`
- `CLONEUP-STATE-002`

## Implementation tasks

- [ ] Implement pullAfter loop + apply logic (`TV-CLONEUP-001` pull portion).
- [ ] Implement changelog drain loop (`TV-CLONEUP-001`).
- [ ] Ensure monotonic cursor semantics (`TV-CLONEUP-006`).
- [ ] Ensure failure path does not mutate cursor/changelog (`TV-CLONEUP-012`).
- [ ] Add/extend tests accordingly.

## Verification steps

- Run (from `datafn/client`):
  - `npm run typecheck`
  - `npm test`

Expected outcomes:
- `TV-CLONEUP-001` passes end-to-end.
- `TV-CLONEUP-006` and `TV-CLONEUP-012` assertions about cursor/changelog state pass.

## Stop condition

Report the finalization call order (pullAfter → cursor set → changelog drain) and the passing vector IDs.


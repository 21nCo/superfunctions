## Phase goal

Add CloneUp observability: emit `sync_applied` / `sync_failed` events with `context.phase="cloneup"` and safe payloads.

## In scope

- Emit exactly one `sync_applied` on success.
- Emit exactly one `sync_failed` on failure (both thrown and `ok=false` cases).
- Ensure event `context` does not include full record payloads (counts and mutation IDs only).

## Out of scope

- New event types (must use existing `DatafnEvent.type` values only).

## Deliverables

- Modify:
  - `datafn/client/src/sync/cloneUp.ts` (event emission)

- Tests:
  - Add assertions for event emission and payload shape.

## Requirements covered

- `CLONEUP-EVT-001`

## Implementation tasks

- [ ] On success, emit `sync_applied` with `context: { phase: "cloneup", cursor, stats }`.
- [ ] On failure:
  - [ ] for thrown errors: emit `sync_failed` with `context: { phase: "cloneup", error }`, then rethrow
  - [ ] for server `errors[]` (`ok=false`): emit `sync_failed` with `context: { phase: "cloneup", error }` and return result
- [ ] Add tests for:
  - `TV-CLONEUP-006` (success event)
  - `TV-CLONEUP-012` (failure event)
- [ ] Add explicit assertions that event context excludes record payload fields (e.g., no `record`, `records`, `mutations` keys).

## Verification steps

- Run (from `datafn/client`):
  - `npm run typecheck`
  - `npm test`

Expected outcomes:
- `TV-CLONEUP-006` and `TV-CLONEUP-012` pass including event assertions.

## Stop condition

Report the emitted event shapes (success + failure) and confirm payload redaction rules are enforced by tests.


# PHASE_05: History + restore

## Phase goal

Implement revision history listing and restore semantics (restore writes to draft).

## In scope

- HTTP endpoints:
  - `POST /contentfn/docs/history`
  - `POST /contentfn/docs/restore`
- Revision storage strategy:
  - store immutable revision records on successful mutations (create, patch, publish)
  - include perspective (draft vs published) metadata
- Restore semantics:
  - restoring a revision writes to draft perspective and creates a new revision

## Out of scope

- Diff computation UI (only store changedPaths best-effort)
- Realtime/webhooks integration beyond existing event log

## Deliverables

- `contentfn/server/src/http/endpoints/history.ts`
- `contentfn/server/src/http/endpoints/restore.ts`
- `contentfn/server/src/storage/revisions.ts` (finalize)
- Tests implementing:
  - TV-HIST-LIST-001
  - TV-RESTORE-001
  - TV-RESTORE-002

## Requirements covered

- HIST-001

## Implementation tasks

1. Ensure revision append is called from all mutation pathways (create, patch, publish, unpublish delete when applicable).
2. Implement history listing:
   - deterministic ordering (most recent first)
   - pagination with cursor (opaque)
3. Implement restore:
   - validate rev exists for the target document id
   - write restored content into draft (`drafts.{id}`) deterministically
   - generate a new `_rev` for the draft
4. Add tests verifying:
   - history length increases after mutations
   - restore produces draft content matching the selected revision
   - unknown rev fails with correct error code

## Verification steps

- Run history/restore tests and confirm determinism (stable ordering for same state).
- Confirm restore does not directly change published representation without explicit publish.

## Stop condition

- History and restore endpoints pass referenced TVs with correct envelope behavior and deterministic ordering.


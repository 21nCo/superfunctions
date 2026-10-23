# PHASE_03: Patch engine + optimistic concurrency

## Phase goal

Implement `docs.patch` with deterministic patch validation and optimistic concurrency using `ifRev`.

## In scope

- HTTP endpoint:
  - `POST /contentfn/docs/patch`
- Patch ops:
  - `set`, `unset`, `inc`, `dec`, `insert`, `splice`
- Path validation and deterministic application semantics
- `ifRev` enforcement returning `REV_CONFLICT`

## Out of scope

- Publish/unpublish
- Query engine
- History/restore (beyond recording revisions hooks)

## Deliverables

- `contentfn/server/src/http/endpoints/patch.ts` (or integrated into docs endpoint file)
- `contentfn/server/src/patch/applyPatch.ts`
- `contentfn/server/src/storage/revisions.ts` (revision append baseline; may store full doc snapshots initially)
- Tests implementing:
  - TV-PATCH-SET-001
  - TV-PATCH-UNSET-001
  - TV-PATCH-NONNUM-001
  - TV-PATCH-INVALID-001
  - TV-REV-CONFLICT-001
  - (and any additional vectors needed for insert/splice)

## Requirements covered

- PATCH-001
- REV-001
- HIST-001 (partial: revision recording)

## Implementation tasks

1. Validate incoming patch request (dataset/id/ops length).
2. Load the target document perspective (default: published unless draft id is specified).
3. If `ifRev` provided, compare to current `_rev`; on mismatch return `REV_CONFLICT` with both revisions in `details`.
4. Apply patch ops in order:
   - `set`: set value at path
   - `unset`: remove key at path
   - `inc/dec`: numeric only
   - `insert/splice`: apply array mutations with deterministic bounds checks
5. Persist updated document with new `_rev` and `_updatedAt`.
6. Append a revision record for each successful patch.
7. Add unit tests for patch application edge cases (nested object set/unset, array bounds).

## Verification steps

- Run patch tests and ensure error codes match vectors.
- Confirm `ifRev` mismatch deterministically fails.
- Confirm `_rev` changes and `_updatedAt` advances on success.

## Stop condition

- Patch endpoint functions deterministically and passes all referenced test vectors.


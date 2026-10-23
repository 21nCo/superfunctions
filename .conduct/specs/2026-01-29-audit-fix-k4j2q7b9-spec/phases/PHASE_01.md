# Phase 01

## Phase goal

Implement the server-side clone up endpoint (`POST /datafn/cloneup`) including validation, deterministic ordering, upsert persistence, change tracking, and plugin + auth integration.

## In scope

- `POST /datafn/cloneup` route registration.
- `createCloneUpHandler()` route handler.
- `executeCloneUp()` executor implementing CLONEUP semantics:
  - Request-level validation (hard-fail)
  - Per-record validation (soft-fail into `errors[]`)
  - Upsert with idempotency-by-content
  - Change tracking (`serverSeq` and cursor)
  - Plugins `beforeSync/afterSync` with phase `"cloneup"`
  - Authorization action `"cloneup"`
- Server unit tests covering test vectors.

## Out of scope

- Client `cloneUpNow()` convenience.

## Deliverables

- Add:
  - `datafn/server/src/execution/sync/cloneup.ts`
- Modify:
  - `datafn/server/src/routes/sync.ts`
  - `datafn/server/src/server.ts`
  - (if needed) `datafn/server/src/execution/sync/change-tracking.ts`
- Tests:
  - Add `datafn/server/__tests__/cloneup.test.ts` implementing: TV-CLONEUP-001..006
  - Extend/adjust existing tests for auth/hooks: TV-CLONEUP-007, TV-CLONEUP-008

## Requirements covered

- CLONEUP-001
- CLONEUP-002
- CLONEUP-003
- CLONEUP-004
- CLONEUP-005
- CLONEUP-006
- CLONEUP-007
- CLONEUP-008

## Implementation tasks

1. Create `executeCloneUp(req, ctx)`:
   - Validate request-level fields (`clientId`, `resource`, `records`).
   - Resolve `namespace` from auth context.
   - Build schema index (reuse existing validation helpers).
   - Sort incoming records by `id` ascending for deterministic processing.
   - For each record:
     - Validate record shape and keys.
     - Read existing record (by id).
     - Compute whether upsert would change persisted content.
     - Apply create/update as needed.
     - Record change tracking only when content changed.
   - Return `CloneUpResult` including inserted/updated/skipped/errors and cursor.

2. Route handler `createCloneUpHandler()`:
   - Parse body via existing JSON helpers.
   - Run `beforeSync("cloneup", ...)`.
   - Execute clone up.
   - Run `afterSync("cloneup", ...)`.
   - Return `okResponse(result)`.
   - For request-level failures, return `errorResponse(error)`.

3. Register route in `createDatafnServer` with `withAuth({ action: "cloneup" })`.

4. Tests:
   - Validate idempotency-by-content.
   - Validate request-level vs record-level failures.
   - Validate namespace isolation.
   - Validate authorize denial.
   - Validate plugin hook invocation.

## Verification steps

Run:

```bash
npm -w @datafn/server test
npm -w @datafn/server typecheck
```

Expected outcomes:

- All tests pass.
- Typecheck passes.

## Stop condition

Report:

- Which test vectors are fully covered.
- Any behavioral mismatches between tests and SPEC.md.

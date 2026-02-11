# PHASE_04
## Phase goal
Implement server-side sync protocol v1: push returns cursor and pull supports cursor+limit pagination returning change entries.

## In scope
- Extend `POST /datafn/push` result to include `cursor`.
- Implement `POST /datafn/pull` request shape `{ clientId, cursor, limit }` and response `{ changes, nextCursor }`.
- Deterministic validation errors for invalid `clientId`/`cursor`.

## Out of scope
- Authorization/authentication model changes.

## Deliverables
- Modify: `datafn/server/src/execution/sync/change-tracking.ts` (add global change listing helpers if needed)
- Modify: `datafn/server/src/execution/sync/push.ts`
- Create or modify: `datafn/server/src/execution/sync/pull-v1.ts` (or update existing pull implementation)
- Modify: `datafn/server/src/routes/sync.ts`
- Add tests:
  - `datafn/server/__tests__/sync.test.ts` (or new test file for pull-v1)

## Requirements covered
- PROTO-PUSH-001
- PROTO-PULL-001

## Implementation tasks
1. Define the canonical change entry shape `{ serverSeq, resource, id, op, record? }`.
2. Add a server pull executor that:
   - validates `clientId`
   - validates `cursor` is base-10 integer string
   - returns changes ordered by `serverSeq` asc
   - enforces `limit` and returns `nextCursor` when more changes exist
3. Update push executor/handler to compute and return the latest cursor.
4. Update server route handlers to accept the new pull request shape.
5. Add tests covering:
   - cursor included in push response
   - pull pagination behavior
   - invalid cursor validation

## Verification steps
- `npm --prefix datafn/server test`
- `npm --prefix datafn/server typecheck`
- `npm --prefix datafn/server build`

Expected outcomes:
- Tests pass.
- Typecheck and build pass.

## Stop condition
Report the final wire shapes (sample JSON) validated by tests before starting PHASE_05.

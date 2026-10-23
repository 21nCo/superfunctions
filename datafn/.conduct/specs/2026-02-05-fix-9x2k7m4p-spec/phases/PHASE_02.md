## Phase goal

Implement Stage B (many-many join row upload plan) with metadata validation and deterministic ordering.

## In scope

- Enumerate many-many relations in schema where `from` resource is in upload scope.
- Derive join store names using `join_${from}_${relation}_${to}` (including `from[]`/`to[]` combinations).
- Enumerate join rows from storage and validate:
  - `from` and `to` are strings
  - metadata keys are schema-declared (reject unknown metadata)
- Deterministic ordering:
  - join store names lexicographically
  - join rows by `(from,to,dfqlKey(metaFiltered))`
- Generate `relate` mutations + deterministic `mutationId` per `SPEC.md`.
- Push join mutations per join store (batched; retries + failure policy still deferred to Phase 03).

## Out of scope

- Transport retry policy + server error aggregation (Phase 03).
- pullAfter + cursor/changelog finalization (Phase 04).
- Event emission (Phase 05).

## Deliverables

- Modify:
  - `datafn/client/src/sync/cloneUp.ts` (Stage B implementation)
  - `datafn/client/src/sync/cloneUp/order.ts` (join row sorting helpers)

- Tests:
  - Extend cloneUp tests to cover join enumeration and metadata validation.

## Requirements covered

- `CLONEUP-JOIN-001`
- `CLONEUP-MUT-002`
- `CLONEUP-ORDER-001` (join ordering portion)

## Implementation tasks

- [ ] Implement join store enumeration + missing-store behavior (`TV-CLONEUP-007`).
- [ ] Implement join row metadata validation + error pathing (`TV-CLONEUP-009`).
- [ ] Generate relate mutations + deterministic mutation IDs (`TV-CLONEUP-001` join portion).
- [ ] Add/extend tests for the above vectors.

## Verification steps

- Run (from `datafn/client`):
  - `npm run typecheck`
  - `npm test`

Expected outcomes:
- `TV-CLONEUP-007` and `TV-CLONEUP-009` pass.
- `TV-CLONEUP-001` passes up to “push plan generation” (full end-to-end success may still wait on Phase 03+04).

## Stop condition

Report the join-store enumeration coverage (which relations/joinStores are produced) and the passing test vector IDs.


## Phase goal

Implement Stage A (record upload plan) with deterministic mutation generation (including deterministic `mutationId`) and resource scope validation.

## In scope

- Prerequisite validation: storage configured, remote configured, schema available.
- Resolve upload scope (`options.resources` vs default schema resources; exclude `isRemoteOnly` unless explicitly allowed by spec).
- Generate record mutations:
  - schema-bounded record payload (omit `id`, omit unknown fields)
  - deterministic `mutationId` hashing per `SPEC.md` (FNV-1a 32-bit + base36; hash input object defined)
  - deterministic ordering (records by `id`)
- Push record mutations per-resource, batched deterministically (no retries yet beyond wiring).

## Out of scope

- Stage B (many-many join rows).
- Transport retry policy and server error aggregation (Phase 03).
- pullAfter + cursor/changelog finalization (Phase 04).
- Event emission (Phase 05).

## Deliverables

- Create/modify:
  - `datafn/client/src/sync/cloneUp.ts` (record path + scope + prerequisite checks)
  - `datafn/client/src/sync/cloneUp/hash.ts` (FNV-1a 32-bit base36 over normalized JSON)
  - `datafn/client/src/sync/cloneUp/order.ts` (record sorting helpers)
  - `datafn/client/src/sync/cloneUp/batch.ts` (batch partition helper)

- Tests:
  - `datafn/client/src/sync/__tests__/cloneUp.phase01.test.ts` (or `datafn/client/__tests__/cloneup.test.ts`)

## Requirements covered

- `CLONEUP-API-002`
- `CLONEUP-SCOPE-001`
- `CLONEUP-MUT-001`
- `CLONEUP-ORDER-001` (record ordering portion)

## Implementation tasks

- [ ] Implement prerequisite checks and error codes/messages per `SPEC.md` (`TV-CLONEUP-003`, `TV-CLONEUP-004`).
- [ ] Implement scope resolution and validation (`TV-CLONEUP-002`, `TV-CLONEUP-005`).
- [ ] Implement deterministic record mutation generation + hashing (`TV-CLONEUP-010`, `TV-CLONEUP-008`).
- [ ] Implement deterministic batching for Stage A pushes (single-resource batching sufficient here).
- [ ] Add tests implementing the above vectors (record-only paths).

## Verification steps

- Run (from `datafn/client`):
  - `npm run typecheck`
  - `npm test`

Expected outcomes:
- Vectors `TV-CLONEUP-002`, `TV-CLONEUP-003`, `TV-CLONEUP-004`, `TV-CLONEUP-005`, `TV-CLONEUP-008`, and `TV-CLONEUP-010` pass for record-only execution.

## Stop condition

Report which vectors now pass and which are intentionally deferred to later phases (by vector ID).


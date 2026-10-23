## Phase goal

Implement offline local apply for relation mutations (`relate`, `modifyRelation`, `unrelate`) so many-many edges and FK-based relations can be changed while offline deterministically.

## In scope

- Client-side offline apply for relation mutations:
  - many-many join store upserts/deletes/metadata updates
  - many-one/one-many FK updates/clears when relation ops are used
- Deterministic join-store naming and routing (matches existing offline relation expansion expectations).
- Tests validating local join writes and error cases.

## Out of scope

- Server push acceptance of relation mutations (Phase 04).
- Join row propagation via pull/clone (Phase 05).
- Cursor/hydration protocol changes (Phase 05–06).

## Deliverables

- Modify:
  - `datafn/client/src/offline/mutate.ts`
  - `datafn/client/src/offline/relations.ts`
  - `datafn/client/src/storage.ts` (if new join APIs needed)
  - `datafn/core/src/types.ts` (if relation mutation typing needs tightening)
- Add/modify tests:
  - `datafn/client/__tests__/offline-mutate.test.ts`
  - `datafn/client/src/offline/__tests__/local-dfql.test.ts` (if relation parsing is validated there)

## Requirements covered

- OFFM-001

## Implementation tasks

- [ ] Define deterministic join-store naming contract on client:
  - `join_${fromResource}_${relationName}_${toResource}` (matches existing IndexedDB adapter usage)
  - For polymorphic relations (from/to arrays), compute all relevant join stores deterministically.
- [ ] Implement relation payload normalization on client (mirror server `normalizeRelationPayload`):
  - accept string / string[] / object with `$ref` + metadata / array of those
  - reject invalid payload item types deterministically
- [ ] Offline apply for `relate`:
  - Validate relation exists in schema and relation type
  - Validate `toId` target exists locally when required by policy (if offline validation is enabled); otherwise allow optimistic
  - many-many: upsert join rows into the correct join store(s)
  - many-one: set FK field on source record
  - one-many: set FK field on target records
- [ ] Offline apply for `modifyRelation`:
  - only many-many supported
  - require join row exists; else return NOT_FOUND (deterministic)
  - update join row metadata
- [ ] Offline apply for `unrelate`:
  - many-many: delete join row
  - many-one: clear FK on source
  - one-many: clear FK on targets
- [ ] Ensure changelog records relation mutations with full metadata:
  - operation, id, relations payload, clientId, mutationId, context
- [ ] Tests:
  - TV-OFFM-001/TV-OFFM-001N

## Verification steps

```bash
npm test -w @datafn/client
```

- Expected outcomes:
  - Offline relation mutations update join stores as expected.
  - Error cases are deterministic and include correct error codes/paths.

## Stop condition

Before starting Phase 04, report:

- The exact join-store naming and polymorphic expansion rules implemented.
- Whether offline validation enforces target existence (and if configurable).


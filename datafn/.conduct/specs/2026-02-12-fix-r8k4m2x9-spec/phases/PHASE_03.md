# Phase 03 — `joinTable` / `joinColumns` Schema Extension + Server

## Phase Goal

Add `joinTable` and `joinColumns` to `DatafnRelationSchema` in `@datafn/core`, and update the DataFn server to use named join tables when specified, falling back to `__datafn_join_*` via `adapter.internal` when not.

## In Scope

- Extend `DatafnRelationSchema` type
- Update schema validation to accept new fields
- Update `relations.ts` to resolve join table from schema
- Update `db-store.ts` to resolve join table from schema
- Fallback: route `__datafn_join_*` through `adapter.internal` with `ensureTable`

## Out of Scope

- CLI migration changes (Phase 04)
- CLI codegen changes (Phase 04)

## Deliverables

| File                                                | Action                                                                                                         |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `datafn/core/src/types.ts`                          | MODIFY — add `joinTable?` and `joinColumns?` to `DatafnRelationSchema`                                         |
| `datafn/core/src/validation.ts`                     | MODIFY — validate `joinTable` (string) and `joinColumns` (object with `from`/`to` strings)                     |
| `datafn/server/src/execution/mutation/relations.ts` | MODIFY — resolve `joinTable`/`joinColumns` from schema relation, use normal adapter CRUD or `adapter.internal` |
| `datafn/server/src/execution/db-store.ts`           | MODIFY — resolve `joinTable`/`joinColumns` for loading join rows                                               |
| `datafn/server/src/execution/internal-tables.ts`    | MODIFY — add join table schema for `ensureTable` fallback                                                      |

## Requirements Covered

- JT-001, JT-002, JT-003, JT-004

## Implementation Tasks

### Extend `DatafnRelationSchema`

- [ ] Add `joinTable?: string` to the type
- [ ] Add `joinColumns?: { from: string; to: string }` to the type
- [ ] Update `validateSchema` to validate these fields (optional, string types)

### Update `relations.ts`

- [ ] In `executeRelate`: resolve `joinTable` from `relation.joinTable` if set
- [ ] If `joinTable` set: use `adapter.create/findOne/update/delete({ model: relation.joinTable, ... })` with `joinColumns` for column names
- [ ] If `joinTable` NOT set: use `adapter.internal.create("__datafn_join_...", ...)` with `"from"`/`"to"` columns and call `ensureTable` first
- [ ] Same changes in `executeModifyRelation` and `executeUnrelate`

### Update `db-store.ts`

- [ ] `loadJoinRows`: accept schema context to resolve `joinTable`
- [ ] If `joinTable` set: use `adapter.findMany({ model: joinTable, ... })` and map `joinColumns`
- [ ] If NOT set: use `adapter.internal.findMany("__datafn_join_...", ...)`

### Update `forQuery` in `db-store.ts`

- [ ] Pass schema to `loadJoinRows` so it can resolve `joinTable`

## Verification Steps

```bash
# Run core tests
cd /Users/ar/dev/superfunctions/datafn/core
npm test

# Run server tests (including relation tests)
cd /Users/ar/dev/superfunctions/datafn/server
npm test
```

**Expected**: All tests pass. Relations with `joinTable` use normal adapter, relations without use `adapter.internal`.

## Stop Condition

Schema validates with new fields. Server relation tests pass. Report any test changes needed.

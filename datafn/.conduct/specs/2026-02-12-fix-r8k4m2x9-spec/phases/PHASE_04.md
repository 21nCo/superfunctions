# Phase 04 — CLI Migration + Codegen for Join Tables

## Phase Goal

Update the DataFn CLI to generate named join table DDL in migrations and emit TypeScript interfaces for join tables in codegen.

## In Scope

- CLI `generate-migration`: generate named join tables from `joinTable`/`joinColumns`
- CLI `codegen.ts` (`generateTypes`): emit join table interfaces when `metadata` is present
- Backward compatibility: unnamed join tables still use `__datafn_join_*` prefix

## Out of Scope

- Runtime server changes (done in Phase 02-03)

## Deliverables

| File                                           | Action                                                                        |
| ---------------------------------------------- | ----------------------------------------------------------------------------- |
| `datafn/cli/src/migrations/diff.ts`            | MODIFY — pass `joinTable`/`joinColumns` through to migration changes          |
| `datafn/cli/src/migrations/types.ts`           | MODIFY — add `joinTable`/`joinColumns` to `MigrationChange` for `addRelation` |
| `datafn/cli/src/migrations/render-postgres.ts` | MODIFY — render named join table DDL                                          |
| `datafn/cli/src/migrations/render-mysql.ts`    | MODIFY — render named join table DDL                                          |
| `datafn/cli/src/migrations/render-sqlite.ts`   | MODIFY — render named join table DDL                                          |
| `datafn/cli/src/codegen.ts`                    | MODIFY — emit join table interfaces                                           |
| `datafn/cli/__tests__/codegen.test.ts`         | MODIFY — add join table codegen tests                                         |
| `datafn/cli/__tests__/migrations.test.ts`      | MODIFY — add named join table migration tests                                 |

## Requirements Covered

- CLI-001, CLI-002

## Implementation Tasks

### Update migration diff

- [ ] In `diffSchemas`, pass `joinTable` and `joinColumns` from `DatafnRelationSchema` to the `addRelation` change
- [ ] Update `MigrationChange` type to include `joinTable?` and `joinColumns?` on `addRelation`

### Update migration renderers

- [ ] `render-postgres.ts`: when `addRelation` has `joinTable`, use that name instead of `__datafn_join_*`; use `joinColumns` for column names
- [ ] `render-mysql.ts`: same
- [ ] `render-sqlite.ts`: same
- [ ] When `joinTable` is NOT set, keep existing `__datafn_join_*` behavior

### Update Drizzle/Prisma/Kysely adapter migration generators

- [ ] Check `datafn/cli/src/migrations/adapters/` for adapter-specific generators
- [ ] Update to use `joinTable`/`joinColumns` when present

### Update codegen

- [ ] In `generateTypes`: for each `many-many` relation with `metadata`, emit an interface with `joinColumns.from`, `joinColumns.to`, and metadata fields
- [ ] Add to `Tables` mapping type

### Tests

- [ ] Add test for migration with `joinTable` schema → verify DDL uses correct table name and columns
- [ ] Add test for codegen with `joinTable` + `metadata` → verify interface emitted

## Verification Steps

```bash
# Run CLI tests
cd /Users/ar/dev/superfunctions/datafn/cli
npm test
```

**Expected**: All existing tests pass. New tests for named join table migration and codegen pass.

## Stop Condition

CLI generates correct DDL for named join tables. Codegen emits join table interfaces. All tests pass.

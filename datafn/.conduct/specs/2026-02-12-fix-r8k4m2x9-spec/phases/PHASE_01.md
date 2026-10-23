# Phase 01 — Implement `InternalCrud` in All Adapters

## Phase Goal

Implement the `InternalCrud` interface in all 4 adapter implementations (Drizzle, Prisma, Kysely, Memory) with tests.

## In Scope

- Drizzle adapter `InternalCrud` implementation (raw SQL via `sql` tag)
- Prisma adapter `InternalCrud` implementation (via `$executeRaw` / `$queryRaw`)
- Kysely adapter `InternalCrud` implementation (via `db.schema` + `sql`)
- Memory adapter `InternalCrud` implementation (in-memory Map)
- `ensureTable` caching and name validation
- Tests for each adapter's `InternalCrud`

## Out of Scope

- Server changes (Phase 02)
- Schema changes (Phase 03)

## Deliverables

| File                                               | Action                                       |
| -------------------------------------------------- | -------------------------------------------- |
| `packages/db/src/adapters/drizzle/index.ts`        | MODIFY — add `InternalCrud` implementation   |
| `packages/db/src/adapters/drizzle/internal.ts`     | NEW — internal CRUD helper for Drizzle       |
| `packages/db/src/adapters/prisma/index.ts`         | MODIFY — add `InternalCrud` implementation   |
| `packages/db/src/adapters/prisma/internal.ts`      | NEW — internal CRUD helper for Prisma        |
| `packages/db/src/adapters/kysely/index.ts`         | MODIFY — add `InternalCrud` implementation   |
| `packages/db/src/adapters/kysely/internal.ts`      | NEW — internal CRUD helper for Kysely        |
| `packages/db/src/adapters/memory/index.ts`         | MODIFY — add `InternalCrud` implementation   |
| `packages/db/src/adapters/drizzle/drizzle.test.ts` | MODIFY — add internal CRUD tests             |
| `packages/db/src/adapters/memory/memory.test.ts`   | MODIFY — add internal CRUD tests (if exists) |

## Requirements Covered

- DRZ-001, PRS-001, KYS-001, MEM-001
- ICRUD-003 (ensureTable caching)

## Implementation Tasks

### Memory Adapter (start here — simplest)

- [ ] Add `ensuredTables` Set for caching
- [ ] Implement `ensureTable`: validate name, create map entry if absent, cache
- [ ] Implement `create`: insert into map, return data
- [ ] Implement `findOne`: linear scan with where matching, return first or null
- [ ] Implement `findMany`: filter + sort + limit
- [ ] Implement `update`: update matching rows, return count
- [ ] Implement `delete`: remove matching rows, return count
- [ ] Wire up as `internal` property on returned adapter

### Drizzle Adapter

- [ ] Create `internal.ts` with `createDrizzleInternalCrud(db, dialect)` factory
- [ ] Implement `ensureTable`: build `CREATE TABLE IF NOT EXISTS` SQL per dialect, execute via `db.run(sql`...`)`
- [ ] Implement CRUD using `db.all(sql`...`)` for reads and `db.run(sql`...`)` for writes
- [ ] Build parameterized SQL safely using `sql` template tag
- [ ] Add `ensuredTables` cache
- [ ] Wire up in `drizzleAdapter` factory
- [ ] Add tests to `drizzle.test.ts` covering TV-DRZ-INTERNAL-001, TV-DRZ-INTERNAL-002

### Prisma Adapter

- [ ] Create `internal.ts` with `createPrismaInternalCrud(prisma)` factory
- [ ] Implement using `prisma.$executeRaw` and `prisma.$queryRaw`
- [ ] Wire up in `prismaAdapter` factory

### Kysely Adapter

- [ ] Create `internal.ts` with `createKyselyInternalCrud(db, dialect)` factory
- [ ] Implement using `db.schema.createTable().ifNotExists()` for DDL
- [ ] Implement CRUD using `sql` raw builder
- [ ] Wire up in `kyselyAdapter` factory

## Verification Steps

```bash
cd /Users/ar/dev/superfunctions/packages/db
npm run test
```

**Expected**: All existing tests pass, plus new internal CRUD tests pass. Focus on Drizzle + Memory tests (Prisma/Kysely may need database setup).

## Stop Condition

All 4 adapters implement `InternalCrud`. Drizzle and Memory adapter tests pass. TypeScript compiles cleanly.

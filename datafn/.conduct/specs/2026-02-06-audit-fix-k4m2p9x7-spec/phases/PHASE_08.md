## Phase goal

Improve local query execution performance and operator coverage so offline queries avoid full scans when indexable and match required DFQL semantics.

## In scope

- Index-aware routing for:
  - `id eq` → `getRecord`
  - indexed `field eq` → `findRecords`
- Operator support in local filter evaluation:
  - `$and`, `$or`
  - `eq/$eq`, `$ne`, `$gt`, `$gte`, `$lt`, `$lte`, `$in`, `$nin`
  - `$contains` for arrays
- Deterministic ordering and error codes for unsupported operators.
- Tests for routing and operator semantics.

## Out of scope

- Complex nested-path filtering (Undefined).
- Full-text local search (not required by identified gaps).

## Deliverables

- Modify:
  - `datafn/client/src/offline/query.ts`
  - `datafn/client/src/adapters/indexedDbStorage.ts` (ensure indexes are discoverable)
  - `datafn/client/src/storage.ts` (helper methods if needed)
- Add/modify tests:
  - `datafn/client/__tests__/offline-query.test.ts`

## Requirements covered

- OFFQ-001
- OFFQ-002

## Implementation tasks

- [ ] Add planning step to local query executor:
  - detect `filters.id.eq` → use `getRecord`
  - detect single-field `eq` on indexed field → use `findRecords`
  - otherwise fall back to scan with deterministic ordering
- [ ] Implement operator evaluation:
  - validate operator shapes (arrays vs scalars) deterministically
  - implement `$and/$or` recursion with deterministic short-circuit behavior
  - reject unsupported operators with `DFQL_UNSUPPORTED` and correct `path`
- [ ] Ensure deterministic result ordering:
  - stable sort by `id:asc` if scan path is used and no explicit orderBy is present
- [ ] Tests:
  - TV-OFFQ-001/TV-OFFQ-001N
  - TV-OFFQ-002/TV-OFFQ-002N

## Verification steps

```bash
npm test -w @datafn/client
```

## Stop condition

Before starting Phase 09, report:

- The exact heuristics used to decide when to use indexes vs scans.
- Any cases where determinism required extra sorting (and the cost).


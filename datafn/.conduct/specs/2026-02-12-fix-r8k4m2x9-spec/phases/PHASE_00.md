# Phase 00 — Define `InternalCrud` Interface and Types

## Phase Goal

Define and export the `InternalCrud` and `InternalColumnDef` types in `@superfunctions/db`, and add the `internal` property to the `Adapter` interface.

## In Scope

- `InternalCrud` interface definition
- `InternalColumnDef` type definition
- Adding `readonly internal: InternalCrud` to `Adapter` interface
- Exporting types from the package

## Out of Scope

- Adapter implementations (Phase 01)
- Server changes (Phase 02)
- Schema changes (Phase 03)

## Deliverables

| File                               | Action                                                                        |
| ---------------------------------- | ----------------------------------------------------------------------------- |
| `packages/db/src/adapter/types.ts` | MODIFY — add `InternalCrud`, `InternalColumnDef`, add `internal` to `Adapter` |
| `packages/db/src/index.ts`         | MODIFY — export new types                                                     |

## Requirements Covered

- ICRUD-001
- ICRUD-002

## Implementation Tasks

- [ ] Define `InternalColumnDef` type in `types.ts`
- [ ] Define `InternalCrud` interface in `types.ts`
- [ ] Add `readonly internal: InternalCrud` to `Adapter` interface
- [ ] Export `InternalCrud` and `InternalColumnDef` from `packages/db/src/index.ts`
- [ ] Run `tsc --noEmit` to verify types compile (expect adapter impl errors — those are fixed in Phase 01)

## Verification Steps

```bash
cd /Users/ar/dev/superfunctions/packages/db
npx tsc --noEmit 2>&1 | head -20
```

**Expected**: Type definitions compile. Adapter implementations will show errors (expected — fixed in Phase 01).

## Stop Condition

Types compile and are exported. Report any unexpected type errors before proceeding.

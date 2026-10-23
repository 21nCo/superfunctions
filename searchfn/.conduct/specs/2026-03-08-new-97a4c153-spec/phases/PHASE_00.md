# PHASE_00

## Phase goal
Freeze the rewrite boundary, canonical contracts, and migration inventory before implementation.

## In scope / Out of scope
In scope:
- Finalize adapter contract and wrapper package responsibilities.
- Create migration inventory for internal consumers and legacy symbols.
- Create conformance test scaffold.

Out of scope:
- Full external adapter implementations.
- Docs site content.

## Deliverables
- `searchfn/adapters/src/types.ts` (finalized contract shape)
- `searchfn/adapters/__tests__/conformance/shared.ts` (new)
- `searchfn/adapters/__tests__/conformance/README.md` (new)
- `searchfn/.conduct/migration/searchfn-rewrite-inventory.md` (new)

## Requirements covered
- ARCH-001
- API-001

## Implementation tasks
1. Define final `SearchAdapter` API surface in `types.ts` (including `signal`, optional capabilities).
2. Add conformance harness helper module and required assertions list.
3. Generate migration inventory listing all old imports/exports and target replacements.
4. Add guard test that fails if wrapper packages import legacy internals.

## Verification steps
1. `npm --prefix searchfn/adapters run typecheck`
- Expected: exit code 0.
2. `npm --prefix searchfn/adapters test -- __tests__/conformance/*.test.ts --runInBand`
- Expected: scaffold tests execute and report pending/skipped or pass state with no runtime errors.
3. `rg -n "SearchEngine|InMemorySearchFn|migrateFlexStoreToSearchFn" /Users/serro/Documents/dev/n/superfunctions/searchfn /Users/serro/Documents/dev/n/superfunctions/recfn`
- Expected: output captured in migration inventory.

## Stop condition
Contract and migration inventory are committed, and conformance harness is ready for adapter implementation phases.

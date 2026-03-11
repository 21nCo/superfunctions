# PHASE_02

## Phase goal
Rewrite `@searchfn/client` into a thin client API over adapters for direct app usage.

## In scope / Out of scope
In scope:
- `createSearchClient` and convenience constructors.
- Defaulting/clamping/validation and deterministic sorting guarantees.
- Removal of legacy runtime exports from main entrypoint.

Out of scope:
- Internal consumer migration.
- External adapter implementations.

## Deliverables
- `searchfn/client/src/client.ts` (new)
- `searchfn/client/src/constructors.ts` (new)
- `searchfn/client/src/types.ts` (new)
- `searchfn/client/src/index.ts` (rewritten)
- `searchfn/client/__tests__/client.test.ts` (new)
- `searchfn/client/__tests__/constructors.test.ts` (new)
- `searchfn/client/package.json` (updated exports/scripts)

## Requirements covered
- ARCH-001
- ARCH-002
- CLI-001
- CLI-002
- CLI-003

## Implementation tasks
1. Add a thin `SearchClient` implementation that wraps a provided `SearchAdapter`.
2. Implement convenience constructors for memory/indexeddb adapters.
3. Add input validation and limit clamping consistent with spec caps.
4. Rewrite entrypoint exports to only new API surfaces.
5. Add tests for delegation, validation failures, and deterministic output.

## Verification steps
1. `npm --prefix searchfn/client run typecheck`
- Expected: exit code 0.
2. `npm --prefix searchfn/client test -- --runInBand`
- Expected: new client tests pass.
3. `node -e "import('/Users/serro/Documents/dev/n/superfunctions/searchfn/client/dist/index.js').then(m=>console.log(Object.keys(m)))"`
- Expected: output does not include legacy symbols.

## Stop condition
Client package exports only thin API wrappers and passes delegation/validation tests.

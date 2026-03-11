# PHASE_06

## Phase goal
Align DataFn bridge behavior to new adapters and migrate internal consumers to rewritten SearchFn APIs.

## In scope / Out of scope
In scope:
- Harden `@searchfn/datafn-provider` for new contracts and deterministic fallback behavior.
- Migrate `recfn` and other in-repo consumers off removed SearchFn APIs.
- Validate DataFn integration paths.

Out of scope:
- Legacy code deletion (handled next phase).
- Docs site implementation.

## Deliverables
- `searchfn/datafn-provider/src/index.ts` (updated)
- `searchfn/datafn-provider/__tests__/factory.test.ts` (updated)
- `searchfn/datafn-provider/__tests__/fallback.test.ts` (updated)
- `recfn/server/src/integrations/searchfn.ts` (migrated)
- `recfn/server/package.json` (dependency/update if needed)
- Additional migrated files discovered by repo-wide import scan

## Requirements covered
- DFP-001
- MIG-001

## Implementation tasks
1. Ensure `createSearchProvider` forwards `signal` and deterministic fallback ranking.
2. Update internal consumer imports to new thin client/server APIs.
3. Remove any usage of `SearchEngine`, `InMemorySearchFn`, and compat migration helpers.
4. Add/update tests for migrated consumers and provider bridge.

## Verification steps
1. `npm --prefix searchfn/datafn-provider run typecheck && npm --prefix searchfn/datafn-provider test`
- Expected: all pass.
2. `npm --prefix recfn/server run typecheck && npm --prefix recfn/server test`
- Expected: all pass.
3. `rg -n "SearchEngine|InMemorySearchFn|migrateFlexStoreToSearchFn|@searchfn/client" /Users/serro/Documents/dev/n/superfunctions/recfn /Users/serro/Documents/dev/n/superfunctions/searchfn /Users/serro/Documents/dev/n/superfunctions/datafn -g '!**/dist/**'`
- Expected: no legacy symbol usage outside intentionally retained files pending Phase 07 deletions.

## Stop condition
All internal consumers compile on rewritten APIs and DataFn bridge tests are green.

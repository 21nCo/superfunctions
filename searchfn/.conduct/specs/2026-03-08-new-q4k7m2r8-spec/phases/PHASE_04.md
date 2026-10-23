# PHASE_04 — createSearchProvider Factory

## Phase Goal
Build the `@searchfn/datafn-provider` package with the `createSearchProvider` factory that converts any `SearchAdapter` into a DataFn `SearchProvider`.

## In Scope
- `createSearchProvider(adapter, options?)` factory
- Method bridging: `search()`, `updateIndices()`, `searchAll()`, `initialize()`, `dispose()`
- `searchAll` fallback when adapter lacks native searchAll
- `resourceFields` for extracting search fields from mutation records
- Tests

## Out of Scope
- Built-in mutation/sync wiring (that's DataFn's responsibility, PHASE_05)
- DataFn server/client `.search()` method (PHASE_05)
- HTTP route (PHASE_05)
- Hook methods (`afterMutation`, `afterSync` etc.) — SearchProvider does NOT have hooks

## Deliverables
- `searchfn/datafn-provider/package.json` — `@searchfn/datafn-provider`
- `searchfn/datafn-provider/tsconfig.json`
- `searchfn/datafn-provider/tsup.config.ts`
- `searchfn/datafn-provider/src/index.ts` — `createSearchProvider` export
- `searchfn/datafn-provider/__tests__/factory.test.ts` — factory tests
- `searchfn/datafn-provider/__tests__/fallback.test.ts` — searchAll fallback tests

## Requirements Covered
- PROV-004, PROV-005

## Implementation Tasks
1. Create `searchfn/datafn-provider/` directory structure
2. Create `package.json`:
   - Name: `@searchfn/datafn-provider`
   - Dependencies: `@searchfn/adapters`
   - Peer dependencies: `@datafn/core` (types only, for `SearchProvider` type)
3. Create `tsconfig.json` and `tsup.config.ts`
4. Implement `createSearchProvider` in `src/index.ts`:
   ```typescript
   export function createSearchProvider(
     adapter: SearchAdapter,
     options?: CreateSearchProviderOptions,
   ): SearchProvider {
     const resourceFields = options?.resourceFields ?? {};

     return {
       name: adapter.name,

       async search({ resource, query, type, fields, limit }) {
         const ids = await adapter.search({
           resource,
           query,
           fields,
           limit: limit ?? 50,
         });
         return ids.map(id => String(id));
       },

       async updateIndices({ resource, records, operation }) {
         if (operation === "delete") {
           await adapter.remove({ resource, ids: records.map(r => String(r.id)) });
         } else {
           const searchFields = resourceFields[resource];
           const documents = records.map(r => ({
             id: String(r.id),
             fields: extractFields(r, searchFields),
           }));
           await adapter.index({ resource, documents });
         }
       },

       async searchAll(params) { /* delegate or fallback */ },

       async initialize(config) {
         if (adapter.initialize) {
           await adapter.initialize(config);
         }
       },

       async dispose() {
         if (adapter.dispose) {
           await adapter.dispose();
         }
       },
     };
   }
   ```
5. Implement `searchAll` with fallback:
   - If `adapter.searchAll` exists, delegate directly
   - If not: resolve resources from `params.resources` or `resourceFields` keys
   - If resources cannot be resolved: throw `DFQL_INVALID` (`resources are required when adapter.searchAll is unavailable`)
   - Call `adapter.search()` per resource (parallel, max 10 concurrent)
   - Assign synthetic scores `(limitPerResource - index)`
   - Merge and sort deterministically: `score DESC`, `resource ASC`, `id ASC` (string form)
6. Implement `extractFields` helper:
   - Given a record and a list of field names, extract string values
   - Convert non-string values to string representations
   - Skip null/undefined fields
7. Write `__tests__/factory.test.ts`:
   - TV-PROV-004: factory creates valid SearchProvider
   - TV-PROV-005: search delegates to adapter.search
   - Verify factory does not modify adapter instance
   - Verify initialize/dispose delegate to adapter
8. Write `__tests__/fallback.test.ts`:
   - TV-FALL-001: fallback for adapter without searchAll
   - TV-FALL-002: fallback respects limitPerResource
   - TV-FALL-003: fallback without resolvable resources returns `DFQL_INVALID`
9. Create `vitest.config.ts`

## Verification Steps
1. `cd searchfn/datafn-provider && npx tsc --noEmit` — no errors
2. `cd searchfn/datafn-provider && npx vitest run` — all tests pass
3. TV-PROV-004, TV-PROV-005, TV-FALL-001, TV-FALL-002, TV-FALL-003 all pass
4. Verify factory output satisfies `SearchProvider` type from PHASE_03

## Stop Condition
Factory creates valid SearchProvider instances, method bridging works, fallback works. Report test results before proceeding to PHASE_05.

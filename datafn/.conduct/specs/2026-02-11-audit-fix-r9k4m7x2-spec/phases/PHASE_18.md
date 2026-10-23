# PHASE 18 — Client-Side Search Indexing

## Phase Goal
Enable offline full-text search via a client-side search plugin using MiniSearch.

## In Scope
- `createClientSearchPlugin(config)` plugin factory
- Build search index from `indices.search` schema fields
- Update index on local mutations
- Route queries with `search` field to local index when hydrated
- Fallback to remote when not hydrated

## Out of Scope
- Persistent search index (rebuild on each session)
- Vector/semantic search
- Server-side search plugin changes

## Deliverables
- `client/src/plugins/clientSearch.ts` — client search plugin (NEW FILE)
- `client/__tests__/plugins/clientSearch.test.ts` — search tests
- `package.json` — add `minisearch` dependency

## Requirements Covered
- SRCH-001

## Implementation Tasks
1. Add `minisearch` as an optional dependency
2. Create `createClientSearchPlugin()`:
   ```typescript
   function createClientSearchPlugin(options?: {
     boost?: Record<string, number>;
   }): DatafnPlugin {
     const indices = new Map<string, MiniSearch>();
     return {
       runsOn: ["client"],
       afterSync: async ({ phase, schema, storage }) => {
         if (phase === "clone" || phase === "pull") {
           await rebuildIndices(schema, storage, indices);
         }
       },
       afterMutation: async ({ mutation, result }) => {
         updateIndex(indices, mutation, result);
       },
       beforeQuery: async ({ query }) => {
         if (query.search && indices.has(query.resource)) {
           const results = indices.get(query.resource)!.search(query.search);
           query._searchCandidateIds = results.map(r => r.id);
         }
       },
     };
   }
   ```
3. `rebuildIndices()`: for each resource with `indices.search`, build MiniSearch index from all records
4. `updateIndex()`: on insert/merge, add/update index entry; on delete, remove
5. Query execution path: if `_searchCandidateIds` is present, filter results to those IDs
6. Write test: search returns matching records from local index
7. Write test: index updated on mutation
8. Write test: fallback to remote when index not built
9. Write test: rebuild index after clone
10. Run full test suite

## Verification Steps
- New tests pass: search, index update, fallback
- `npm test -w @datafn/client` → 0 failures
- TV-SRCH-001, TV-SRCH-001N verified

## Stop Condition
Client-side search works offline. All tests pass. Phase report written.

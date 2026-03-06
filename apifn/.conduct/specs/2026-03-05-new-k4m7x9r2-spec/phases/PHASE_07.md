# Phase 07: Collection Generation

## Phase Goal
Implement generation of OpenCollection YAML collections from OpenAPI documents and routers.

## In Scope
- `openAPIToCollection(doc, options)` — generate collection from OpenAPI
- `routerToCollection(router, options)` — generate from Router directly
- Grouping by tag or path prefix
- Example/default value population
- Environment generation with baseUrl from servers

## Out of Scope
- Collection runner
- Test script generation

## Deliverables
- `apifn/collections/src/generator.ts`
- `apifn/collections/__tests__/generator.test.ts`

## Requirements Covered
- COLL-004, COLL-005

## Implementation Tasks
1. [ ] Implement `openAPIToCollection()`: iterate paths/operations, create CollectionItem per operation
2. [ ] Implement tag-based grouping: operations with same tag go into same folder
3. [ ] Implement path-based grouping: group by first path segment
4. [ ] Implement request body population: use examples from spec, or generate defaults from schema
5. [ ] Implement path parameter variables: `:id` → `{{id}}`
6. [ ] Implement environment generation: create development env with `baseUrl` from spec servers
7. [ ] Implement `routerToCollection()`: call `fromRouter()` then `openAPIToCollection()`
8. [ ] Write tests for TV-COLL-004, TV-COLL-005
9. [ ] Validate generated collections via `validateCollection()`
10. [ ] Export from collections index

## Verification Steps
1. `npm run test` → all generator tests pass
2. TV-COLL-004: OpenAPI with tags → grouped collection with correct structure
3. Generated collection validates as OpenCollection
4. Generated collection readable by `readCollection()`

## Stop Condition
Generated collections are valid and readable. Report number of generated request files.

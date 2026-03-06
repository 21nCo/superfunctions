# Phase 02: Route Introspection

## Phase Goal
Implement `introspectRouter()` that extracts structured route metadata from a `@superfunctions/http` Router instance.

## In Scope
- `introspectRouter(router, options?)` implementation
- Path parameter conversion (`:param` → `{param}`)
- Schema descriptor parsing from `route.meta`
- Include/exclude filtering
- Routes without descriptors (default handling)
- `apiSchema()` helper function

## Out of Scope
- Schema conversion (zod/TypeBox → JSON Schema) — next phase
- OpenAPI generation — later phase

## Deliverables
- `apifn/core/src/introspect.ts`
- `apifn/core/src/api-schema.ts` — `apiSchema()` helper
- `apifn/core/__tests__/introspect.test.ts`

## Requirements Covered
- INTRO-001, INTRO-002, INTRO-003, INTRO-004, INTRO-005

## Implementation Tasks
1. [ ] Implement `apiSchema(descriptor: SchemaDescriptor): SchemaDescriptor` identity helper with type checking
2. [ ] Implement path parameter extraction: parse `:paramName` from path, convert to `{paramName}`, generate parameter descriptors
3. [ ] Implement schema descriptor parsing: detect known keys in `route.meta`, map to IntrospectedRoute fields
4. [ ] Implement include/exclude filtering: prefix match on route paths
5. [ ] Implement default handling for routes without meta: empty parameters, default 200 response
6. [ ] Implement `basePath` option: prepend to all paths
7. [ ] Write tests for TV-INTRO-001 through TV-INTRO-007
8. [ ] Export `introspectRouter` and `apiSchema` from index

## Verification Steps
1. `cd apifn/core && npm run test` → all introspection tests pass
2. TV-INTRO-001: Router with 2 routes → 2 IntrospectedRoute objects with correct method/path
3. TV-INTRO-005: `/users/:id` → `/users/{id}` with path parameter
4. TV-INTRO-006: Include/exclude filtering works
5. TV-INTRO-007: Route with no meta → default IntrospectedRoute

## Stop Condition
All introspection tests pass. Report test count and coverage.

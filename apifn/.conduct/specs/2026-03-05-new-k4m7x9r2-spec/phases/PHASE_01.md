# Phase 01: Core Types

## Phase Goal
Define and export all shared TypeScript types and interfaces from `@apifn/core`.

## In Scope
- All types from SPEC Section 5.1
- All types from SPEC Section 5.2 (Collection types)
- All types from SPEC Section 5.8 (Integration types)
- Type-only exports (no runtime code)

## Out of Scope
- Runtime implementations
- Schema conversion logic

## Deliverables
- `apifn/core/src/types.ts` — all core types
- `apifn/core/src/index.ts` — re-exports
- `apifn/collections/src/types.ts` — collection types
- Type compilation tests

## Requirements Covered
- CORE-002

## Implementation Tasks
1. [ ] Define `HttpMethod`, `IntrospectOptions`, `IntrospectedRoute`, `ParameterDescriptor`, `RequestBodyDescriptor`, `ResponseDescriptor`, `SecurityRequirement` in `core/src/types.ts`
2. [ ] Define `SchemaDescriptor`, `apiSchema` helper type
3. [ ] Define `OpenAPIGenerateOptions`, `OpenAPIDocument` and all OpenAPI sub-types (InfoObject, ServerObject, PathsObject, OperationObject, etc.)
4. [ ] Define `DiffResult`, `DiffEntry` types
5. [ ] Define `ValidationError` type
6. [ ] Define collection types in `collections/src/types.ts`: `Collection`, `CollectionInfo`, `CollectionItem`, `OpenCollectionRequest`, `Environment`
7. [ ] Define runner types: `RunOptions`, `RunReport`, `RequestResult`, `AssertionResult`, `RunReporter`, `HttpClient`
8. [ ] Define integration types: `EndpointMetrics`, `RateLimitInfo`
9. [ ] Export all types from package index files
10. [ ] Add subpath export `@apifn/core/types` in package.json
11. [ ] Write type import verification test

## Verification Steps
1. `cd apifn/core && npm run build` → exit 0, `.d.ts` files generated
2. TypeScript file that imports all types from `@apifn/core` compiles without errors
3. TypeScript file that imports from `@apifn/core/types` compiles without errors

## Stop Condition
All types compile and are importable. Report the full list of exported types.

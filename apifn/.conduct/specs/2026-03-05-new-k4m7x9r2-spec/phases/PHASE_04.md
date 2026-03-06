# Phase 04: OpenAPI Generation

## Phase Goal
Implement `generateOpenAPI()` and `fromRouter()` to produce valid OpenAPI 3.1.0 documents from introspected routes.

## In Scope
- `generateOpenAPI(routes, options)` — full OpenAPI 3.1.0 document generation
- `fromRouter(router, options)` — convenience wrapper
- Operation objects, parameters, request bodies, responses
- Tag collection, security schemes, servers
- Deterministic output (sorted keys, stable arrays)

## Out of Scope
- OpenAPI import/parsing (next phase)
- Diff (later phase)

## Deliverables
- `apifn/core/src/openapi/generate.ts`
- `apifn/core/src/openapi/from-router.ts`
- `apifn/core/__tests__/openapi-generate.test.ts`

## Requirements Covered
- OPENAPI-001, OPENAPI-002, OPENAPI-003, OPENAPI-004, OPENAPI-005, OPENAPI-006, OPENAPI-007, OPENAPI-008, OPENAPI-009, OPENAPI-010

## Implementation Tasks
1. [ ] Implement path object generation: group routes by path, create operation per method
2. [ ] Implement parameter generation: path params from path, query/header from descriptors
3. [ ] Implement request body generation from SchemaDescriptor.body
4. [ ] Implement response object generation from SchemaDescriptor.responses (with default 200 fallback)
5. [ ] Implement tag collection and deduplication
6. [ ] Implement security scheme emission (global + per-operation)
7. [ ] Implement server objects emission
8. [ ] Implement deterministic JSON serialization (sorted keys)
9. [ ] Implement `fromRouter()` as `generateOpenAPI(introspectRouter(router, opts), opts)` wrapper
10. [ ] Write tests for TV-OPENAPI-001 through TV-OPENAPI-010
11. [ ] Add OpenAPI validation test (validate output against 3.1 JSON Schema)
12. [ ] Export from core index

## Verification Steps
1. `npm run test` → all OpenAPI generation tests pass
2. TV-OPENAPI-001: Generated document validates against OpenAPI 3.1.0 JSON Schema
3. TV-OPENAPI-002: Each route produces correct operation
4. TV-OPENAPI-009: Two calls with same input → byte-identical output
5. TV-OPENAPI-010: `fromRouter` matches manual introspect+generate

## Stop Condition
Generated OpenAPI documents validate against 3.1 JSON Schema. Report validation results.

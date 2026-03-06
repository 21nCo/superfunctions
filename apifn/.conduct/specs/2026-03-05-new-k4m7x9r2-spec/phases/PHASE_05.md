# Phase 05: OpenAPI Import & Validation

## Phase Goal
Implement parsing, validation, and 3.0→3.1 upconversion for existing OpenAPI documents.

## In Scope
- `parseOpenAPI(input)` — JSON, YAML, and object input
- `validateOpenAPI(doc)` — validation against 3.1 JSON Schema
- 3.0.x → 3.1.0 upconversion (nullable handling, openapi field)

## Out of Scope
- OpenAPI 2.0 (Swagger) import
- $ref resolution across files

## Deliverables
- `apifn/core/src/openapi/parse.ts`
- `apifn/core/src/openapi/validate.ts`
- `apifn/core/src/openapi/upconvert.ts`
- `apifn/core/__tests__/openapi-parse.test.ts`
- `apifn/core/__tests__/openapi-validate.test.ts`

## Requirements Covered
- OPENAPI-011, OPENAPI-012, OPENAPI-013

## Implementation Tasks
1. [ ] Add `yaml` package dependency
2. [ ] Implement `parseOpenAPI()`: detect JSON vs YAML, parse, normalize to OpenAPIDocument
3. [ ] Implement `validateOpenAPI()`: validate against OpenAPI 3.1.0 JSON Schema using `ajv` or equivalent
4. [ ] Implement `upconvertFrom3_0(doc)`: handle `nullable`, `example`, update `openapi` field
5. [ ] Auto-detect version in `parseOpenAPI()` and upconvert if 3.0.x
6. [ ] Write tests for TV-OPENAPI-011, TV-OPENAPI-012, TV-OPENAPI-013
7. [ ] Export from core index

## Verification Steps
1. `npm run test` → all parse/validate tests pass
2. TV-OPENAPI-011: JSON and YAML inputs parse correctly
3. TV-OPENAPI-012: Valid doc → empty errors, invalid doc → errors with paths
4. TV-OPENAPI-013: 3.0 doc with `nullable: true` → 3.1 with `type: ["string", "null"]`

## Stop Condition
All parse/validate tests pass. Report parser capabilities.

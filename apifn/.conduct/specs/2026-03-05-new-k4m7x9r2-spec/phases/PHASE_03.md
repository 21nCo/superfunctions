# Phase 03: Schema Conversion

## Phase Goal
Implement the schema conversion system that transforms zod, TypeBox, and plain JSON Schema into JSON Schema (Draft 2020-12) for OpenAPI inclusion.

## In Scope
- Schema type detection (duck-typing)
- Zod → JSON Schema conversion (via `zod-to-json-schema`)
- TypeBox cleanup (strip symbols, pass through)
- Plain JSON Schema pass-through
- Schema deduplication via `$ref`

## Out of Scope
- OpenAPI document generation (next phase)
- Complex $ref resolution for imported specs

## Deliverables
- `apifn/core/src/schema/detect.ts`
- `apifn/core/src/schema/zod.ts`
- `apifn/core/src/schema/typebox.ts`
- `apifn/core/src/schema/convert.ts`
- `apifn/core/src/schema/dedup.ts`
- `apifn/core/__tests__/schema.test.ts`

## Requirements Covered
- SCHEMA-001, SCHEMA-002, SCHEMA-003, SCHEMA-004, SCHEMA-005

## Implementation Tasks
1. [ ] Implement `detectSchemaType(schema)` — returns `"zod" | "typebox" | "jsonschema"` or throws
2. [ ] Implement `convertZodSchema(schema)` — wraps `zod-to-json-schema`
3. [ ] Implement `convertTypeBoxSchema(schema)` — strips TypeBox metadata symbols
4. [ ] Implement `convertSchema(schema)` — unified entry point that detects and converts
5. [ ] Implement `deduplicateSchemas(schemas)` — finds reusable schemas, generates `$ref` entries and component names
6. [ ] Add `zod-to-json-schema` as dependency, `zod` and `@sinclair/typebox` as peer dependencies
7. [ ] Write tests for TV-SCHEMA-001 through TV-SCHEMA-006
8. [ ] Export schema utilities from core index

## Verification Steps
1. `npm run test` → all schema tests pass
2. TV-SCHEMA-001: `z.object({ name: z.string(), age: z.number() })` → correct JSON Schema
3. TV-SCHEMA-003: TypeBox schema passes through correctly
4. TV-SCHEMA-004: Plain JSON Schema unchanged
5. TV-SCHEMA-005: Detection: zod has `_def`, TypeBox has symbol, plain is plain
6. TV-SCHEMA-006: Same schema in two places → one `$ref`

## Stop Condition
All schema conversion tests pass. Report which schema libraries are tested.

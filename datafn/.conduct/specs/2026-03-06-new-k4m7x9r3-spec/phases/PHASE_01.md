# PHASE 01: Schema Validation Integration

## Phase goal
Integrate capability resolution into `validateSchema()` so that capabilities are validated, fields are injected into the schema index, and collisions are detected.

## In scope
- Update `validateSchema()` to resolve capabilities per resource
- Inject capability fields into effective field list
- Detect and error on capability field collisions with user-defined fields
- Validate capability names and configurations
- Update `SchemaIndex` to include capability-injected fields
- Validate `shareable` requires `audit`

## Out of scope
- Codegen (Phase 2)
- Server mutation handling (Phase 3+)

## Deliverables
- `datafn/core/src/schema.ts` (updated — capability resolution in validateSchema)
- `datafn/server/src/validation/schema.ts` (updated — SchemaIndex includes capability fields)
- `datafn/core/src/__tests__/schema-capabilities.test.ts` (new test file)

## Requirements covered
- CAP-003, CAP-004, VA-001, SH-011

## Implementation tasks
1. In `validateSchema()`, after validating resources, resolve capabilities for each resource using `resolveCapabilities(schema.capabilities, resource.capabilities)`
2. Validate capability entries: reject unknown capability names, validate shareable config
3. Check for field collisions: if any user-defined field name matches a capability-injected field name, return `CAPABILITY_FIELD_COLLISION` error
4. Check capability dependencies: if shareable is present without audit, return `CAPABILITY_DEPENDENCY` error
5. Inject capability fields into the resource's effective field list (used by SchemaIndex)
6. Update `buildSchemaIndex()` in server validation to include capability-injected fields in field sets
7. Write tests:
   - Valid schema with capabilities validates
   - Invalid capability name rejected
   - Shareable without config rejected
   - Field collision detected
   - Shareable without audit rejected
   - Capability fields appear in SchemaIndex

## Verification steps
1. `cd datafn/core && npx vitest run` — all tests pass (including new ones)
2. `cd datafn/server && npx vitest run src/validation/` — validation tests pass
3. `npx tsc --noEmit` from both core and server — no type errors

## Stop condition
Schema validation correctly handles capabilities. Collision detection works. All tests pass.

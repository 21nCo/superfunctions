# PHASE 09: Remove SYSTEM_FIELDS & Update All Consumers

## Phase goal
Remove the legacy `SYSTEM_FIELDS` and `READONLY_SYSTEM_FIELDS` constants and update all code that references them.

## In scope
- Remove exports from `@datafn/core`
- Update server validation, authz, pushdown
- Update any test files that reference these constants
- Ensure all consumers now use capability-based field resolution

## Out of scope
- Shareable (Phases 10-12)

## Deliverables
- `datafn/core/src/system-fields.ts` (removed or emptied)
- `datafn/core/src/index.ts` (updated — remove exports)
- `datafn/server/src/validation/schema.ts` (updated)
- `datafn/server/src/validation/authz.ts` (updated — use capability fields)
- `datafn/server/src/execution/query/pushdown.ts` (updated)
- All files referencing SYSTEM_FIELDS updated

## Requirements covered
- CAP-005, VA-003

## Implementation tasks
1. Remove `SYSTEM_FIELDS` and `READONLY_SYSTEM_FIELDS` from `datafn/core/src/system-fields.ts`
2. Remove exports from `datafn/core/src/index.ts`
3. Update `datafn/server/src/validation/schema.ts`:
   - Remove imports of SYSTEM_FIELDS
   - `buildSchemaIndex()` now uses capability-resolved fields (from Phase 1)
4. Update `datafn/server/src/validation/authz.ts`:
   - Remove hardcoded system field arrays (`["createdAt", "updatedAt", ...]`)
   - Use capability-resolved fields from the SchemaIndex to determine which fields are always readable and which are readonly
5. Update `datafn/server/src/execution/query/pushdown.ts`:
   - Remove `import { SYSTEM_FIELDS } from "@datafn/core"`
   - Use capability-resolved field sets
6. Update `datafn/server/src/routes/query/validate.ts`:
   - Remove hardcoded `fieldNames.add("createdAt")` etc.
   - Use capability-resolved fields
7. Search for any remaining references to `SYSTEM_FIELDS` or `READONLY_SYSTEM_FIELDS` across the entire codebase and update them
8. Update tests that import or reference these constants
9. Ensure full build succeeds with no missing imports

## Verification steps
1. `cd datafn && npx tsc --noEmit -p core/tsconfig.json && npx tsc --noEmit -p server/tsconfig.json && npx tsc --noEmit -p client/tsconfig.json && npx tsc --noEmit -p cli/tsconfig.json` — all compile
2. `cd datafn/server && npx vitest run` — all tests pass
3. `cd datafn/core && npx vitest run` — all tests pass
4. Grep for `SYSTEM_FIELDS` → no hits except comments/docs

## Stop condition
No code imports SYSTEM_FIELDS or READONLY_SYSTEM_FIELDS. All builds and tests pass.

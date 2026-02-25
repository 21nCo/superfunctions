# PHASE 00: Runtime Index Field Validation

## Phase Goal

Add index field name validation to `validateSchema()` so that invalid index fields are rejected with a clear, actionable error message.

## In Scope

- Validation of `indices.base`, `indices.search`, and `indices.vector` entries against declared field names
- Validation after index normalization (shorthand `string[]` → `{ base, search, vector }`)
- Error messages that include the invalid field name, index category, resource name, and available fields
- Unit tests covering positive and negative cases

## Out of Scope

- CLI changes (Phase 1)
- Type-safe `defineSchema()` (Phase 1)
- Example schema fixes (Phase 2)

## Deliverables

| File | Action |
|---|---|
| `datafn/core/src/schema.ts` | Modify — add index field validation after line 139 |
| `datafn/cli/__tests__/drizzle-codegen.test.ts` | Modify — add validation test cases |

## Requirements Covered

VAL-001, VAL-002, VAL-003, VAL-004, VAL-005

## Implementation Tasks

1. In `datafn/core/src/schema.ts`, after the index normalization block (line 139), collect field names into a `Set<string>` (reuse the `fieldNames` set from the earlier uniqueness check)
2. Iterate over each category in `normalizedIndices` (`base`, `search`, `vector`)
3. For each index field in the category, check if it exists in the field name set
4. If not found, return `err("SCHEMA_INVALID", ...)` with message format: `Invalid schema: index field "<name>" in indices.<category> does not match any field in resource "<resource>". Available fields: <comma-separated list>`
5. Set the error context path to `resources.<resourceName>.indices.<category>`
6. Add test cases to `drizzle-codegen.test.ts`:
   - TV-VAL-001: Reject `"created_at"` when field is `"createdAt"` (base)
   - TV-VAL-003: Accept valid index fields
   - TV-VAL-004: Reject invalid field in `search`
   - TV-VAL-005: Reject invalid field in `vector`
   - TV-VAL-006: Reject invalid field in shorthand `indices: ["invalid"]`
   - TV-VAL-007: Accept schema with no indices (regression check)

## Verification Steps

1. Run: `cd datafn && npx vitest run cli/__tests__/drizzle-codegen.test.ts`
2. All existing tests pass (no regressions)
3. All new validation tests pass
4. Manually call `validateSchema()` with the todo-app's current broken schema and confirm it returns an error

## Stop Condition

All tests pass. `validateSchema()` correctly rejects invalid index fields and accepts valid ones.

# REQUIREMENTS: Schema Index Validation & Type-Safe Schema Declarations

## Table of Contents

| ID | Priority | Summary |
|---|---|---|
| VAL-001 | P0 | validateSchema() MUST reject index fields that don't match any resource field |
| VAL-002 | P0 | Validation error MUST list available field names |
| VAL-003 | P0 | Validation MUST cover all index categories (base, search, vector) |
| VAL-004 | P0 | Validation MUST run after index normalization |
| VAL-005 | P0 | Existing valid schemas MUST continue to pass |
| CLI-001 | P0 | CLI MUST provide a `validate` command |
| CLI-002 | P1 | `validate` command MUST support --schema flag and auto-discovery |
| CLI-003 | P0 | `validate` MUST exit 0 on success, 1 on failure |
| CLI-004 | P1 | `validate` MUST print actionable output |
| TYP-001 | P1 | @datafn/core MUST export a `defineSchema()` helper function |
| TYP-002 | P1 | `defineSchema()` MUST constrain index entries to declared field names |
| TYP-003 | P1 | `defineSchema()` MUST return DatafnSchema at runtime |
| TYP-004 | P1 | `defineSchema()` MUST be optional — not required for schema use |
| FIX-001 | P0 | Example todo-app schema MUST use correct field names in indices |
| FIX-002 | P1 | Example todo-app schema SHOULD use defineSchema() |

---

## VAL-001

- **ID:** VAL-001
- **Priority:** P0
- **Statement:** `validateSchema()` MUST return an error envelope with code `"SCHEMA_INVALID"` when any entry in `indices.base`, `indices.search`, or `indices.vector` does not exactly match the `name` property of any field in the same resource.
- **Rationale:** Invalid index field names produce broken Drizzle codegen output. Catching them at validation time prevents silent failures.
- **Acceptance criteria:**
  - `validateSchema()` returns `{ ok: false }` when an index field name is not found in the resource's fields
  - The error code is `"SCHEMA_INVALID"`
  - The error message includes the invalid field name, the index category, and the resource name
- **Test vectors:** TV-VAL-001, TV-VAL-002, TV-VAL-003
- **Notes:** Match is exact, case-sensitive. No fuzzy/snake_case resolution.

## VAL-002

- **ID:** VAL-002
- **Priority:** P0
- **Statement:** The validation error message MUST include the list of available field names so the user can identify the correct name.
- **Rationale:** Without showing available names, the user must manually inspect their schema to find the correct field name.
- **Acceptance criteria:**
  - Error message contains a comma-separated list of all field names defined on the resource
- **Test vectors:** TV-VAL-001
- **Notes:** Field names should be listed in the order they appear in the fields array (or alphabetical — either is acceptable as long as consistent).

## VAL-003

- **ID:** VAL-003
- **Priority:** P0
- **Statement:** Index field validation MUST apply to all three index categories: `base`, `search`, and `vector`.
- **Rationale:** All three categories reference field names and can produce invalid output if wrong.
- **Acceptance criteria:**
  - An invalid field in `indices.search` is caught
  - An invalid field in `indices.vector` is caught
  - An invalid field in `indices.base` is caught
- **Test vectors:** TV-VAL-001, TV-VAL-004, TV-VAL-005

## VAL-004

- **ID:** VAL-004
- **Priority:** P0
- **Statement:** Index field validation MUST run after index normalization (conversion of `string[]` shorthand to `{ base, search, vector }` object form).
- **Rationale:** The shorthand `indices: ["field1"]` is normalized to `{ base: ["field1"], search: [], vector: [] }`. Validation must operate on the normalized form.
- **Acceptance criteria:**
  - A schema using shorthand `indices: ["invalidField"]` is rejected with the same error as `indices: { base: ["invalidField"] }`
- **Test vectors:** TV-VAL-006

## VAL-005

- **ID:** VAL-005
- **Priority:** P0
- **Statement:** Existing valid schemas (where all index fields match declared field names) MUST continue to pass validation without changes.
- **Rationale:** Backward compatibility. Only schemas with actual errors are newly rejected.
- **Acceptance criteria:**
  - All existing test schemas in `drizzle-codegen.test.ts` continue to pass `validateSchema()`
  - A schema with `indices: { base: ["type", "createdAt"] }` where both fields exist passes validation
- **Test vectors:** TV-VAL-007

## CLI-001

- **ID:** CLI-001
- **Priority:** P0
- **Statement:** The datafn CLI MUST support a `validate` command that loads a schema file and runs validation without generating output files.
- **Rationale:** Users need a way to check schema validity independently of code generation.
- **Acceptance criteria:**
  - `datafn validate` is recognized as a valid command
  - No files are written to disk when running `validate`
  - Schema loading uses the same mechanism as `generate`
- **Test vectors:** TV-CLI-001, TV-CLI-002
- **Notes:** The validate command does not require `--adapter` or `--database` flags.

## CLI-002

- **ID:** CLI-002
- **Priority:** P1
- **Statement:** The `validate` command MUST support the `--schema <path>` flag and auto-discovery (same behavior as `generate`).
- **Rationale:** Consistent UX with the existing `generate` command.
- **Acceptance criteria:**
  - `datafn validate --schema ./path/to/schema.datafn.ts` validates the specified file
  - `datafn validate` (no --schema) auto-discovers using the existing candidate order
- **Test vectors:** TV-CLI-001

## CLI-003

- **ID:** CLI-003
- **Priority:** P0
- **Statement:** The `validate` command MUST exit with code 0 on valid schemas and code 1 on invalid schemas.
- **Rationale:** Enables use in CI pipelines and pre-commit hooks.
- **Acceptance criteria:**
  - Process exits with 0 when schema is valid
  - Process exits with 1 when schema has validation errors
- **Test vectors:** TV-CLI-001, TV-CLI-002

## CLI-004

- **ID:** CLI-004
- **Priority:** P1
- **Statement:** The `validate` command MUST print `✓ Schema is valid: <path>` on success and `✗ Error: <message>` on failure.
- **Rationale:** Clear, actionable output for the user.
- **Acceptance criteria:**
  - Success output includes the schema file path
  - Failure output includes the full validation error message
- **Test vectors:** TV-CLI-001, TV-CLI-002

## TYP-001

- **ID:** TYP-001
- **Priority:** P1
- **Statement:** `@datafn/core` MUST export a `defineSchema()` function that accepts a schema object literal and returns `DatafnSchema`.
- **Rationale:** Provides the entry point for type-safe schema declarations.
- **Acceptance criteria:**
  - `defineSchema` is exported from `@datafn/core`
  - It accepts an object conforming to the schema shape
  - It returns `DatafnSchema`
- **Test vectors:** TV-TYP-001

## TYP-002

- **ID:** TYP-002
- **Priority:** P1
- **Statement:** `defineSchema()` MUST use a generic constraint with `const` type parameter so that `indices` entries are constrained to the union of literal field `name` values declared in the same resource.
- **Rationale:** This is the core type-safety feature. TypeScript will show a compile error when an index field doesn't match any declared field name.
- **Acceptance criteria:**
  - Writing `indices: { base: ["nonExistentField"] }` in a `defineSchema()` call produces a TypeScript compile error
  - Writing `indices: { base: ["createdAt"] }` where `createdAt` is a declared field name compiles successfully
  - The constraint applies to `base`, `search`, and `vector` arrays
- **Test vectors:** TV-TYP-002, TV-TYP-003
- **Notes:** Requires TypeScript 5.0+ for `const` type parameters.

## TYP-003

- **ID:** TYP-003
- **Priority:** P1
- **Statement:** `defineSchema()` MUST return its input as `DatafnSchema` at runtime (identity function).
- **Rationale:** The function exists purely for type-level constraints. It must not transform or validate at runtime (runtime validation is the job of `validateSchema()`).
- **Acceptance criteria:**
  - `defineSchema(x) === x` (or structurally equivalent — casting is fine)
  - No runtime validation, no exceptions thrown
- **Test vectors:** TV-TYP-001

## TYP-004

- **ID:** TYP-004
- **Priority:** P1
- **Statement:** `defineSchema()` MUST be optional. Users MAY continue annotating schemas with `DatafnSchema` type directly.
- **Rationale:** Backward compatibility. Existing `.datafn.ts` files and JSON schemas must continue to work.
- **Acceptance criteria:**
  - `const schema: DatafnSchema = { ... }` continues to compile and work
  - `validateSchema()` accepts both `defineSchema()` output and plain objects
- **Test vectors:** TV-TYP-004

## FIX-001

- **ID:** FIX-001
- **Priority:** P0
- **Statement:** The example todo-app schema (`datafn/examples/todo-app/server/src/schema.datafn.ts`) MUST use `"createdAt"` (not `"created_at"`) in `indices.base`.
- **Rationale:** The example schema currently has the exact bug this spec addresses.
- **Acceptance criteria:**
  - `indices: { base: ["completed", "createdAt"] }` in the todos resource
  - `datafn validate` passes on the fixed schema
- **Test vectors:** N/A (manual fix)

## FIX-002

- **ID:** FIX-002
- **Priority:** P1
- **Statement:** The example todo-app schema SHOULD be updated to use `defineSchema()` to demonstrate the type-safe pattern.
- **Rationale:** The example should showcase best practices.
- **Acceptance criteria:**
  - Schema file imports `defineSchema` from `@datafn/core`
  - Schema is wrapped in `defineSchema()` call
  - File compiles without TypeScript errors
- **Test vectors:** N/A (manual fix)

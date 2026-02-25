# PHASE 01: CLI Validate Command & defineSchema() Helper

## Phase Goal

Add a `datafn validate` CLI command and a type-safe `defineSchema()` helper function to `@datafn/core`.

## In Scope

- `validate` CLI command with `--schema` support and auto-discovery
- Exit codes: 0 for valid, 1 for invalid
- Success/failure output messages
- `defineSchema()` function with `const` generic parameter for compile-time index validation
- Export `defineSchema` from `@datafn/core`
- Help text update for the new command

## Out of Scope

- Changes to `validateSchema()` (done in Phase 0)
- Example schema fixes (Phase 2)

## Deliverables

| File | Action |
|---|---|
| `datafn/cli/src/cli.ts` | Modify — add `validate` command, update help text |
| `datafn/core/src/types.ts` | Modify — add `defineSchema()` function and generic types |
| `datafn/core/src/index.ts` | Modify — export `defineSchema` |

## Requirements Covered

CLI-001, CLI-002, CLI-003, CLI-004, TYP-001, TYP-002, TYP-003, TYP-004

## Implementation Tasks

### CLI validate command

1. In `datafn/cli/src/cli.ts`, add `validateSchema` and `unwrapEnvelope` imports from `@datafn/core`
2. Add `validate` command branch in the main `if/else` chain (after `generate`, before unknown command)
3. Implement `validateCommand()` async function:
   - Call `resolveSchemaPath()` (reuses existing auto-discovery)
   - Call `loadSchema(path)` (reuses existing loading)
   - Call `validateSchema(schema)` then `unwrapEnvelope(result)`
   - Print `✓ Schema is valid: <path>` on success
   - Catch errors: print `✗ Error: <message>`, exit 1
4. Update `printHelp()` to list the `validate` command

### defineSchema() helper

5. In `datafn/core/src/types.ts`, add the `defineSchema()` function:
   ```ts
   export function defineSchema<
     const R extends readonly {
       name: string;
       version: number;
       fields: readonly { name: string; type: DatafnFieldSchema["type"]; required: boolean; [k: string]: unknown }[];
       indices?: { base?: R[number]["fields"][number]["name"][]; search?: R[number]["fields"][number]["name"][]; vector?: R[number]["fields"][number]["name"][] } | R[number]["fields"][number]["name"][];
       [k: string]: unknown;
     }[]
   >(schema: { resources: R; relations?: DatafnRelationSchema[] }): DatafnSchema {
     return schema as unknown as DatafnSchema;
   }
   ```
   Note: The exact generic constraint may require iteration to get the TypeScript inference right. The key requirements are:
   - `const` parameter to preserve literal types
   - Field name literals extracted and used to constrain indices entries
   - Each resource's indices constrained independently to its own field names (not all resources' fields merged)
6. In `datafn/core/src/index.ts`, add `defineSchema` to the exports (as a value export, not type-only)

## Verification Steps

1. Run: `cd datafn && npx vitest run cli/__tests__/drizzle-codegen.test.ts` — all tests pass
2. Test CLI manually:
   - Create a temp valid schema → `npx datafn validate --schema <path>` → exits 0, prints success
   - Create a temp invalid schema → `npx datafn validate --schema <path>` → exits 1, prints error
3. TypeScript compile check for `defineSchema()`:
   - Write a test `.ts` file with valid indices → `npx tsc --noEmit` → no errors
   - Write a test `.ts` file with invalid indices → `npx tsc --noEmit` → compile error on the invalid field name
4. Verify `defineSchema` is importable: `import { defineSchema } from "@datafn/core"` resolves

## Stop Condition

- `datafn validate` works correctly for both valid and invalid schemas
- `defineSchema()` produces TypeScript errors for invalid index fields and compiles cleanly for valid ones
- All existing tests pass

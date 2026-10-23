# PHASE 02: Fix Example Schema & Regenerate

## Phase Goal

Fix the todo-app example schema to use correct index field names and `defineSchema()`, then regenerate the Drizzle schema output.

## In Scope

- Fix `indices.base` in `schema.datafn.ts` from `["completed", "created_at"]` to `["completed", "createdAt"]`
- Convert example to use `defineSchema()` instead of plain type annotation
- Regenerate `datafn-schema.drizzle.ts` and `datafn-types.ts`
- Verify the generated output has `table.createdAt` (not `table.created_at`)

## Out of Scope

- Changes to core validation or CLI (done in Phases 0 & 1)

## Deliverables

| File | Action |
|---|---|
| `datafn/examples/todo-app/server/src/schema.datafn.ts` | Modify — fix index field name, use `defineSchema()` |
| `datafn/examples/todo-app/server/datafn-schema.drizzle.ts` | Regenerate |
| `datafn/examples/todo-app/server/datafn-types.ts` | Regenerate |

## Requirements Covered

FIX-001, FIX-002

## Implementation Tasks

1. Edit `datafn/examples/todo-app/server/src/schema.datafn.ts`:
   - Change import from `import type { DatafnSchema } from "@datafn/core"` to `import { defineSchema } from "@datafn/core"`
   - Wrap the schema object in `defineSchema()`
   - Change `indices: { base: ["completed", "created_at"] }` to `indices: { base: ["completed", "createdAt"] }`
2. Run `datafn validate` on the fixed schema to confirm it passes
3. Run `datafn generate --adapter drizzle --database postgres` from the example directory to regenerate output files
4. Verify `datafn-schema.drizzle.ts` line for `todos_created_at_idx` now uses `table.createdAt`

## Verification Steps

1. Run: `cd datafn/examples/todo-app/server && npx datafn validate --schema src/schema.datafn.ts` — exits 0
2. Run: `cd datafn/examples/todo-app/server && npx datafn generate --adapter drizzle --database postgres --schema src/schema.datafn.ts` — generates files
3. Inspect `datafn-schema.drizzle.ts`:
   - Contains `index("todos_created_at_idx").on(table.createdAt)` (not `table.created_at`)
   - No other changes to the generated output
4. Run: `cd datafn && npx vitest run cli/__tests__/drizzle-codegen.test.ts` — all tests pass (final regression check)

## Stop Condition

- Example schema uses `defineSchema()` and compiles without errors
- Generated Drizzle schema has correct `table.createdAt` reference
- `datafn validate` passes on the example
- All tests pass

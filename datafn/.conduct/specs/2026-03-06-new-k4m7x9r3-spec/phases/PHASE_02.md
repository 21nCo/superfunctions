# PHASE 02: Drizzle Codegen for Capabilities

## Phase goal
Update the Drizzle codegen to generate columns for capability-injected fields and permissions tables for shareable resources.

## In scope
- Codegen resolves capabilities per resource using `resolveCapabilities()` from core
- Generate columns for timestamps, audit, trash, archivable fields
- Generate `__datafn_permissions_{resource}` table for shareable resources
- Proper column types, nullable, defaults for each capability field

## Out of scope
- Server runtime behavior (Phases 3-6)

## Deliverables
- `datafn/cli/src/drizzle-codegen.ts` (updated)
- `datafn/cli/src/__tests__/drizzle-codegen-capabilities.test.ts` (new)

## Requirements covered
- CG-001, CG-002, CG-003

## Implementation tasks
1. Import `resolveCapabilities` and `getCapabilityFields` from `@datafn/core`
2. In `generateDrizzleSchema()`, after processing user-defined fields for each resource, resolve capabilities and append capability field columns
3. Map capability field types to Drizzle column types:
   - `date` → `bigint("column_name", { mode: "number" })` (epoch ms, matching existing pattern)
   - `string` → `text("column_name")`
   - `boolean` → `boolean("column_name")`
4. Apply nullability: `trashedAt`, `trashedBy`, `createdBy`, `updatedBy` are nullable; `createdAt`, `updatedAt` are notNull; `isArchived` is notNull with default false
5. For shareable resources, generate `__datafn_permissions_{resource}` table:
   - `__ns: text("__ns").notNull()`
   - `id: text("id").notNull()`
   - `resourceId: text("resource_id").notNull()`
   - `userId: text("user_id").notNull()`
   - `level: text("level").notNull()`
   - `grantedBy: text("granted_by").notNull()`
   - `grantedAt: bigint("granted_at", { mode: "number" }).notNull()`
   - PK: `(__ns, id)`
   - Unique index: `(__ns, resourceId, userId)`
   - Index: `(__ns, userId)`
6. Add permissions table to schema exports
7. Write snapshot tests comparing generated output for schemas with various capabilities

## Verification steps
1. `cd datafn/cli && npx vitest run` — all tests pass
2. Generate schema for todo-app with capabilities and verify output has correct columns
3. `npx tsc --noEmit` — no type errors

## Stop condition
Codegen generates correct Drizzle columns for all capability fields and permissions tables. Snapshot tests match.

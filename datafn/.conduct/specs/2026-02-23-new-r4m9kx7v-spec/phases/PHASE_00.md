# PHASE 00: Type System Prerequisites — defineSchema + Deprecation Tags

## Phase Goal

Fix `defineSchema()` return type to preserve literal resource names, and add proper JSDoc `@deprecated` tags to `createSwitchableClient` and related exports.

## In Scope

- Change `defineSchema()` return type from `DatafnSchema` to `T & DatafnSchema`.
- Add JSDoc `@deprecated` tags to `createSwitchableClient`, `SwitchableClient`, `SwitchableClientConfig`.
- Verify that `ResourceNames<typeof defineSchema({...})>` resolves to literal union.
- Verify backward compat: explicit `const s: DatafnSchema = defineSchema(...)` still compiles.

## Out of Scope

- LiveSignal implementation (Phase 1).
- Proxy changes (Phase 2).
- Svelte adapter changes (Phase 3).
- Todo app migration (Phase 4).

## Deliverables

| File | Action | Description |
|---|---|---|
| `datafn/core/src/types.ts` | MODIFY | Change `defineSchema` return type from `DatafnSchema` to `T & DatafnSchema` |
| `datafn/client/src/switchableClient.ts` | MODIFY | Add JSDoc `@deprecated` tags to `createSwitchableClient`, `SwitchableClient`, `SwitchableClientConfig` |
| `datafn/client/src/index.ts` | MODIFY | Add JSDoc `@deprecated` tags to the re-exports of switchable client |
| `datafn/client/__tests__/define-schema-types.test.ts` | CREATE | Compile-time type assertions for defineSchema |

## Requirements Covered

- TYPE-001: defineSchema returns T & DatafnSchema
- TYPE-002: ResourceNames resolves to literal union
- TYPE-003: Existing DatafnSchema annotation still compiles
- DEPR-001: createSwitchableClient has JSDoc @deprecated
- DEPR-002: SwitchableClient/SwitchableClientConfig have JSDoc @deprecated

## Implementation Tasks

1. **Modify `defineSchema` return type** in `datafn/core/src/types.ts`:
   - Change line ~126: `): DatafnSchema {` → `): T & DatafnSchema {`
   - Change the cast: `return schema as unknown as DatafnSchema;` → `return schema as unknown as T & DatafnSchema;`

2. **Add JSDoc `@deprecated` tags** in `datafn/client/src/switchableClient.ts`:
   - Add `/** @deprecated Use createDatafnClient which includes switchContext(), subscribeClient(), and lifecycle-aware signals. Will be removed in next major version. */` before:
     - `export interface SwitchableClientConfig<S>` (line 14)
     - `export interface SwitchableClient<S>` (line 46)
     - `export function createSwitchableClient<S>` (wherever the function declaration is)

3. **Update re-exports** in `datafn/client/src/index.ts`:
   - Add `/** @deprecated Use createDatafnClient instead. */` before the switchable client export block (lines 13-18).

4. **Create type assertion test** at `datafn/client/__tests__/define-schema-types.test.ts`:
   ```typescript
   import { describe, it, expectTypeOf } from "vitest";
   import { defineSchema, type DatafnSchema } from "@datafn/core";
   import type { ResourceNames, DatafnClient } from "../src/client.js";

   describe("defineSchema type preservation", () => {
     const schema = defineSchema({
       resources: [
         { name: "todos", version: 1, fields: [{ name: "title", type: "string" as const, required: true }] },
         { name: "tags", version: 1, fields: [{ name: "label", type: "string" as const, required: true }] },
       ],
     });

     it("ResourceNames resolves to literal union", () => {
       expectTypeOf<ResourceNames<typeof schema>>().toEqualTypeOf<"todos" | "tags">();
     });

     it("schema satisfies DatafnSchema", () => {
       expectTypeOf(schema).toMatchTypeOf<DatafnSchema>();
     });

     it("explicit annotation still works", () => {
       const widened: DatafnSchema = schema;
       expectTypeOf(widened).toEqualTypeOf<DatafnSchema>();
     });
   });
   ```

5. **Run existing tests** to verify no regressions:
   ```bash
   cd datafn/core && npm test
   cd datafn/client && npm test
   ```

## Verification Steps

1. **TypeScript compile check**:
   ```bash
   cd datafn/core && npx tsc --noEmit
   cd datafn/client && npx tsc --noEmit
   ```
   Expected: No errors.

2. **Type test**:
   ```bash
   cd datafn/client && npx vitest run __tests__/define-schema-types.test.ts
   ```
   Expected: All type assertions pass.

3. **Existing test suite**:
   ```bash
   cd datafn/core && npx vitest run
   cd datafn/client && npx vitest run
   ```
   Expected: All existing tests pass.

4. **Manual IDE check**: Open `switchableClient.ts` in an IDE and verify `createSwitchableClient` shows strikethrough (deprecated).

## Stop Condition

Report back:
- `defineSchema` return type change compiles.
- `ResourceNames<typeof schema>` resolves to literal union (test passes).
- `@deprecated` tags are visible in IDE.
- All existing tests pass.

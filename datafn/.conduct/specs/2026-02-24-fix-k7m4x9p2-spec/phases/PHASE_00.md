# PHASE 00: Core Foundations — System Fields + Schema Index

## Phase Goal

Export `SYSTEM_FIELDS` and `READONLY_SYSTEM_FIELDS` constants from `@datafn/core`, and move `buildSchemaIndex()` with its lookup helpers from the server to core. Update the server to import from core and extend the base index with server-specific maps.

## In Scope

- Create `core/src/system-fields.ts` with system field constants.
- Create `core/src/schema-index.ts` with `buildSchemaIndex()`, `getResource()`, `getField()`, `getRelationsFrom()`, `getRelation()`, `getRelationTarget()`.
- Update `core/src/index.ts` to re-export new modules.
- Update `server/src/validation/schema.ts` to import from core and extend.
- Remove local system field definitions from server.
- Create unit tests for both new modules.

## Out of Scope

- Client SchemaIndex adoption (Phase 3).
- Filter evaluation (Phase 1).
- Date codecs (Phase 2).
- Hook runner (Phase 2).

## Deliverables

| File | Action | Description |
|---|---|---|
| `datafn/core/src/system-fields.ts` | CREATE | SYSTEM_FIELDS and READONLY_SYSTEM_FIELDS as ReadonlySet<string> |
| `datafn/core/src/schema-index.ts` | CREATE | buildSchemaIndex(), getResource(), getField(), getRelationsFrom(), getRelation(), getRelationTarget() |
| `datafn/core/src/index.ts` | MODIFY | Re-export system-fields and schema-index modules |
| `datafn/core/__tests__/system-fields.test.ts` | CREATE | Membership and immutability tests |
| `datafn/core/__tests__/schema-index.test.ts` | CREATE | Build, lookup, edge case, and array relation tests |
| `datafn/server/src/validation/schema.ts` | MODIFY | Import SYSTEM_FIELDS, READONLY_SYSTEM_FIELDS from core; import buildSchemaIndex from core and extend with writableFieldsByResource |

## Requirements Covered

- SYS-001: SYSTEM_FIELDS and READONLY_SYSTEM_FIELDS exported from core
- SYS-002: All system field checks import from core
- IDX-001: buildSchemaIndex() in core with full lookup API
- IDX-002: Server validation uses core SchemaIndex
- REG-001: (partial) New core modules re-exported

## Implementation Tasks

1. **Create `core/src/system-fields.ts`**:
   ```typescript
   export const SYSTEM_FIELDS: ReadonlySet<string> = new Set([
     "id", "createdAt", "updatedAt", "createdBy", "updatedBy", "isArchived",
   ]);

   export const READONLY_SYSTEM_FIELDS: ReadonlySet<string> = new Set([
     "createdAt", "updatedAt", "createdBy", "updatedBy",
   ]);
   ```

2. **Create `core/src/schema-index.ts`**:
   - Define `SchemaIndex` interface with `resourcesByName`, `fieldsByResource`, `relationsByResource`, `relationsFromResource` maps.
   - Implement `buildSchemaIndex(schema: DatafnSchema)` that iterates resources and relations, populating maps.
   - For relations with array `from`, index under each from-resource.
   - Implement lookup helpers: `getResource()`, `getField()`, `getRelationsFrom()`, `getRelation()`, `getRelationTarget()`.
   - `getRelationTarget()` returns first element if `to` is an array.

3. **Update `core/src/index.ts`**:
   - Add `export * from "./system-fields.js"`.
   - Add `export * from "./schema-index.js"`.

4. **Create `core/__tests__/system-fields.test.ts`**:
   - Test all 6 system fields are present.
   - Test readonly system fields subset (4 members).
   - Test non-system field returns false.
   - Test that sets are frozen (ReadonlySet).

5. **Create `core/__tests__/schema-index.test.ts`**:
   - Test with a multi-resource schema (todos, tags) with relations.
   - Test `getResource()` for existing and non-existing resources.
   - Test `getField()` for existing and non-existing fields.
   - Test `getRelationsFrom()` returns correct relations.
   - Test `getRelation()` for specific relation lookup.
   - Test `getRelationTarget()` with string and array `to`.
   - Test array `from` relations are indexed under each from-resource.
   - Test empty schema returns empty maps.

6. **Modify `server/src/validation/schema.ts`**:
   - Remove local `SYSTEM_FIELDS` and `READONLY_SYSTEM_FIELDS` definitions.
   - Add `import { SYSTEM_FIELDS, READONLY_SYSTEM_FIELDS, buildSchemaIndex as buildCoreSchemaIndex, type SchemaIndex as CoreSchemaIndex } from "@datafn/core"`.
   - Re-export `SYSTEM_FIELDS` and `READONLY_SYSTEM_FIELDS` for server-internal use.
   - Define `ServerSchemaIndex extends CoreSchemaIndex` with `writableFieldsByResource`.
   - Modify server's `buildSchemaIndex()` to call `buildCoreSchemaIndex()` first, then add `writableFieldsByResource` map.
   - Ensure all existing server tests pass.

## Verification Steps

1. Run `npm test` in `datafn/core` — all tests pass including new ones.
2. Run `npm test` in `datafn/server` — all existing tests pass.
3. `grep -r "new Set.*createdAt.*updatedAt" datafn/server/src/` returns zero results.
4. `import { SYSTEM_FIELDS, buildSchemaIndex } from "@datafn/core"` compiles without errors.

## Stop Condition

- All 4 verification steps pass.
- SYS-001, SYS-002, IDX-001, IDX-002 acceptance criteria met.
- No TypeScript compilation errors in core or server.

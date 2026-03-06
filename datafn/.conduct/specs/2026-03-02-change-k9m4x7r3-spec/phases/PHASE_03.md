# PHASE_03: Update CLI Codegen

## Phase Goal

Rename `isMultiTenant` variable to `isNamespaced` and update all related comments in the CLI drizzle codegen.

## In Scope

- REM-021: Rename `isMultiTenant` to `isNamespaced` in CLI drizzle codegen
- REM-022: Update CLI codegen comments from "multiTenant" to "namespaced"

## Out of Scope

- Test updates (Phase 4)
- Docs (Phases 5-6)

## Deliverables

| File | Action |
|---|---|
| `datafn/cli/src/drizzle-codegen.ts` | Rename `isMultiTenant` → `isNamespaced`, update all comments |

## Requirements Covered

REM-021, REM-022

## Implementation Tasks

1. [ ] Open `datafn/cli/src/drizzle-codegen.ts`
2. [ ] Rename `const isMultiTenant = isNamespaced(schema);` to `const isNs = isNamespaced(schema);` (or keep as `isNamespaced` — but this shadows the imported function name; use `schemaIsNamespaced` or `nsEnabled` to avoid shadowing)
   - **Decision**: Use `const nsEnabled = isNamespaced(schema);` to avoid shadowing.
3. [ ] Replace all usages of `isMultiTenant` with `nsEnabled` throughout the file (approximately 8 occurrences)
4. [ ] Update comment `// Add __ns column when multiTenant` → `// Add __ns column when namespaced` (line 55)
5. [ ] Update comment `// Add __ns column for join tables when multiTenant` → `// Add __ns column for join tables when namespaced` (line 113)
6. [ ] Update comment `// notNull when multi-tenant` → `// notNull when namespaced` (line 134)
7. [ ] Update comment `// primaryKey only when single-tenant` → `// primaryKey only when not namespaced` (line 135)
8. [ ] Update comment `// In multi-tenant mode, composite PK` → `// In namespaced mode, composite PK` (line 237)
9. [ ] Update parameter name `isMultiTenant = false` in `buildColumnDefinition` function → `isNamespaced = false` (line 228)
10. [ ] `grep -i "multi.tenant" datafn/cli/src/drizzle-codegen.ts` returns no results

## Verification Steps

```bash
cd datafn/cli && npx vitest run
```

**Expected outcome**: Tests may reference `multiTenant` in schema definitions — those are fixed in Phase 4 (TST-005). The codegen itself should produce identical output (variable rename is internal).

## Stop Condition

- No `isMultiTenant` or "multi-tenant" / "multiTenant" strings in `drizzle-codegen.ts`.
- Generated Drizzle schema output is byte-identical to before (behavior unchanged).

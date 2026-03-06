# PHASE_00: Remove `multiTenant` from `@datafn/core`

## Phase Goal

Remove all `multiTenant` references from `@datafn/core` — types, schema validation, defineSchema helper, and isNamespaced/resolveNamespaced functions.

## In Scope

- REM-001: Remove `multiTenant` from `DatafnSchema` type
- REM-002: Remove `multiTenant` from `defineSchema()` generic constraint
- REM-003: Remove `multiTenant` handling from `validateSchema()`
- REM-004: Remove `multiTenant` from `isNamespaced()` / `resolveNamespaced()`
- REM-023: Remove `multiTenant` output from `validateSchema` normalized result

## Out of Scope

- Server, client, CLI changes (Phases 1-3)
- Test updates (Phase 4)
- Docs (Phases 5-6)

## Deliverables

| File | Action |
|---|---|
| `datafn/core/src/types.ts` | Remove `multiTenant?: boolean` and its JSDoc from `DatafnSchema`. Remove `multiTenant` from `defineSchema()` generic constraint. |
| `datafn/core/src/schema.ts` | Remove `_multiTenantDeprecationWarned` flag. Remove `multiTenant` branch from `resolveNamespaced()`. Remove `multiTenant` branch from `isNamespaced()`. Remove `multiTenant` deprecation warning from `validateSchema()`. Remove `multiTenant: namespaced` from validated output. |

## Requirements Covered

REM-001, REM-002, REM-003, REM-004, REM-023

## Implementation Tasks

1. [ ] Open `datafn/core/src/types.ts`
2. [ ] Remove `/** @deprecated Use namespaced. Will be removed in next major. */ multiTenant?: boolean;` from `DatafnSchema` type (lines 12-13)
3. [ ] Remove `/** @deprecated Use namespaced. */ readonly multiTenant?: boolean;` from `defineSchema()` generic constraint (lines 129-130)
4. [ ] Open `datafn/core/src/schema.ts`
5. [ ] Remove `let _multiTenantDeprecationWarned = false;` (line 12)
6. [ ] Simplify `resolveNamespaced()`: remove `if (typeof s.multiTenant === "boolean") return s.multiTenant;` (line 20)
7. [ ] Simplify `isNamespaced()`: remove `if (typeof schema.multiTenant === "boolean") return schema.multiTenant;` (line 30)
8. [ ] Remove the multiTenant deprecation warning block (lines 256-260)
9. [ ] Remove `multiTenant: namespaced,` from the `ok()` return (line 271)
10. [ ] Remove the comment `// Preserve multiTenant for backward compatibility` (line 270)
11. [ ] Verify `resolveNamespaced` and `isNamespaced` only check `s.namespaced` / `schema.namespaced`

## Verification Steps

```bash
cd datafn/core && npx vitest run
```

**Expected outcome**: All tests pass. Any test referencing `multiTenant` will fail — those are fixed in Phase 4.

**Note**: Some tests in `schema.test.ts` may reference `multiTenant`. If core tests fail due to this, the test updates from TST-004 should be pulled forward into this phase (update `schema.test.ts` to use `namespaced` only).

## Stop Condition

- `datafn/core/src/types.ts` and `datafn/core/src/schema.ts` no longer contain any `multiTenant` reference.
- TypeScript compiles (may have downstream errors in server/client until those phases run).
- Core tests pass (with test updates if needed).

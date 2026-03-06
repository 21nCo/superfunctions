# PHASE_04: Update and Delete Tests

## Phase Goal

Update all test files to remove legacy API references. Delete test files that only test removed APIs. Ensure all tests pass across the datafn monorepo.

## In Scope

- TST-001: Delete or rewrite `multi-tenant.test.ts`
- TST-002: Update `namespace.test.ts` — remove legacy authContext test vectors
- TST-003: Update `namespace-provider.test.ts` — remove authContextProvider tests
- TST-004: Update `schema.test.ts` — remove multiTenant tests
- TST-005: Update `drizzle-codegen.test.ts` — rename multiTenant refs
- TST-006: Update `indexeddb-namespace.test.ts` — remove createForUser tests if any

## Out of Scope

- Docs (Phases 5-6)

## Deliverables

| File | Action |
|---|---|
| `datafn/client/__tests__/multi-tenant.test.ts` | DELETE |
| `datafn/client/__tests__/namespace.test.ts` | Remove legacy `authContext` test cases |
| `datafn/server/__tests__/namespace-provider.test.ts` | Remove `authContextProvider` test cases |
| `datafn/core/__tests__/schema.test.ts` | Remove `multiTenant` test cases |
| `datafn/cli/__tests__/drizzle-codegen.test.ts` | Rename `multiTenant` → `namespaced` in test schemas |
| `datafn/client/__tests__/indexeddb-namespace.test.ts` | Remove `createForUser` tests if present |
| Any other test files referencing legacy APIs | Update accordingly |

## Requirements Covered

TST-001 through TST-006

## Implementation Tasks

### TST-001: Delete `multi-tenant.test.ts`

1. [ ] Delete `datafn/client/__tests__/multi-tenant.test.ts`
   - This file tests `authContext` (direct object), `AuthContextProvider`, async provider rejection, and `createForUser` — all removed APIs.
   - Coverage is replaced by `namespace.test.ts`.

### TST-002: Update `namespace.test.ts`

2. [ ] Open `datafn/client/__tests__/namespace.test.ts`
3. [ ] Remove test: "TV-NS-017: namespace takes precedence over authContext" (no `authContext` to compare against)
4. [ ] Remove test: "TV-NS-019: legacy factory receives AuthContext"
5. [ ] Remove test: "derives namespace from authContext when namespace not set"
6. [ ] Remove any `authContext` imports or references
7. [ ] Remove `AuthContext` type import
8. [ ] Keep all `namespace`-only test cases
9. [ ] Ensure remaining tests compile and pass

### TST-003: Update `namespace-provider.test.ts`

10. [ ] Open `datafn/server/__tests__/namespace-provider.test.ts`
11. [ ] Remove test: "TV-NS-012: authContextProvider produces tenant:X:user:Y namespace"
12. [ ] Remove test: "TV-NS-013: authContextProvider user-only produces user:Y namespace"
13. [ ] Remove test: "legacy bridge: actorId from authContextProvider.userId"
14. [ ] Remove any `authContextProvider` references in helper setup
15. [ ] Keep all `namespaceProvider` test cases
16. [ ] Ensure remaining tests compile and pass

### TST-004: Update `schema.test.ts`

17. [ ] Open `datafn/core/__tests__/schema.test.ts`
18. [ ] Remove any test cases that pass `multiTenant` to `validateSchema` or `defineSchema`
19. [ ] Remove any test cases checking `result.multiTenant`
20. [ ] Update any test assertions that expect `multiTenant` in validated output
21. [ ] Keep all `namespaced` test cases
22. [ ] Ensure remaining tests compile and pass

### TST-005: Update `drizzle-codegen.test.ts`

23. [ ] Open `datafn/cli/__tests__/drizzle-codegen.test.ts`
24. [ ] Replace all `multiTenant: true` / `multiTenant: false` in test schemas with `namespaced: true` / `namespaced: false`
25. [ ] Rename any test descriptions referencing "multi-tenant" to "namespaced"
26. [ ] Ensure remaining tests compile and pass

### TST-006: Update `indexeddb-namespace.test.ts`

27. [ ] Open `datafn/client/__tests__/indexeddb-namespace.test.ts`
28. [ ] Remove any `createForUser` test cases
29. [ ] Remove any `AuthContext` imports
30. [ ] Ensure remaining tests compile and pass

### Cross-check

31. [ ] `grep -r "authContextProvider\|authContext\|multiTenant\|createForUser\|currentContext" datafn/*/\__tests__/` returns no results (except possibly test descriptions that describe the absence of these features)
32. [ ] Run full test suite: `cd datafn && npx vitest run --reporter=verbose` across all packages

## Verification Steps

```bash
# Run all datafn tests
cd /Users/serro/Documents/dev/n/superfunctions
npx vitest run --config datafn/core/vitest.config.ts
npx vitest run --config datafn/client/vitest.config.ts
npx vitest run --config datafn/server/vitest.config.ts
npx vitest run --config datafn/cli/vitest.config.ts
```

**Expected outcome**: All tests pass. Zero references to legacy APIs in test files.

## Stop Condition

- `multi-tenant.test.ts` is deleted.
- All remaining test files have zero references to `authContextProvider`, `authContext`, `multiTenant`, `createForUser`, `currentContext`.
- All tests pass across core, client, server, and CLI packages.

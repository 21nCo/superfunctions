# PHASE_01: Remove Legacy Code from `@datafn/server`

## Phase Goal

Remove all `authContextProvider`, legacy bridge logic, and `@superfunctions/auth` import from the datafn server package.

## In Scope

- REM-005: Remove `authContextProvider` from `DatafnServerConfig`
- REM-006: Remove legacy bridge from `extractNamespace`
- REM-007: Remove legacy bridge from `extractActorId`
- REM-008: Remove legacy bridge from rate limit key extractor
- REM-009: Remove `authContextProvider` deprecation warning
- REM-010: Remove `@superfunctions/auth` import from server

## Out of Scope

- Client changes (Phase 2)
- Test updates (Phase 4)
- Docs (Phases 5-6)

## Deliverables

| File | Action |
|---|---|
| `datafn/server/src/server.ts` | Remove `authContextProvider` type, remove legacy bridge in `extractNamespace`, `extractActorId`, rate limit key extractor, deprecation warning, and `@superfunctions/auth` import. |

## Requirements Covered

REM-005, REM-006, REM-007, REM-008, REM-009, REM-010

## Implementation Tasks

1. [ ] Open `datafn/server/src/server.ts`
2. [ ] Remove `import type { AuthContext, AuthContextProvider } from "@superfunctions/auth";` (line 11)
3. [ ] Remove the `authContextProvider` field from `DatafnServerConfig` interface (lines 135-144)
4. [ ] Remove the deprecation warning block (lines 279-282):
   ```typescript
   if (config.authContextProvider && !config.namespaceProvider) {
     logger.warn(...)
   }
   ```
5. [ ] Update `hasNamespaceProvider` to only check `config.namespaceProvider` (line 294):
   ```typescript
   // Before: const hasNamespaceProvider = !!(config.namespaceProvider || config.authContextProvider);
   const hasNamespaceProvider = !!config.namespaceProvider;
   ```
6. [ ] Update the `rowLevelNamespace` JSDoc comment (line 187-190) to remove `authContextProvider` mention
7. [ ] Simplify `extractNamespace` (lines 434-465): remove the entire `authContextProvider` branch (lines 446-462)
8. [ ] Simplify `extractActorId` (lines 467-486): remove the `authContextProvider` branch (lines 477-484)
9. [ ] Simplify `defaultKeyExtractor` (lines 380-395): remove the `authContextProvider` branch (lines 387-394)
10. [ ] Search for any other `authContextProvider` or `config.authContextProvider` references in the file and remove them
11. [ ] Verify no `@superfunctions/auth` import remains

## Verification Steps

```bash
cd datafn/server && npx vitest run
```

**Expected outcome**: Tests that use `authContextProvider` will fail — those are fixed in Phase 4. Tests using `namespaceProvider` should pass.

**Note**: If server tests that create servers with `authContextProvider` fail at compile time, the test updates from TST-003 should be pulled forward into this phase.

## Stop Condition

- `datafn/server/src/server.ts` contains no references to `authContextProvider`, `AuthContext`, `AuthContextProvider`, or `@superfunctions/auth`.
- `extractNamespace` has exactly 2 paths: namespaceProvider → use it, else → `"datafn"`.
- `extractActorId` has exactly 2 paths: `getActorId` → use it, else → `undefined`.
- TypeScript compiles for the server package.

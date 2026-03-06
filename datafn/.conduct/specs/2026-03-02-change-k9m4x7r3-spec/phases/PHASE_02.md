# PHASE_02: Remove Legacy Code from `@datafn/client`

## Phase Goal

Remove all `authContext`, `AuthContext`, `AuthContextProvider`, `currentContext()`, `createForUser`, legacy storage factory union, and `userId` from changelog in the client package.

## In Scope

- REM-011: Remove `authContext` from `DatafnClientConfig`
- REM-012: Remove legacy `authContext` resolution from `_buildRawClient`
- REM-013: Remove `currentContext()` from `DatafnClient`
- REM-014: Remove `authContext` from `SwitchContextOverride`
- REM-015: Simplify `DatafnStorageFactory` to `(namespace: string)` only
- REM-016: Remove `userId` from `DatafnChangelogEntry`
- REM-017: Remove `createForUser()` from `IndexedDbStorageAdapter`
- REM-018: Remove `AuthContext`/`AuthContextProvider` re-exports from client index
- REM-019: Remove `@superfunctions/auth` import from client
- REM-020: Remove `authContext` deprecation warning from client

## Out of Scope

- Test updates (Phase 4)
- Docs (Phases 5-6)

## Deliverables

| File | Action |
|---|---|
| `datafn/client/src/client.ts` | Remove `authContext` from config and `SwitchContextOverride`, remove `currentContext()`, remove legacy resolution logic, remove `@superfunctions/auth` import |
| `datafn/client/src/storage.ts` | Simplify `DatafnStorageFactory` to `(namespace: string) => DatafnStorageAdapter`, remove `AuthContext` import, remove `userId` from `DatafnChangelogEntry` |
| `datafn/client/src/adapters/indexedDbStorage.ts` | Remove `createForUser()` static method |
| `datafn/client/src/index.ts` | Remove `AuthContext`/`AuthContextProvider` re-exports |

## Requirements Covered

REM-011 through REM-020

## Implementation Tasks

### `datafn/client/src/storage.ts`

1. [ ] Remove `import type { AuthContext } from "@superfunctions/auth";` (line 5)
2. [ ] Change `DatafnStorageFactory` from `(namespaceOrContext: string | AuthContext) => DatafnStorageAdapter` to `(namespace: string) => DatafnStorageAdapter` (lines 24-26)
3. [ ] Update the old JSDoc (lines 9-18) — remove the legacy example with `createForUser`
4. [ ] Remove `userId?: string;` and its `@deprecated` JSDoc from `DatafnChangelogEntry` (lines 37-38)

### `datafn/client/src/client.ts`

5. [ ] Remove `import type { AuthContext, AuthContextProvider } from "@superfunctions/auth";` (line 19)
6. [ ] Remove `authContext?: AuthContext | AuthContextProvider;` from `DatafnClientConfig` (lines 202-208)
7. [ ] Remove `authContext?: AuthContext;` from `SwitchContextOverride` (lines 226-227)
8. [ ] Remove `currentContext(): AuthContext | undefined;` from `DatafnClient` type (lines 270-271)
9. [ ] Remove the deprecation warning (lines 407-410):
   ```typescript
   if (config.authContext && !config.namespace) {
     console.warn(...);
   }
   ```
10. [ ] Remove `let resolvedAuthContext: AuthContext | undefined;` (line 423)
11. [ ] Simplify storage factory resolution (lines 420-491):
    - When `storage` is a function:
      - If `config.namespace` → `resolvedStorage = config.storage(config.namespace)`
      - Else → throw `DFQL_INVALID` ("namespace is required when storage is a factory function")
    - Remove the entire `else if (config.authContext)` branch (lines 431-463)
    - When `storage` is a direct adapter:
      - `resolvedStorage = config.storage`
      - Remove the `if (config.authContext)` block (lines 475-489) that resolves auth context and derives namespace
12. [ ] Remove `currentContext()` from the proxy/client implementation
13. [ ] Ensure `currentNamespace()` still works (returns `resolvedNamespace`)
14. [ ] Remove any remaining references to `resolvedAuthContext` (used in changelog enrichment, etc.)

### `datafn/client/src/adapters/indexedDbStorage.ts`

15. [ ] Remove the entire `createForUser()` static method (lines 162-195)
16. [ ] Remove the `@deprecated` JSDoc above it

### `datafn/client/src/index.ts`

17. [ ] Remove `export type { AuthContext, AuthContextProvider } from "@superfunctions/auth";` (line 34)

### Final verification

18. [ ] `grep -r "@superfunctions/auth" datafn/client/src/` returns no results
19. [ ] `grep -r "authContext" datafn/client/src/` returns no results (except possibly internal variable names unrelated to the config field)
20. [ ] `grep -r "createForUser" datafn/client/src/` returns no results
21. [ ] `grep -r "currentContext" datafn/client/src/` returns no results
22. [ ] `grep -r "userId" datafn/client/src/storage.ts` returns no results (only `actorId`)

## Verification Steps

```bash
cd datafn/client && npx vitest run
```

**Expected outcome**: Tests using `authContext`, `createForUser`, or `currentContext()` will fail — those are fixed in Phase 4. Tests using `namespace` should pass.

**Note**: If client tests fail at compile time, pull forward test updates from TST-001, TST-002, TST-006 into this phase.

## Stop Condition

- No `@superfunctions/auth` imports in `datafn/client/src/`.
- No `authContext`, `AuthContext`, `AuthContextProvider`, `currentContext`, `createForUser`, `multiTenant` references in client source.
- `DatafnStorageFactory` accepts only `(namespace: string)`.
- `DatafnChangelogEntry` has `actorId` but not `userId`.
- TypeScript compiles for the client package.

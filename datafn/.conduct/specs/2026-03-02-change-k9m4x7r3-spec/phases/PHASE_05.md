# PHASE_05: Update Existing Docs — Remove Legacy References

## Phase Goal

Update all existing documentation files to remove all references to deprecated/removed APIs (`authContextProvider`, `authContext`, `multiTenant`, `createForUser`, `currentContext()`, `userId` on changelog, `AuthContext`, `AuthContextProvider`).

## In Scope

- DOC-001: Update namespace/multi-tenancy doc
- DOC-002: Update client setup doc
- DOC-003: Update server setup doc
- DOC-004: Update client config reference
- DOC-005: Update server config reference
- DOC-006: Update storage reference
- DOC-007: Update core types reference
- DOC-008: Update IndexedDB doc
- DOC-009: Update storage overview doc
- DOC-010: Update security doc
- DOC-011: Update schema concept doc

## Out of Scope

- Svelte/framework adapter docs (Phase 6)

## Deliverables

| File | Action |
|---|---|
| `datafn/docs/content/docs/documentation/concepts/multi-tenancy.mdx` | Remove migration section, remove legacy API references throughout, simplify namespace resolution to 2 steps |
| `datafn/docs/content/docs/documentation/client/setup.mdx` | Remove authContext references |
| `datafn/docs/content/docs/documentation/server/setup.mdx` | Remove authContextProvider references |
| `datafn/docs/content/docs/reference/client/config.mdx` | Remove authContext from type listing, simplify DatafnStorageFactory |
| `datafn/docs/content/docs/reference/server/config.mdx` | Remove authContextProvider from type listing |
| `datafn/docs/content/docs/reference/client/storage.mdx` | Remove AuthContext union from DatafnStorageFactory, remove userId from changelog |
| `datafn/docs/content/docs/reference/core/types.mdx` | Remove multiTenant from DatafnSchema |
| `datafn/docs/content/docs/documentation/storage/indexeddb.mdx` | Remove createForUser references |
| `datafn/docs/content/docs/documentation/storage/overview.mdx` | Remove legacy factory pattern references |
| `datafn/docs/content/docs/documentation/advanced/security.mdx` | Remove authContextProvider references |
| `datafn/docs/content/docs/documentation/concepts/schema.mdx` | Remove multiTenant references |
| `datafn/docs/content/docs/reference/core/schema.mdx` | Remove multiTenant references |

## Requirements Covered

DOC-001 through DOC-011

## Implementation Tasks

### DOC-001: `multi-tenancy.mdx` (highest impact)

1. [ ] Remove "Migration from `multiTenant` / `authContextProvider`" section (lines ~345-410)
2. [ ] Remove "Legacy bridge" step from "Namespace Resolution Order" (step 2) — leave only: (1) `namespaceProvider.getNamespace(ctx)`, (2) Default `"datafn"`
3. [ ] Remove "Legacy: `authContext.userId`" step from "Actor ID Resolution" — leave only: (1) `namespaceProvider.getActorId(ctx)`, (2) `undefined`
4. [ ] Search for any remaining `authContextProvider`, `authContext`, `multiTenant`, `createForUser` references and remove them
5. [ ] Ensure all code examples use only current APIs

### DOC-002: `client/setup.mdx`

6. [ ] Verify no `authContext` references exist (current version appears clean — confirm)
7. [ ] Verify storage factory examples use `(namespace: string) =>` only

### DOC-003: `server/setup.mdx`

8. [ ] Verify no `authContextProvider` references exist (current version appears clean — confirm)
9. [ ] Check the config reference table for any `authContextProvider` row and remove if present

### DOC-004: `reference/client/config.mdx`

10. [ ] Remove `/** @deprecated Use namespace instead. */ authContext?: AuthContext | AuthContextProvider;` from `DatafnClientConfig` listing
11. [ ] Change `DatafnStorageFactory` from `(namespaceOrContext: string | AuthContext)` to `(namespace: string) => DatafnStorageAdapter`
12. [ ] Remove explanatory text about "When the deprecated config.authContext is used"

### DOC-005: `reference/server/config.mdx`

13. [ ] Remove `/** @deprecated Use namespaceProvider instead. */ authContextProvider?: { ... };` from `DatafnServerConfig` listing

### DOC-006: `reference/client/storage.mdx`

14. [ ] Change `DatafnStorageFactory` from `(namespaceOrContext: string | AuthContext)` to `(namespace: string) => DatafnStorageAdapter`
15. [ ] Remove `/** @deprecated */ userId?: string;` from `DatafnChangelogEntry`
16. [ ] Remove explanatory text about "When using the deprecated authContext"

### DOC-007: `reference/core/types.mdx`

17. [ ] Remove `/** @deprecated Use namespaced instead. */ multiTenant?: boolean;` from `DatafnSchema` listing

### DOC-008: `storage/indexeddb.mdx`

18. [ ] Verify no `createForUser` references (current version appears clean — confirm)

### DOC-009: `storage/overview.mdx`

19. [ ] Verify no legacy factory pattern references
20. [ ] Ensure storage factory docs use `(namespace: string) =>` only

### DOC-010: `advanced/security.mdx`

21. [ ] Search for `authContextProvider` references and remove/replace with `namespaceProvider`

### DOC-011: `concepts/schema.mdx`

22. [ ] Search for `multiTenant` references and replace with `namespaced`

### Cross-check

23. [ ] `grep -ri "authContextProvider\|authContext\|multiTenant\|createForUser\|currentContext" datafn/docs/content/` returns no results (except possibly this spec's path in `.conduct/`)

## Verification Steps

Manual review of all modified doc files. Verify:

1. No references to removed APIs in any doc file.
2. All code examples compile against the updated types (mental verification).
3. Doc site builds successfully:
   ```bash
   cd datafn/docs && npm run build
   ```

## Stop Condition

- Zero references to `authContextProvider`, `authContext` (as config option), `multiTenant`, `createForUser`, `currentContext()`, `userId` (as changelog field) in any documentation file.
- All documentation accurately reflects the current API surface.

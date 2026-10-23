# REQUIREMENTS

## Table of Contents

| ID | Priority | Summary |
|---|---|---|
| REM-001 | P0 | Remove `multiTenant` from `DatafnSchema` type |
| REM-002 | P0 | Remove `multiTenant` from `defineSchema()` generic constraint |
| REM-003 | P0 | Remove `multiTenant` handling from schema validation |
| REM-004 | P0 | Remove `multiTenant` from `isNamespaced()` / `resolveNamespaced()` |
| REM-005 | P0 | Remove `authContextProvider` from `DatafnServerConfig` |
| REM-006 | P0 | Remove legacy bridge from `extractNamespace` |
| REM-007 | P0 | Remove legacy bridge from `extractActorId` |
| REM-008 | P0 | Remove legacy bridge from rate limit key extractor |
| REM-009 | P0 | Remove `authContextProvider` deprecation warning |
| REM-010 | P0 | Remove `@superfunctions/auth` import from server |
| REM-011 | P0 | Remove `authContext` from `DatafnClientConfig` |
| REM-012 | P0 | Remove legacy `authContext` resolution from `_buildRawClient` |
| REM-013 | P0 | Remove `currentContext()` from `DatafnClient` |
| REM-014 | P0 | Remove `authContext` from `SwitchContextOverride` |
| REM-015 | P0 | Simplify `DatafnStorageFactory` to `(namespace: string)` only |
| REM-016 | P0 | Remove `userId` from `DatafnChangelogEntry` |
| REM-017 | P0 | Remove `createForUser()` from `IndexedDbStorageAdapter` |
| REM-018 | P0 | Remove `AuthContext`/`AuthContextProvider` re-exports from client index |
| REM-019 | P0 | Remove `@superfunctions/auth` import from client |
| REM-020 | P0 | Remove `authContext` deprecation warning from client |
| REM-021 | P0 | Rename `isMultiTenant` to `isNamespaced` in CLI drizzle codegen |
| REM-022 | P0 | Update CLI codegen comments from "multiTenant" to "namespaced" |
| REM-023 | P0 | Remove `multiTenant` output from `validateSchema` normalized result |
| TST-001 | P0 | Delete or rewrite `multi-tenant.test.ts` to use only namespace API |
| TST-002 | P0 | Update `namespace.test.ts` — remove legacy authContext test vectors |
| TST-003 | P0 | Update `namespace-provider.test.ts` — remove authContextProvider tests |
| TST-004 | P0 | Update `schema.test.ts` — remove multiTenant tests |
| TST-005 | P0 | Update `drizzle-codegen.test.ts` — rename multiTenant refs |
| TST-006 | P0 | Update `indexeddb-namespace.test.ts` — remove createForUser tests if any |
| DOC-001 | P0 | Update multi-tenancy/namespace doc — remove migration section and all legacy API references |
| DOC-002 | P0 | Update client setup doc — remove authContext references |
| DOC-003 | P0 | Update server setup doc — remove authContextProvider references |
| DOC-004 | P0 | Update client config reference — remove authContext, simplify DatafnStorageFactory |
| DOC-005 | P0 | Update server config reference — remove authContextProvider |
| DOC-006 | P0 | Update storage reference — remove AuthContext union from DatafnStorageFactory, remove userId from changelog |
| DOC-007 | P0 | Update core types reference — remove multiTenant from DatafnSchema |
| DOC-008 | P0 | Update IndexedDB doc — remove createForUser references |
| DOC-009 | P0 | Update storage overview doc — remove legacy factory pattern references |
| DOC-010 | P0 | Update security doc — remove legacy auth references if any |
| DOC-011 | P0 | Update schema concept doc — remove multiTenant references |
| SVL-001 | P0 | Create `@datafn/svelte` docs page — framework adapters overview |
| SVL-002 | P0 | Add Svelte usage examples to client signals doc |
| SVL-003 | P0 | Add `@datafn/svelte` to client setup doc — framework integration section |
| SVL-004 | P0 | Create `@datafn/svelte` API reference page |
| SVL-005 | P0 | Document framework adapter ecosystem pattern (future React, Vue, etc.) |
| SVL-006 | P0 | Add Svelte store examples to relevant docs (queries, mutations, events) |
| RST-001 | P0 | Move resources, fields, relations, system-fields from concepts to DFQL sidebar |
| RST-002 | P0 | Create concepts overview page replacing schema page |
| RST-003 | P0 | Add DFQL schema page under dfql/ section |
| LNK-001 | P0 | Add cross-links from client/queries.mdx to DFQL filter, sort, select, pagination pages |
| LNK-002 | P0 | Add cross-links from client/mutations.mdx to DFQL mutations page |
| LNK-003 | P0 | Add cross-links from client/transactions.mdx to DFQL transactions page |
| LNK-004 | P0 | Add cross-links from client/signals.mdx to DFQL queries/select pages |
| DIA-001 | P0 | Create mermaid system architecture diagram |
| DIA-002 | P0 | Add diagram to docs home page (index.mdx) |
| DIA-003 | P0 | Add diagram to concepts overview page |
| PY-001 | P0 | Merge python/setup.mdx into server/setup.mdx using tabbed code blocks |
| PY-002 | P0 | Merge python/server.mdx into server/routes.mdx and server/setup.mdx using tabs |
| PY-003 | P0 | Merge python/database.mdx into database/adapters.mdx using tabs |
| PY-004 | P0 | Merge python/handlers.mdx into server/authorization.mdx or server/routes.mdx using tabs |
| PY-005 | P0 | Remove python/ sidebar section from top-level meta.json |

---

## REM-001: Remove `multiTenant` from `DatafnSchema` type

- **Priority**: P0
- **Statement**: The `multiTenant` field MUST be removed from the `DatafnSchema` type definition in `@datafn/core`.
- **Rationale**: No external users exist. The deprecated field adds confusion and dead code.
- **Acceptance criteria**:
  - `DatafnSchema` type in `datafn/core/src/types.ts` does NOT contain `multiTenant`.
  - No `@deprecated` JSDoc for a removed field.
  - TypeScript compilation succeeds across all packages.
- **Test vectors**: TV-REM-001
- **Notes**: All downstream code referencing `schema.multiTenant` must be updated or deleted.

---

## REM-002: Remove `multiTenant` from `defineSchema()` generic constraint

- **Priority**: P0
- **Statement**: The `defineSchema()` function's generic constraint MUST NOT accept `multiTenant`.
- **Rationale**: Aligns type-safe helper with the simplified schema type.
- **Acceptance criteria**:
  - `defineSchema({ resources: [...], multiTenant: true })` MUST produce a TypeScript error.
  - `defineSchema({ resources: [...], namespaced: true })` compiles successfully.
- **Test vectors**: TV-REM-002
- **Notes**: None.

---

## REM-003: Remove `multiTenant` handling from schema validation

- **Priority**: P0
- **Statement**: `validateSchema()` MUST NOT check for or handle the `multiTenant` field. The `_multiTenantDeprecationWarned` flag and its deprecation warning MUST be removed.
- **Rationale**: Dead code removal.
- **Acceptance criteria**:
  - No reference to `multiTenant` in `datafn/core/src/schema.ts`.
  - No `_multiTenantDeprecationWarned` variable.
  - No `console.warn` for multiTenant deprecation.
  - Validated schema output does NOT include `multiTenant` key.
- **Test vectors**: TV-REM-003
- **Notes**: None.

---

## REM-004: Remove `multiTenant` from `isNamespaced()` / `resolveNamespaced()`

- **Priority**: P0
- **Statement**: `isNamespaced()` and `resolveNamespaced()` MUST only check `schema.namespaced`, falling back to `true`.
- **Rationale**: Simplification — no dual-field resolution needed.
- **Acceptance criteria**:
  - `isNamespaced({ resources: [] })` returns `true` (default).
  - `isNamespaced({ resources: [], namespaced: false })` returns `false`.
  - No reference to `multiTenant` in either function.
- **Test vectors**: TV-REM-004
- **Notes**: None.

---

## REM-005: Remove `authContextProvider` from `DatafnServerConfig`

- **Priority**: P0
- **Statement**: The `authContextProvider` field MUST be removed from `DatafnServerConfig`.
- **Rationale**: Legacy API with no users.
- **Acceptance criteria**:
  - `DatafnServerConfig` type does NOT include `authContextProvider`.
  - `createDatafnServer({ authContextProvider: ... })` produces a TypeScript error.
  - No `@deprecated` JSDoc for removed field.
- **Test vectors**: TV-REM-005
- **Notes**: None.

---

## REM-006: Remove legacy bridge from `extractNamespace`

- **Priority**: P0
- **Statement**: The `extractNamespace` internal function MUST NOT contain any `authContextProvider` branch.
- **Rationale**: The bridge is dead code after REM-005.
- **Acceptance criteria**:
  - `extractNamespace` has exactly two paths: (1) `namespaceProvider` configured → use it, (2) default → `"datafn"`.
  - No reference to `authContextProvider` or `authContext` in the function.
  - No `tenant:` / `user:` format construction.
- **Test vectors**: TV-REM-006
- **Notes**: None.

---

## REM-007: Remove legacy bridge from `extractActorId`

- **Priority**: P0
- **Statement**: The `extractActorId` function MUST NOT reference `authContextProvider`.
- **Rationale**: Dead code after REM-005.
- **Acceptance criteria**:
  - `extractActorId` has exactly two paths: (1) `namespaceProvider.getActorId` configured → use it, (2) `undefined`.
  - No `authContextProvider` branch.
- **Test vectors**: TV-REM-007
- **Notes**: None.

---

## REM-008: Remove legacy bridge from rate limit key extractor

- **Priority**: P0
- **Statement**: The default rate limit key extractor MUST NOT reference `authContextProvider`.
- **Rationale**: Dead code after REM-005.
- **Acceptance criteria**:
  - Default key extractor: (1) try `namespaceProvider.getNamespace(ctx)`, (2) fall back to `"anonymous"`.
  - No `authContextProvider` branch.
- **Test vectors**: TV-REM-008
- **Notes**: None.

---

## REM-009: Remove `authContextProvider` deprecation warning

- **Priority**: P0
- **Statement**: The startup deprecation warning for `authContextProvider` MUST be removed.
- **Rationale**: Field no longer exists.
- **Acceptance criteria**:
  - No `logger.warn` mentioning "authContextProvider is deprecated" in server.ts.
  - No conditional check for `config.authContextProvider`.
- **Test vectors**: N/A (absence check)
- **Notes**: None.

---

## REM-010: Remove `@superfunctions/auth` import from server

- **Priority**: P0
- **Statement**: `datafn/server/src/server.ts` MUST NOT import from `@superfunctions/auth`.
- **Rationale**: `AuthContext` / `AuthContextProvider` types are no longer used.
- **Acceptance criteria**:
  - No `import ... from "@superfunctions/auth"` in server.ts.
  - TypeScript compilation succeeds.
- **Test vectors**: N/A (build verification)
- **Notes**: `@superfunctions/auth` may still be used elsewhere in the monorepo. Only the datafn server import is removed.

---

## REM-011: Remove `authContext` from `DatafnClientConfig`

- **Priority**: P0
- **Statement**: The `authContext` field MUST be removed from `DatafnClientConfig`.
- **Rationale**: Legacy API with no users.
- **Acceptance criteria**:
  - `DatafnClientConfig` type does NOT include `authContext`.
  - `createDatafnClient({ authContext: ... })` produces a TypeScript error.
- **Test vectors**: TV-REM-009
- **Notes**: None.

---

## REM-012: Remove legacy `authContext` resolution from `_buildRawClient`

- **Priority**: P0
- **Statement**: The `_buildRawClient` function MUST NOT contain any `authContext` resolution logic, `AuthContextProvider` handling, or namespace derivation from auth context.
- **Rationale**: Dead code after REM-011.
- **Acceptance criteria**:
  - No `resolvedAuthContext` variable.
  - No `config.authContext` references.
  - No `"getContext" in config.authContext` checks.
  - No `authContext.tenantId` / `authContext.userId` namespace derivation.
  - Storage factory resolution: when `storage` is a function → requires `config.namespace` → calls `storage(config.namespace)`.
  - When `storage` is a function and `namespace` is missing → throws `DFQL_INVALID`.
- **Test vectors**: TV-REM-010
- **Notes**: The `resolvedNamespace` variable is still needed for namespace-based operations.

---

## REM-013: Remove `currentContext()` from `DatafnClient`

- **Priority**: P0
- **Statement**: The `currentContext()` method MUST be removed from the `DatafnClient` type and implementation.
- **Rationale**: Replaced by `currentNamespace()`.
- **Acceptance criteria**:
  - `DatafnClient` type does NOT include `currentContext()`.
  - No `currentContext` in the proxy implementation.
- **Test vectors**: TV-REM-011
- **Notes**: None.

---

## REM-014: Remove `authContext` from `SwitchContextOverride`

- **Priority**: P0
- **Statement**: The `authContext` field MUST be removed from `SwitchContextOverride`.
- **Rationale**: Legacy API with no users.
- **Acceptance criteria**:
  - `SwitchContextOverride` type does NOT include `authContext`.
  - `client.switchContext({ authContext: ... })` produces a TypeScript error.
- **Test vectors**: TV-REM-012
- **Notes**: None.

---

## REM-015: Simplify `DatafnStorageFactory` to `(namespace: string)` only

- **Priority**: P0
- **Statement**: `DatafnStorageFactory` MUST be typed as `(namespace: string) => DatafnStorageAdapter` — no union with `AuthContext`.
- **Rationale**: The `AuthContext` parameter path is dead after REM-012.
- **Acceptance criteria**:
  - Type definition: `(namespace: string) => DatafnStorageAdapter`.
  - No `import type { AuthContext }` in `storage.ts`.
  - No `namespaceOrContext` union parameter.
  - JSDoc example uses namespace string.
- **Test vectors**: TV-REM-013
- **Notes**: None.

---

## REM-016: Remove `userId` from `DatafnChangelogEntry`

- **Priority**: P0
- **Statement**: The `userId` field MUST be removed from `DatafnChangelogEntry`.
- **Rationale**: Replaced by `actorId`. No users to maintain backward compat for.
- **Acceptance criteria**:
  - `DatafnChangelogEntry` does NOT include `userId`.
  - No `@deprecated` tag for a removed field.
  - All code that reads/writes `userId` on changelog entries is removed.
- **Test vectors**: TV-REM-014
- **Notes**: None.

---

## REM-017: Remove `createForUser()` from `IndexedDbStorageAdapter`

- **Priority**: P0
- **Statement**: The `createForUser` static method MUST be removed from `IndexedDbStorageAdapter`.
- **Rationale**: Replaced by `createForNamespace`. No users.
- **Acceptance criteria**:
  - No `createForUser` method on `IndexedDbStorageAdapter`.
  - All references to `createForUser` in tests and docs are removed.
- **Test vectors**: TV-REM-015
- **Notes**: None.

---

## REM-018: Remove `AuthContext`/`AuthContextProvider` re-exports from client index

- **Priority**: P0
- **Statement**: `@datafn/client` MUST NOT re-export `AuthContext` or `AuthContextProvider` from `@superfunctions/auth`.
- **Rationale**: These types are no longer part of datafn's API surface.
- **Acceptance criteria**:
  - No `export type { AuthContext, AuthContextProvider }` in `datafn/client/src/index.ts`.
- **Test vectors**: N/A (build verification)
- **Notes**: None.

---

## REM-019: Remove `@superfunctions/auth` import from client

- **Priority**: P0
- **Statement**: No file in `datafn/client/src/` MUST import from `@superfunctions/auth`.
- **Rationale**: Clean dependency separation.
- **Acceptance criteria**:
  - `grep -r "@superfunctions/auth" datafn/client/src/` returns no results.
  - TypeScript compilation succeeds.
- **Test vectors**: N/A (build verification)
- **Notes**: None.

---

## REM-020: Remove `authContext` deprecation warning from client

- **Priority**: P0
- **Statement**: The `console.warn` for `authContext` deprecation in `_buildRawClient` MUST be removed.
- **Rationale**: The field no longer exists.
- **Acceptance criteria**:
  - No `console.warn` mentioning "authContext is deprecated" in client.ts.
- **Test vectors**: N/A (absence check)
- **Notes**: None.

---

## REM-021: Rename `isMultiTenant` to `isNamespaced` in CLI drizzle codegen

- **Priority**: P0
- **Statement**: The local variable `isMultiTenant` in the CLI drizzle codegen MUST be renamed to `isNamespaced`.
- **Rationale**: Consistency with renamed API.
- **Acceptance criteria**:
  - Variable named `isNamespaced` (already calls `isNamespaced()` from core).
  - All usages of the variable within the file updated.
- **Test vectors**: TV-REM-016
- **Notes**: Behavior unchanged — only variable name.

---

## REM-022: Update CLI codegen comments from "multiTenant" to "namespaced"

- **Priority**: P0
- **Statement**: All comments in `drizzle-codegen.ts` referencing "multiTenant" or "multi-tenant" MUST be updated to use "namespaced".
- **Rationale**: Consistency.
- **Acceptance criteria**:
  - `grep -i "multi.tenant" datafn/cli/src/drizzle-codegen.ts` returns no results.
- **Test vectors**: N/A (text check)
- **Notes**: None.

---

## REM-023: Remove `multiTenant` output from `validateSchema` normalized result

- **Priority**: P0
- **Statement**: The normalized schema object returned by `validateSchema()` MUST NOT include a `multiTenant` key.
- **Rationale**: The field is removed from the type.
- **Acceptance criteria**:
  - The `ok()` return value in `validateSchema` includes `namespaced` but NOT `multiTenant`.
  - `// Preserve multiTenant for backward compatibility` comment is removed.
- **Test vectors**: TV-REM-017
- **Notes**: None.

---

## TST-001: Delete or rewrite `multi-tenant.test.ts`

- **Priority**: P0
- **Statement**: The legacy `multi-tenant.test.ts` test file MUST be deleted or completely rewritten to use only the namespace API.
- **Rationale**: Tests verify dead APIs.
- **Acceptance criteria**:
  - File is deleted (preferred, since `namespace.test.ts` covers the new API).
  - OR file is rewritten with no `authContext`, `AuthContextProvider`, `createForUser` references.
  - All tests pass.
- **Test vectors**: N/A
- **Notes**: `namespace.test.ts` and `indexeddb-namespace.test.ts` cover the current API.

---

## TST-002: Update `namespace.test.ts`

- **Priority**: P0
- **Statement**: `namespace.test.ts` MUST be updated to remove any test cases that verify legacy `authContext` behavior.
- **Rationale**: Those code paths no longer exist.
- **Acceptance criteria**:
  - No references to `authContext` in test code.
  - No "legacy factory receives AuthContext" test cases.
  - No "derives namespace from authContext" test cases.
  - Tests for `namespace` and `currentNamespace()` remain and pass.
- **Test vectors**: N/A
- **Notes**: None.

---

## TST-003: Update `namespace-provider.test.ts`

- **Priority**: P0
- **Statement**: Server `namespace-provider.test.ts` MUST be updated to remove all `authContextProvider` test cases.
- **Rationale**: Those code paths no longer exist.
- **Acceptance criteria**:
  - No references to `authContextProvider` in test code.
  - No "legacy bridge" test cases.
  - Tests for `namespaceProvider` remain and pass.
- **Test vectors**: N/A
- **Notes**: None.

---

## TST-004: Update `schema.test.ts`

- **Priority**: P0
- **Statement**: `schema.test.ts` MUST be updated to remove `multiTenant` test cases.
- **Rationale**: Field no longer exists.
- **Acceptance criteria**:
  - No references to `multiTenant` in test code.
  - Tests for `namespaced` remain and pass.
- **Test vectors**: N/A
- **Notes**: None.

---

## TST-005: Update `drizzle-codegen.test.ts`

- **Priority**: P0
- **Statement**: `drizzle-codegen.test.ts` MUST rename `multiTenant` references to `namespaced`.
- **Rationale**: Consistency with renamed API.
- **Acceptance criteria**:
  - Test schemas use `namespaced` instead of `multiTenant`.
  - Test names updated if they reference "multi-tenant".
  - All tests pass.
- **Test vectors**: N/A
- **Notes**: None.

---

## TST-006: Update `indexeddb-namespace.test.ts`

- **Priority**: P0
- **Statement**: If `indexeddb-namespace.test.ts` contains `createForUser` tests, they MUST be removed.
- **Rationale**: Method deleted.
- **Acceptance criteria**:
  - No `createForUser` references in test code.
  - Tests for `createForNamespace` remain and pass.
- **Test vectors**: N/A
- **Notes**: None.

---

## DOC-001: Update namespace/multi-tenancy doc

- **Priority**: P0
- **Statement**: `datafn/docs/content/docs/documentation/concepts/multi-tenancy.mdx` MUST be updated to remove all references to deprecated APIs and the entire "Migration from multiTenant / authContextProvider" section.
- **Rationale**: No migration needed — old APIs don't exist.
- **Acceptance criteria**:
  - No references to `authContextProvider`, `authContext`, `multiTenant`, `createForUser`, `currentContext()`.
  - Migration section (lines ~345-410) deleted entirely.
  - Legacy bridge references in "Namespace Resolution Order" and "Actor ID Resolution" removed (only 2 steps remain for each).
  - All code examples use only `namespaceProvider`, `namespace`, `namespaced`.
- **Test vectors**: N/A
- **Notes**: None.

---

## DOC-002: Update client setup doc

- **Priority**: P0
- **Statement**: `datafn/docs/content/docs/documentation/client/setup.mdx` MUST NOT reference `authContext` or deprecated APIs.
- **Rationale**: Clean docs.
- **Acceptance criteria**:
  - No mention of `authContext` in text or code examples.
  - Storage factory docs use `(namespace: string) =>` signature.
- **Test vectors**: N/A
- **Notes**: None.

---

## DOC-003: Update server setup doc

- **Priority**: P0
- **Statement**: `datafn/docs/content/docs/documentation/server/setup.mdx` MUST NOT reference `authContextProvider`.
- **Rationale**: Clean docs.
- **Acceptance criteria**:
  - No mention of `authContextProvider` in text or tables or code examples.
  - `namespaceProvider` is the only namespace mechanism documented.
- **Test vectors**: N/A
- **Notes**: None.

---

## DOC-004: Update client config reference

- **Priority**: P0
- **Statement**: `datafn/docs/content/docs/reference/client/config.mdx` MUST remove `authContext` from `DatafnClientConfig` and simplify `DatafnStorageFactory`.
- **Rationale**: Reflects actual types.
- **Acceptance criteria**:
  - `DatafnClientConfig` listing does NOT include `authContext`.
  - `DatafnStorageFactory` is `(namespace: string) => DatafnStorageAdapter` — no `AuthContext` union.
  - Explanatory text does not mention "deprecated authContext".
- **Test vectors**: N/A
- **Notes**: None.

---

## DOC-005: Update server config reference

- **Priority**: P0
- **Statement**: `datafn/docs/content/docs/reference/server/config.mdx` MUST remove `authContextProvider` from `DatafnServerConfig`.
- **Rationale**: Reflects actual types.
- **Acceptance criteria**:
  - `DatafnServerConfig` listing does NOT include `authContextProvider`.
  - No `@deprecated` annotation for removed field.
- **Test vectors**: N/A
- **Notes**: None.

---

## DOC-006: Update storage reference

- **Priority**: P0
- **Statement**: `datafn/docs/content/docs/reference/client/storage.mdx` MUST remove `AuthContext` union from `DatafnStorageFactory` and `userId` from `DatafnChangelogEntry`.
- **Rationale**: Reflects actual types.
- **Acceptance criteria**:
  - `DatafnStorageFactory` is `(namespace: string) => DatafnStorageAdapter`.
  - `DatafnChangelogEntry` does NOT include `userId`.
  - No mention of "deprecated authContext" in explanatory text.
- **Test vectors**: N/A
- **Notes**: None.

---

## DOC-007: Update core types reference

- **Priority**: P0
- **Statement**: `datafn/docs/content/docs/reference/core/types.mdx` MUST remove `multiTenant` from `DatafnSchema`.
- **Rationale**: Reflects actual types.
- **Acceptance criteria**:
  - `DatafnSchema` listing does NOT include `multiTenant`.
  - No `@deprecated` annotation for removed field.
- **Test vectors**: N/A
- **Notes**: None.

---

## DOC-008: Update IndexedDB doc

- **Priority**: P0
- **Statement**: `datafn/docs/content/docs/documentation/storage/indexeddb.mdx` MUST NOT reference `createForUser`.
- **Rationale**: Method deleted.
- **Acceptance criteria**:
  - No `createForUser` in text or code examples.
  - `createForNamespace` remains as the documented API.
- **Test vectors**: N/A
- **Notes**: None.

---

## DOC-009: Update storage overview doc

- **Priority**: P0
- **Statement**: `datafn/docs/content/docs/documentation/storage/overview.mdx` MUST NOT reference legacy factory patterns.
- **Rationale**: Clean docs.
- **Acceptance criteria**:
  - Storage factory docs use `(namespace: string) =>` signature only.
  - No `AuthContext` mention.
- **Test vectors**: N/A
- **Notes**: None.

---

## DOC-010: Update security doc

- **Priority**: P0
- **Statement**: `datafn/docs/content/docs/documentation/advanced/security.mdx` MUST NOT reference `authContextProvider` or legacy auth patterns.
- **Rationale**: Clean docs.
- **Acceptance criteria**:
  - All security docs reference `namespaceProvider` only.
- **Test vectors**: N/A
- **Notes**: None.

---

## DOC-011: Update schema concept doc

- **Priority**: P0
- **Statement**: `datafn/docs/content/docs/documentation/concepts/schema.mdx` MUST NOT reference `multiTenant`.
- **Rationale**: Clean docs.
- **Acceptance criteria**:
  - No `multiTenant` in text or code examples.
  - Uses `namespaced` exclusively.
- **Test vectors**: N/A
- **Notes**: None.

---

## SVL-001: Create `@datafn/svelte` framework adapters doc page

- **Priority**: P0
- **Statement**: A new documentation page MUST be created for the `@datafn/svelte` package, covering the framework adapter concept, installation, and usage.
- **Rationale**: The Svelte package exists but has no docs page.
- **Acceptance criteria**:
  - New file at `datafn/docs/content/docs/documentation/client/frameworks.mdx` (or similar path).
  - Covers: what framework adapters are, why they exist, the `@datafn/svelte` package.
  - Installation instructions (`npm install @datafn/svelte`).
  - Usage example: `toSvelteStore(signal)`.
  - Explains that signals from `createDatafnClient` are lifecycle-aware (no factory pattern needed).
  - Mentions the deprecated factory overload briefly (for existing code) but recommends direct signal form.
  - Section on upcoming framework packages (React, Vue, Angular, Solid) with example pseudocode.
  - Explains the common pattern: each adapter converts `DatafnSignal<T>` to the framework's reactive primitive.
- **Test vectors**: N/A
- **Notes**: None.

---

## SVL-002: Add Svelte usage examples to signals doc

- **Priority**: P0
- **Statement**: `datafn/docs/content/docs/documentation/client/signals.mdx` MUST include a section showing how to use signals with `@datafn/svelte`.
- **Rationale**: Signals docs should show framework integration.
- **Acceptance criteria**:
  - New "Framework Integration" or "Svelte" section in signals.mdx.
  - Code example: `import { toSvelteStore } from "@datafn/svelte"` + `toSvelteStore(signal)`.
  - Shows template usage: `{#each $store.data as item}`.
  - Links to the full framework adapters doc (SVL-001).
- **Test vectors**: N/A
- **Notes**: None.

---

## SVL-003: Add `@datafn/svelte` to client setup doc

- **Priority**: P0
- **Statement**: `datafn/docs/content/docs/documentation/client/setup.mdx` MUST mention `@datafn/svelte` in context of framework integration.
- **Rationale**: Client setup is the first doc users read; it should point to framework adapters.
- **Acceptance criteria**:
  - Brief mention of `@datafn/svelte` for Svelte apps.
  - Link to framework adapters doc (SVL-001).
  - Brief note that React, Vue, etc. packages are planned.
- **Test vectors**: N/A
- **Notes**: Keep it brief — detailed docs are in the framework adapters page.

---

## SVL-004: Create `@datafn/svelte` API reference page

- **Priority**: P0
- **Statement**: A reference page MUST be created documenting the `@datafn/svelte` public API.
- **Rationale**: Reference docs should cover all packages.
- **Acceptance criteria**:
  - New file at `datafn/docs/content/docs/reference/client/svelte.mdx` (or `reference/svelte.mdx`).
  - Documents `toSvelteStore<T>(signal): DatafnSvelteStore<T>` (primary overload).
  - Documents `DatafnSvelteStore<T>` type (`Readable<{ data, loading, error, refreshing, nextCursor }>`).
  - Documents deprecated factory overload with `ClientRef`.
  - Lists peer dependencies (svelte ^3.0.0 || ^4.0.0).
- **Test vectors**: N/A
- **Notes**: None.

---

## SVL-005: Document framework adapter ecosystem pattern

- **Priority**: P0
- **Statement**: The framework adapters doc (SVL-001) MUST include a section explaining the framework adapter ecosystem and the pattern for future packages.
- **Rationale**: Users should understand the architectural vision.
- **Acceptance criteria**:
  - Explains that `DatafnSignal<T>` is the framework-agnostic core primitive.
  - Explains that each framework adapter package is a thin wrapper converting signals to framework-native reactivity.
  - Lists planned packages: `@datafn/react`, `@datafn/vue`, `@datafn/solid`, `@datafn/angular`.
  - Shows pseudocode for what a React hook and Vue composable would look like.
  - Notes that community can create adapters for other frameworks using the same pattern.
- **Test vectors**: N/A
- **Notes**: None.

---

## SVL-006: Add Svelte examples to relevant docs

- **Priority**: P0
- **Statement**: Where framework-specific code examples appear in documentation (queries, mutations, events), a Svelte example SHOULD be included alongside or referenced.
- **Rationale**: Shows real-world usage.
- **Acceptance criteria**:
  - At minimum: signals doc (SVL-002), client setup (SVL-003).
  - Additional places (queries.mdx, events.mdx) MAY include Svelte snippets if they enhance understanding.
  - All Svelte examples use the direct `toSvelteStore(signal)` form, not the factory.
- **Test vectors**: N/A
- **Notes**: Keep Svelte examples concise. Don't add to every page — focus on high-traffic pages.

---

## RST-001: Move schema sub-topics from Concepts to DFQL sidebar

- **Priority**: P0
- **Statement**: The pages `resources.mdx`, `fields.mdx`, `relations.mdx`, and `system-fields.mdx` MUST be moved from `documentation/concepts/` to `dfql/` and referenced in `dfql/meta.json`.
- **Rationale**: These pages describe DFQL constructs (resource/field/relation definitions) and belong under the DFQL section for better discoverability.
- **Acceptance criteria**:
  - Files physically moved from `documentation/concepts/` to `dfql/` (or sidebar meta updated to reference them from DFQL).
  - `dfql/meta.json` includes `"schema"`, `"resources"`, `"fields"`, `"relations"`, `"system-fields"` in its pages array (after `"index"`, before `"queries"`).
  - `documentation/concepts/meta.json` no longer lists `"resources"`, `"fields"`, `"relations"`, `"system-fields"`, `"schema"`.
  - All internal doc links to these pages are updated if paths changed.
- **Test vectors**: N/A
- **Notes**: If `dfql/relations.mdx` already exists with different content, merge or differentiate (one for schema definition, one for querying with relations).

---

## RST-002: Create concepts overview page

- **Priority**: P0
- **Statement**: A new `documentation/concepts/overview.mdx` page MUST be created that provides a high-level introduction to all core DataFn concepts, replacing the removed `schema.mdx` as the first page in Concepts.
- **Rationale**: Users need a landing page that orients them in the DataFn ecosystem before diving into specific topics.
- **Acceptance criteria**:
  - File created at `datafn/docs/content/docs/documentation/concepts/overview.mdx`.
  - Covers at high level: what is DataFn, what is the client, what is the server, what is DFQL (schema, queries, mutations, transactions), what are framework libraries, what is sync.
  - Includes the system architecture mermaid diagram (DIA-003).
  - Links to deeper docs for each concept area.
  - `concepts/meta.json` lists `"overview"` as first page.
- **Test vectors**: N/A
- **Notes**: Keep concise — this is an orientation page, not a deep-dive.

---

## RST-003: Add DFQL schema page under dfql/ section

- **Priority**: P0
- **Statement**: A `dfql/schema.mdx` page MUST be created (or the existing `concepts/schema.mdx` moved and adapted) covering schema definition as a DFQL concept.
- **Rationale**: Schema defines the data model that DFQL operates on and logically belongs in the DFQL section.
- **Acceptance criteria**:
  - File at `datafn/docs/content/docs/dfql/schema.mdx`.
  - Covers `DatafnSchema`, `defineSchema()`, `DatafnResourceSchema`, `DatafnRelationSchema`, `namespaced`.
  - Referenced in `dfql/meta.json`.
- **Test vectors**: N/A
- **Notes**: May be a move+rename of `concepts/schema.mdx` with minor edits to fit DFQL context.

---

## LNK-001: Add cross-links from client/queries.mdx to DFQL pages

- **Priority**: P0
- **Statement**: `documentation/client/queries.mdx` MUST include contextual links to the relevant DFQL reference pages wherever it mentions filters, sorting, pagination, select, aggregations, or search.
- **Rationale**: Users reading client query docs should be able to quickly navigate to the full DFQL reference for each feature.
- **Acceptance criteria**:
  - Link to `/docs/dfql/filters` near the Filters section.
  - Link to `/docs/dfql/sorting` near the Sorting section.
  - Link to `/docs/dfql/pagination` near the Pagination section.
  - Link to `/docs/dfql/select` near any Select/projection section.
  - Link to `/docs/dfql/aggregations` near any Aggregations section.
  - Link to `/docs/dfql/search` near any Search section.
  - Links are contextual (e.g., "See the full [DFQL Filters reference](/docs/dfql/filters) for all operators.").
- **Test vectors**: N/A
- **Notes**: Don't overload with links — one per section is sufficient.

---

## LNK-002: Add cross-links from client/mutations.mdx to DFQL mutations page

- **Priority**: P0
- **Statement**: `documentation/client/mutations.mdx` MUST include a link to `/docs/dfql/mutations` for the full DFQL mutations reference.
- **Rationale**: Client mutation docs should point to the complete DFQL mutation specification.
- **Acceptance criteria**:
  - At least one contextual link to `/docs/dfql/mutations`.
- **Test vectors**: N/A
- **Notes**: None.

---

## LNK-003: Add cross-links from client/transactions.mdx to DFQL transactions page

- **Priority**: P0
- **Statement**: `documentation/client/transactions.mdx` MUST include a link to `/docs/dfql/transactions`.
- **Rationale**: Client transaction docs should point to the complete DFQL transaction specification.
- **Acceptance criteria**:
  - At least one contextual link to `/docs/dfql/transactions`.
- **Test vectors**: N/A
- **Notes**: None.

---

## LNK-004: Add cross-links from client/signals.mdx to DFQL pages

- **Priority**: P0
- **Statement**: `documentation/client/signals.mdx` MUST include links to relevant DFQL pages (queries, select) where signal query options are discussed.
- **Rationale**: Signals accept query parameters; users should be able to navigate to full DFQL docs.
- **Acceptance criteria**:
  - At least one link to `/docs/dfql/queries` or `/docs/dfql/select` where signal query options are described.
- **Test vectors**: N/A
- **Notes**: None.

---

## DIA-001: Create mermaid system architecture diagram

- **Priority**: P0
- **Statement**: A mermaid diagram MUST be created that visually represents the entire DataFn system architecture.
- **Rationale**: A visual diagram helps users understand how all DataFn components relate to each other.
- **Acceptance criteria**:
  - Diagram shows: Client (DatafnClient, Signals, Storage, Framework Adapters), Server (DatafnServer, Routes, Authorization, Sync Engine), DFQL (protocol layer), Database (adapters), Sync flow (clone/pull/push).
  - Rendered as a mermaid code block in MDX.
  - Clear and readable at standard page widths.
- **Test vectors**: N/A
- **Notes**: Use `graph TD` or `flowchart TD` for top-down layout.

---

## DIA-002: Add diagram to docs home page

- **Priority**: P0
- **Statement**: The system architecture diagram (DIA-001) MUST be added to `datafn/docs/content/docs/index.mdx`.
- **Rationale**: The home page should immediately orient users to the system's architecture.
- **Acceptance criteria**:
  - `index.mdx` includes the mermaid diagram.
  - Brief introductory text before the diagram explains what it shows.
- **Test vectors**: N/A
- **Notes**: None.

---

## DIA-003: Add diagram to concepts overview page

- **Priority**: P0
- **Statement**: The system architecture diagram (DIA-001) MUST be added to `documentation/concepts/overview.mdx` (RST-002).
- **Rationale**: The concepts overview page should visually orient users before they dive into specific topics.
- **Acceptance criteria**:
  - `overview.mdx` includes the mermaid diagram.
- **Test vectors**: N/A
- **Notes**: None.

---

## PY-001: Merge python/setup.mdx into server/setup.mdx

- **Priority**: P0
- **Statement**: The Python server setup content from `python/setup.mdx` MUST be integrated into `documentation/server/setup.mdx` using Fumadocs `<Tabs>` component for TypeScript vs Python examples.
- **Rationale**: Consolidates server setup docs into one place, reducing sidebar clutter and making Python discoverable alongside TypeScript.
- **Acceptance criteria**:
  - `documentation/server/setup.mdx` uses `<Tabs items={["TypeScript", "Python"]}>` for code blocks.
  - Python installation, configuration, and basic setup examples are included.
  - Content is accurate and equivalent to the original `python/setup.mdx`.
- **Test vectors**: N/A
- **Notes**: Import `{ Tab, Tabs }` from `"fumadocs-ui/components/tabs"`.

---

## PY-002: Merge python/server.mdx into server docs

- **Priority**: P0
- **Statement**: The Python server creation and routes content from `python/server.mdx` MUST be integrated into `documentation/server/routes.mdx` and/or `documentation/server/setup.mdx` using tabbed code blocks.
- **Rationale**: Server routes docs should show both TypeScript and Python examples side by side.
- **Acceptance criteria**:
  - Python route handler examples (FastAPI, Starlette, Django) appear in tabbed blocks alongside TypeScript examples.
  - All Python framework integration examples are preserved.
- **Test vectors**: N/A
- **Notes**: May need sub-tabs for Python framework variants (FastAPI vs Starlette vs Django).

---

## PY-003: Merge python/database.mdx into database/adapters.mdx

- **Priority**: P0
- **Statement**: Python database adapter content from `python/database.mdx` MUST be integrated into `documentation/database/adapters.mdx` using tabbed code blocks.
- **Rationale**: Database adapter docs should cover both languages.
- **Acceptance criteria**:
  - Python database adapter setup examples appear in tabbed blocks.
  - SQLAlchemy and other Python-specific adapter details are preserved.
- **Test vectors**: N/A
- **Notes**: None.

---

## PY-004: Merge python/handlers.mdx into server docs

- **Priority**: P0
- **Statement**: Python handler/authorization content from `python/handlers.mdx` MUST be integrated into `documentation/server/authorization.mdx` or `documentation/server/routes.mdx` using tabbed code blocks.
- **Rationale**: Authorization and custom handler docs should show both languages.
- **Acceptance criteria**:
  - Python authorize callback examples appear alongside TypeScript equivalents.
- **Test vectors**: N/A
- **Notes**: None.

---

## PY-005: Remove Python sidebar section

- **Priority**: P0
- **Statement**: The `"python"` entry MUST be removed from the top-level `docs/meta.json` pages array. The `python/` directory MAY be kept for reference but MUST NOT appear in the sidebar.
- **Rationale**: Python content is now integrated into the main docs; a separate sidebar section creates confusion.
- **Acceptance criteria**:
  - `docs/meta.json` does NOT include `"python"` in pages.
  - No "Python" section appears in the docs sidebar.
  - All Python content is accessible via the main server/database docs with tabbed code blocks.
- **Test vectors**: N/A
- **Notes**: The `python/` directory files can be deleted or kept as source material. They MUST NOT be linked from the sidebar.

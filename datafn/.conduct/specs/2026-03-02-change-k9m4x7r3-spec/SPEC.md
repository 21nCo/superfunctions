# SPEC: Remove Legacy authContextProvider Backward Compatibility + Docs Overhaul (Svelte Package & Framework Ecosystem)

## Metadata

- **Timestamp**: 2026-03-02T12:00:00Z
- **Agent**: claude-opus-4-6
- **Model**: Claude Opus 4.6
- **Launcher**: VS Code (Claude Code Extension)
- **Workspace**: /Users/serro/Documents/dev/n/superfunctions
- **OS**: Darwin 25.3.0, zsh
- **Git branch**: `next`
- **Git commit**: 664f92c (dirty)
- **spec_folder**: `2026-03-02-change-k9m4x7r3-spec`
- **spec_type**: `change`
- **spec_id**: `k9m4x7r3`
- **Input paths**:
  - `datafn/.conduct/specs/2026-03-01-change-r7k4m9x3-spec/SPEC.md` (predecessor spec that introduced namespace with backward compat)
  - `datafn/.conduct/specs/2026-03-01-change-r7k4m9x3-spec/REQUIREMENTS.md`
  - `datafn/core/src/types.ts`, `datafn/core/src/schema.ts`, `datafn/core/src/index.ts`
  - `datafn/server/src/server.ts`
  - `datafn/client/src/client.ts`, `datafn/client/src/storage.ts`, `datafn/client/src/index.ts`
  - `datafn/client/src/adapters/indexedDbStorage.ts`
  - `datafn/svelte/src/toSvelteStore.ts`, `datafn/svelte/src/index.ts`, `datafn/svelte/package.json`
  - `datafn/cli/src/drizzle-codegen.ts`
  - All docs under `datafn/docs/content/docs/`
  - Conversation context (user intent)

---

## Overview

This spec covers three related changes to the datafn library:

**1. Remove legacy backward compatibility code.** The predecessor spec (`2026-03-01-change-r7k4m9x3-spec`) introduced the new `namespaceProvider` / `namespace` / `namespaced` / `ns()` system but preserved full backward compatibility with `authContextProvider` / `authContext` / `multiTenant` / `createForUser`. Since the library has no external users yet, all deprecated code, types, shims, deprecation warnings, and legacy bridge logic MUST be deleted entirely rather than preserved.

**2. Update all documentation** to remove all references to deprecated APIs (`authContextProvider`, `authContext`, `multiTenant`, `createForUser`, `AuthContext`, `AuthContextProvider`, `currentContext()`, `LegacyDatafnStorageFactory`, `userId` on changelog). Docs MUST present only the current `namespace` / `namespaceProvider` / `namespaced` APIs.

**3. Add `@datafn/svelte` documentation** to the docs site. Document the Svelte adapter package at relevant places (client setup, signals, reference). Introduce the concept of framework-specific adapter packages in the datafn ecosystem, using `@datafn/svelte` as the reference implementation and mentioning that other framework packages (React, Vue, Angular, Solid) will follow the same pattern.

**4. Restructure docs: Move schema sub-topics under DFQL.** Resources, fields, relations, and system-fields are DFQL concepts and MUST be nested under the DFQL sidebar section rather than under "Concepts". The "Concepts" section MUST instead contain an "Overview" page that provides a high-level introduction to all core concepts (client, server, DFQL, schema, query, mutations, framework libraries, etc.).

**5. Cross-link DFQL pages from main documentation.** Where the main documentation (e.g., client queries, client mutations, signals) references DFQL constructs like select, sort, filters, pagination, etc., it MUST provide links to the corresponding full DFQL reference pages so users can learn more.

**6. Create a visual system diagram.** A mermaid diagram (or similar) MUST be created showing the entire DataFn system architecture (client, server, DFQL, sync, storage, framework adapters). This diagram MUST be used on the home page (`docs/index.mdx`) and on the new concepts overview page.

**7. Merge Python SDK docs into main server docs.** Instead of a separate "Python" sidebar section, Python SDK details and code examples MUST be integrated into the main server documentation using tabbed code blocks (Fumadocs `<Tabs>` component). The separate Python sidebar section MUST be removed.

---

## Glossary

| Term | Definition |
|---|---|
| **legacy code** | All `authContextProvider`, `authContext`, `multiTenant`, `createForUser`, `currentContext()`, `userId` (on changelog), `LegacyDatafnStorageFactory` — everything deprecated by spec `r7k4m9x3`. |
| **namespace** | An opaque string that partitions data rows. Stored in the `__ns` column. |
| **namespaceProvider** | Server-side function `(ctx: TContext) => string \| Promise<string>` that extracts namespace from request context. |
| **ns()** | Helper in `@datafn/core` that joins segments with `:`. |
| **namespaced** | Schema boolean (default `true`) controlling row-level namespace isolation. |
| **framework adapter** | A thin package (e.g. `@datafn/svelte`) that converts `DatafnSignal<T>` into a framework-native reactive primitive (Svelte store, React hook, Vue composable, etc.). |
| **toSvelteStore** | The main export of `@datafn/svelte`; converts a `DatafnSignal<T>` to a Svelte `Readable` store. |

---

## Goals

1. **Delete all legacy backward-compatibility code** — no deprecated types, no shims, no bridge functions, no deprecation warnings, no `@deprecated` JSDoc tags for removed APIs.
2. **Simplify types** — `DatafnStorageFactory` accepts only `(namespace: string) => DatafnStorageAdapter`, not a union with `AuthContext`. `DatafnChangelogEntry` has only `actorId`, not `userId`. `DatafnSchema` has only `namespaced`, not `multiTenant`. `DatafnServerConfig` has only `namespaceProvider`, not `authContextProvider`. `DatafnClientConfig` has only `namespace`, not `authContext`. `SwitchContextOverride` has only `namespace`, not `authContext`. `DatafnClient` has only `currentNamespace()`, not `currentContext()`.
3. **Remove `@superfunctions/auth` import** from `@datafn/client` and `@datafn/server` — no re-exports of `AuthContext` / `AuthContextProvider`.
4. **Update all documentation** to reflect only the current API surface.
5. **Document `@datafn/svelte`** — add docs for the Svelte adapter package including API reference, usage examples, and integration patterns.
6. **Document the framework adapter ecosystem** — explain how `@datafn/svelte` fits into the larger vision of framework-specific packages and how the pattern extends to React, Vue, and others.
7. **Update tests** — remove legacy-specific test files and update remaining tests to use only the new APIs.
8. **Restructure sidebar: move schema sub-topics under DFQL** — resources, fields, relations, system-fields move from "Concepts" to "DFQL". Replace the schema page in "Concepts" with a high-level "Overview" page covering all core concepts.
9. **Cross-link DFQL pages from main documentation** — client queries, mutations, signals, etc. MUST link to the corresponding DFQL reference pages (select, sort, filters, pagination, etc.).
10. **Create a system architecture diagram** — a mermaid diagram showing the entire DataFn system, used on the home page and concepts overview.
11. **Merge Python SDK into main server docs** — remove the separate Python sidebar section and integrate Python examples into server docs using Fumadocs tabbed code blocks (`<Tabs>`).

## Non-goals

1. Modifying `@superfunctions/auth` package (its `AuthContext` / `AuthContextProvider` types remain for auth-layer use; we just stop importing them in datafn).
2. Changing the `__ns` column name, format, or row-level namespace wrapper in `@superfunctions/db`.
3. Actually creating React, Vue, or other framework adapter packages (only documenting the pattern).
4. Modifying the `ns()` helper or `namespaceProvider` APIs (they stay exactly as-is).
5. Database migrations.
6. Creating new Python SDK code — only moving existing Python documentation into main server docs using tabs.
7. Changing the content of existing DFQL pages (queries, filters, sorting, etc.) — only moving them in the sidebar hierarchy and adding cross-links.

---

## Public API (After Changes)

### `@datafn/core`

#### `DatafnSchema`

```typescript
export type DatafnSchema = {
  resources: DatafnResourceSchema[];
  relations?: DatafnRelationSchema[];
  /** Defaults to true. Set to false to disable row-level namespace isolation. */
  namespaced?: boolean;
  // multiTenant REMOVED
};
```

#### `defineSchema()`

```typescript
export function defineSchema<
  const T extends {
    readonly resources: readonly DatafnResourceBase[];
    readonly relations?: readonly DatafnRelationSchema[] | DatafnRelationSchema[];
    readonly namespaced?: boolean;
    // multiTenant REMOVED from generic constraint
  }
>(schema: T & { readonly resources: ValidateResources<T["resources"]> }): T & DatafnSchema;
```

#### Schema validation (`validateSchema`)

- MUST NOT check for `multiTenant` field.
- MUST NOT emit deprecation warning for `multiTenant`.
- The `_multiTenantDeprecationWarned` flag MUST be removed.
- `resolveNamespaced()` MUST only check `schema.namespaced`. Falls back to `true`.
- `isNamespaced()` MUST only check `schema.namespaced`. Falls back to `true`.
- The normalized output MUST NOT include `multiTenant` key.

### `@datafn/server`

#### `DatafnServerConfig`

```typescript
export interface DatafnServerConfig<TContext = any> {
  schema: DatafnSchema;
  db?: Adapter;
  plugins?: DatafnPlugin[];
  authorize?: (...) => Promise<boolean> | boolean;
  limits?: { ... };
  debug?: boolean;
  allowUnknownResources?: boolean;
  getServerTime?: () => number;
  rest?: boolean;
  namespaceProvider?: {
    getNamespace: (ctx: TContext) => string | Promise<string>;
    getActorId?: (ctx: TContext) => string | Promise<string>;
  };
  // authContextProvider REMOVED
  redis?: RedisAdapter;
  kvStore?: KVStoreAdapter;
  dbMapping?: DbMapping;
  rowLevelNamespace?: false | RowLevelNamespaceConfig;
  retention?: RetentionConfig;
  rateLimit?: RateLimitConfig<TContext>;
  observability?: ObservabilityConfig;
  ws?: WsManagerConfig;
  shutdownTimeoutMs?: number;
  logger?: DatafnLogger;
}
```

#### `extractNamespace` (internal)

```typescript
// Simplified — no legacy bridge
const extractNamespace = async (ctx: TContext): Promise<string> => {
  if (config.namespaceProvider) {
    const ns = await config.namespaceProvider.getNamespace(ctx);
    if (typeof ns !== "string" || ns === "") {
      throw NAMESPACE_INVALID;
    }
    return ns;
  }
  return "datafn";
};
```

#### `extractActorId` (internal)

```typescript
const extractActorId = async (ctx: TContext): Promise<string | undefined> => {
  if (config.namespaceProvider?.getActorId) {
    try { return await config.namespaceProvider.getActorId(ctx); }
    catch { return undefined; }
  }
  return undefined;
};
```

#### Rate limit default key extractor

```typescript
const defaultKeyExtractor = async (ctx: TContext): Promise<string> => {
  if (config.namespaceProvider) {
    try { return await config.namespaceProvider.getNamespace(ctx); }
    catch { /* fall through */ }
  }
  return "anonymous";
};
```

#### Server imports

- MUST NOT import `AuthContext` or `AuthContextProvider` from `@superfunctions/auth`.

### `@datafn/client`

#### `DatafnClientConfig`

```typescript
export interface DatafnClientConfig<S extends DatafnSchema> {
  schema: S;
  sync?: DatafnSyncConfig;
  plugins?: DatafnPlugin[];
  clientId: string;
  storage?: DatafnStorageAdapter | DatafnStorageFactory;
  namespace?: string;
  // authContext REMOVED
  getTimestamp?: () => number;
  generateId?: (params: { resource: string; idPrefix?: string }) => string;
}
```

#### `SwitchContextOverride`

```typescript
export type SwitchContextOverride = {
  namespace?: string;
  // authContext REMOVED
  sync?: DatafnSyncConfig;
  storage?: DatafnStorageAdapter | DatafnStorageFactory;
};
```

#### `DatafnClient`

```typescript
export type DatafnClient<S extends DatafnSchema> = {
  // ... all existing methods ...
  currentNamespace(): string | undefined;
  // currentContext() REMOVED
  switchContext(override: SwitchContextOverride): Promise<void>;
  subscribeClient(fn: (client: DatafnClient<S>) => void): () => void;
} & { [Name in ResourceNames<S>]: DatafnTable<S, Name> };
```

#### `DatafnStorageFactory`

```typescript
export type DatafnStorageFactory = (namespace: string) => DatafnStorageAdapter;
```

- No union with `AuthContext`. The parameter is always `string`.

#### `DatafnChangelogEntry`

```typescript
export type DatafnChangelogEntry = {
  seq: number;
  clientId: string;
  mutationId: string;
  mutation: Record<string, unknown>;
  timestampMs: number;
  actorId?: string;
  // userId REMOVED
  timestamp?: string;
};
```

#### `IndexedDbStorageAdapter`

- `createForUser()` MUST be deleted.
- `createForNamespace()` remains as-is.

#### Client entry point (`index.ts`)

- MUST NOT re-export `AuthContext` or `AuthContextProvider` from `@superfunctions/auth`.
- MUST NOT import from `@superfunctions/auth` at all.

#### Client internal (`_buildRawClient`)

- MUST NOT reference `config.authContext`.
- Storage factory resolution: when `storage` is a function, MUST require `config.namespace`. Call factory with `config.namespace` (string). No `AuthContext` branch.
- MUST NOT derive namespace from `authContext`.
- No deprecation warnings for removed APIs.

### `@datafn/cli`

#### Drizzle codegen

- Variable name `isMultiTenant` SHOULD be renamed to `isNamespaced` for consistency (already calls `isNamespaced()` from core).
- Comments referencing "multiTenant" MUST be updated to "namespaced".

---

## Data Formats / Protocol

No changes to wire formats. The `__ns` column stores the same string values. No migration needed.

---

## Semantics

### Namespace resolution (server) — simplified

1. `namespaceProvider.getNamespace(ctx)` — if configured.
2. Default `"datafn"` — when no provider.
3. No legacy bridge step.

### Actor ID resolution (server) — simplified

1. `namespaceProvider.getActorId(ctx)` — if configured.
2. `undefined` — when not configured.
3. No legacy bridge step.

### Client namespace resolution — simplified

1. `config.namespace` — if provided.
2. `undefined` — no namespace. Storage MUST be a direct adapter (not factory).
3. No `authContext` derivation.

---

## Invariants

1. **INV-001 (preserved)**: `__ns` value MUST be identical across all operations for a given request context.
2. **INV-002 (preserved)**: Empty namespace strings MUST be rejected with `NAMESPACE_INVALID`.
3. **INV-003 (REMOVED)**: Legacy bridge invariant is deleted — no backward compat bridge exists.
4. **INV-004 (preserved)**: `namespaceProvider.getNamespace()` errors MUST propagate.
5. **INV-005 (preserved)**: `ns()` is deterministic and pure.
6. **INV-006 (simplified)**: `namespaced` defaults to `true`. No `multiTenant` fallback.

---

## Security

- **SEC-001 (preserved)**: WS namespace MUST be server-derived.
- **SEC-002 (preserved)**: Namespace injection via request body MUST be impossible.
- **SEC-003 (preserved)**: Application responsibility to validate namespace input.
- **SEC-004 (preserved)**: `actorId` is for attribution, not authorization.

---

## Limits/Caps

No changes.

---

## Observability

- **OBS-NS-001 (REMOVED)**: No deprecation warning for `authContextProvider` (it no longer exists).
- **OBS-NS-002 (REMOVED)**: No deprecation warning for `multiTenant` (it no longer exists).
- **OBS-NS-003 (preserved)**: Namespace value in timing/observability context.

---

## Compatibility / Versioning Strategy

This is a **breaking change** for anyone using the deprecated APIs. Since the library has no external users yet, this is acceptable. The library version SHOULD be bumped (minor or patch, at user's discretion, since it's pre-1.0).

There is no migration path to document — the old APIs simply do not exist.

---

## Docs Restructuring

### Sidebar restructuring: Schema sub-topics → DFQL

The current sidebar nests `resources`, `fields`, `relations`, `system-fields` under `documentation/concepts/`. These pages describe DFQL constructs and MUST be moved to the `dfql/` section.

**Current `concepts/meta.json`:**
```json
{ "title": "Concepts", "pages": ["schema", "resources", "fields", "relations", "system-fields", "multi-tenancy"] }
```

**New `concepts/meta.json`:**
```json
{ "title": "Concepts", "pages": ["overview", "multi-tenancy"] }
```

- `concepts/schema.mdx` → REMOVED (content absorbed into overview and DFQL schema page).
- `concepts/resources.mdx` → MOVED to `dfql/resources.mdx` (or file stays, sidebar references it from DFQL).
- `concepts/fields.mdx` → MOVED to `dfql/fields.mdx`.
- `concepts/relations.mdx` → MOVED to `dfql/relations.mdx` (note: a `dfql/relations.mdx` already exists — merge if needed or keep both with distinct focus).
- `concepts/system-fields.mdx` → MOVED to `dfql/system-fields.mdx`.
- `concepts/overview.mdx` → CREATED — high-level overview of all DataFn core concepts.

**New `dfql/meta.json`:**
```json
{
  "title": "DFQL",
  "description": "DataFn Query Language",
  "root": true,
  "pages": [
    "index",
    "schema",
    "resources",
    "fields",
    "relations",
    "system-fields",
    "queries",
    "filters",
    "sorting",
    "pagination",
    "select",
    "aggregations",
    "search",
    "mutations",
    "transactions"
  ]
}
```

### Concepts Overview page

The new `concepts/overview.mdx` MUST cover (at high level):
- What is DataFn (1-2 sentences)
- **DFQL** — the query language (schema, resources, fields, queries, mutations, transactions)
- **Client** — the client-side SDK (signals, offline-first, storage)
- **Server** — the server-side runtime (routes, authorization, sync)
- **Framework Libraries** — `@datafn/svelte`, planned `@datafn/react`, `@datafn/vue`, etc.
- **Sync** — offline-first synchronization (clone, pull, push)
- A mermaid system architecture diagram

### Cross-linking DFQL from main docs

The following pages MUST include links to the relevant DFQL reference pages:

| Main doc page | References | DFQL link target |
|---|---|---|
| `client/queries.mdx` | filters | `/docs/dfql/filters` |
| `client/queries.mdx` | sorting | `/docs/dfql/sorting` |
| `client/queries.mdx` | pagination | `/docs/dfql/pagination` |
| `client/queries.mdx` | select | `/docs/dfql/select` |
| `client/queries.mdx` | aggregations | `/docs/dfql/aggregations` |
| `client/queries.mdx` | search | `/docs/dfql/search` |
| `client/mutations.mdx` | mutations | `/docs/dfql/mutations` |
| `client/transactions.mdx` | transactions | `/docs/dfql/transactions` |
| `client/signals.mdx` | queries/select | `/docs/dfql/queries`, `/docs/dfql/select` |

Links SHOULD be contextual (e.g., "See the full [DFQL Select reference](/docs/dfql/select) for all projection options.") rather than a standalone "See also" list.

### System architecture diagram

A mermaid diagram MUST show:
- Client (browser/mobile) with: DatafnClient, Signals, Storage (IndexedDB/Memory), Framework Adapters
- Server with: DatafnServer, Routes, Authorization, Sync Engine
- DFQL as the protocol between client and server
- Database layer (via adapters)
- Sync flow (clone, pull, push) between client and server

This diagram MUST be placed in:
1. `docs/index.mdx` (home page)
2. `documentation/concepts/overview.mdx`

### Python SDK integration into server docs

The separate `python/` sidebar section (`python/index.mdx`, `python/setup.mdx`, `python/server.mdx`, `python/database.mdx`, `python/handlers.mdx`) MUST be merged into the main server documentation using Fumadocs tabbed code blocks.

**Integration approach:**
- `python/setup.mdx` content → merged into `documentation/server/setup.mdx` using `<Tabs>` for TypeScript vs Python examples
- `python/server.mdx` content → merged into `documentation/server/routes.mdx` and `documentation/server/setup.mdx`
- `python/database.mdx` content → merged into `documentation/database/adapters.mdx`
- `python/handlers.mdx` content → merged into `documentation/server/authorization.mdx` or `documentation/server/routes.mdx`
- `python/index.mdx` → REMOVED (brief note about Python support added to main docs index or server setup)

**Fumadocs Tabs usage** (per https://www.fumadocs.dev/docs):
```mdx
import { Tab, Tabs } from "fumadocs-ui/components/tabs";

<Tabs items={["TypeScript", "Python"]}>
  <Tab value="TypeScript">
    ```typescript
    // TypeScript example
    ```
  </Tab>
  <Tab value="Python">
    ```python
    # Python example
    ```
  </Tab>
</Tabs>
```

**Top-level sidebar update:**
```json
{ "title": "DataFn", "pages": ["index", "documentation", "dfql", "cli", "reference"] }
```
(`"python"` removed from top-level pages.)

---

## Undefined / Explicitly User-Deferred Only

- None. All scope items from user intent are covered.

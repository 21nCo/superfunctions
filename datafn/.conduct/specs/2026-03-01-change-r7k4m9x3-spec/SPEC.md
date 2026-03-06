# SPEC: Generic Namespace Isolation (Replace tenant/user with composable namespace)

## Metadata

- **Timestamp**: 2026-03-01T20:00:00Z
- **Agent**: claude-opus-4-6
- **Model**: Claude Opus 4.6
- **Launcher**: VS Code (Claude Code Extension)
- **Workspace**: /Users/serro/Documents/dev/n/superfunctions
- **OS**: Darwin 25.3.0, zsh
- **Git branch**: `next`
- **Git commit**: ea87d7e (dirty)
- **spec_folder**: `2026-03-01-change-r7k4m9x3-spec`
- **spec_type**: `change`
- **spec_id**: `r7k4m9x3`
- **Input paths**: conversation context (no external docs)

---

## Overview

Replace the two-level `tenantId`/`userId` namespace model with a single composable `namespace: string` across the entire datafn stack (server, client, CLI, core types, `@superfunctions/auth`, `@superfunctions/db`). This decouples datafn's data isolation from any specific auth model or organizational hierarchy, enabling arbitrary grouping patterns (personal workspaces, teams, projects, IoT device groups, etc.) without impedance mismatch.

The `multiTenant` schema flag is renamed to `namespaced` (boolean) to remove SaaS-specific connotation. The server's `authContextProvider` is replaced with a `namespaceProvider` that returns a plain string. A `ns()` composable helper function is provided in `@datafn/core` for constructing colon-delimited namespace strings from N segments. Client-side `AuthContext` usage within datafn is replaced by a `namespace: string` parameter. The `@superfunctions/auth` package's `AuthContext` type is NOT modified (it continues to serve auth-layer concerns); datafn simply stops coupling to it.

---

## Glossary

| Term | Definition |
|---|---|
| **namespace** | An opaque string that partitions data rows. Stored in the `__ns` column. Can be any non-empty string. |
| **namespace provider** | A server-side function `(ctx: TContext) => string \| Promise<string>` that extracts the namespace from request context. |
| **ns()** | A helper function in `@datafn/core` that joins N string segments with `:` delimiter, e.g. `ns("org", "user") => "org:user"`. |
| **namespaced** | Schema-level boolean (default `true`) that controls whether `__ns` column and row-level isolation are active. Replaces `multiTenant`. |
| **actor ID** | An optional identifier for audit attribution (who performed a mutation). Separate from namespace (which controls isolation). |
| **__ns** | The physical database column holding the namespace string. Unchanged. |
| **row-level namespace** | The `@superfunctions/db` wrapper that injects `__ns` WHERE clauses on reads and stamps `__ns` on writes. Unchanged in mechanism. |

---

## Goals

1. Remove `tenantId`/`userId` semantics from datafn's namespace isolation layer.
2. Provide a single `namespace: string` as the isolation primitive across server, client, WS, change tracking, and CLI codegen.
3. Decouple datafn from `@superfunctions/auth`'s `AuthContext` type for namespace purposes.
4. Rename `multiTenant` to `namespaced` in `DatafnSchema`.
5. Provide `ns()` helper for composing multi-segment namespace strings.
6. Separate audit attribution (`actorId`) from namespace isolation.
7. Maintain full backward compatibility for the `__ns` column format and row-level namespace wrapper.

## Non-goals

1. Modifying `@superfunctions/auth`'s `AuthContext` or `AuthContextProvider` types.
2. Changing the `__ns` column name or the `RowLevelNamespaceConfig` in `@superfunctions/db`.
3. Adding N-level structured namespace querying (e.g. "find all namespaces under org X"). This remains achievable via `startsWith` on `__ns` values but is not a first-class API.
4. Changing the DB-level `NamespaceManager` (library-level table prefix isolation) in `packages/db`.
5. Database migrations — existing `__ns` values continue to work as-is. No data migration required.

---

## Public API

### `@datafn/core`

#### `ns(...segments: string[]): string`

Composable namespace helper. Joins non-empty segments with `:`.

```typescript
export function ns(...segments: string[]): string;
```

**Behavior:**
- Filters out empty/falsy segments.
- Joins remaining segments with `:`.
- Throws if result is empty (at least one non-empty segment required).
- Does NOT validate segment content (any non-empty string is valid).

**Examples:**
```typescript
ns("org-acme", "user-123")        // => "org-acme:user-123"
ns("user-1")                      // => "user-1"
ns("org", "project", "user")      // => "org:project:user"
ns("org", "", "user")             // => "org:user" (empty filtered)
ns()                              // throws Error
```

#### `DatafnSchema.namespaced` (replaces `multiTenant`)

```typescript
export type DatafnSchema = {
  resources: DatafnResourceSchema[];
  relations?: DatafnRelationSchema[];
  /** Defaults to true. Set to false to disable row-level namespace isolation. */
  namespaced?: boolean;
  /** @deprecated Use `namespaced`. Will be removed in next major. */
  multiTenant?: boolean;
};
```

During the transition period, both `namespaced` and `multiTenant` are accepted. `namespaced` takes precedence when both are set. `multiTenant` emits a deprecation warning at schema validation time.

#### `defineSchema()` update

The `defineSchema()` helper MUST accept `namespaced` in addition to `multiTenant`.

### `@datafn/server`

#### `DatafnServerConfig.namespaceProvider` (replaces `authContextProvider`)

```typescript
export interface DatafnServerConfig<TContext = any> {
  // ... existing fields ...

  /**
   * Namespace provider for per-request data isolation.
   * Returns the namespace string used to scope all data operations.
   * Without this, all data shares the default "datafn" namespace.
   */
  namespaceProvider?: {
    getNamespace: (ctx: TContext) => string | Promise<string>;
    /** Optional actor ID for audit attribution (separate from isolation). */
    getActorId?: (ctx: TContext) => string | Promise<string>;
  };

  /** @deprecated Use `namespaceProvider`. Will be removed in next major. */
  authContextProvider?: {
    getContext: (ctx: TContext) => AuthContext | Promise<AuthContext>;
  };
}
```

**Backward compatibility:** When `authContextProvider` is provided but `namespaceProvider` is not, the server MUST auto-construct a `namespaceProvider` that calls `getContext()` and composes the namespace as `tenant:{tenantId}:user:{userId}` or `user:{userId}` (matching current behavior). A deprecation warning MUST be logged once at startup.

#### `extractNamespace` internal changes

The internal `extractNamespace` function MUST:
- Use `namespaceProvider.getNamespace(ctx)` when available.
- Fall back to legacy `authContextProvider` bridge when only `authContextProvider` is set.
- Return `"datafn"` when neither is configured.
- Throw on provider errors (no silent fallback — SRV-010 preserved).
- Validate returned namespace is non-empty string; throw `NAMESPACE_INVALID` if empty.

#### Rate limit key extraction

The default key extractor MUST use `namespaceProvider.getNamespace(ctx)` (or the legacy bridge) instead of `authContext.userId`. Falls back to `"anonymous"`.

### `@datafn/client`

#### `DatafnClientConfig` changes

```typescript
export interface DatafnClientConfig<S extends DatafnSchema> {
  // ... existing fields ...

  /**
   * Namespace for client-side data isolation.
   * Used to construct isolated storage (IndexedDB database names, BroadcastChannel names).
   * Required when `storage` is a factory function.
   */
  namespace?: string;

  /** @deprecated Use `namespace`. Will be removed in next major. */
  authContext?: AuthContext | AuthContextProvider;

  // storage factory signature changes:
  /**
   * Local persistence adapter. Can be:
   * - A direct `DatafnStorageAdapter` instance
   * - A factory function `(namespace: string) => DatafnStorageAdapter`
   */
  storage?: DatafnStorageAdapter | DatafnStorageFactory;
}
```

#### `DatafnStorageFactory` type change

```typescript
// New:
export type DatafnStorageFactory = (namespace: string) => DatafnStorageAdapter;

// Deprecated compat:
export type LegacyDatafnStorageFactory = (context: AuthContext) => DatafnStorageAdapter;
```

During transition, if the factory function is detected as taking an `AuthContext`-shaped argument (via `authContext` config presence), it MUST be wrapped to extract the namespace and call accordingly.

#### `IndexedDbStorageAdapter.createForNamespace()`

New static factory (replaces `createForUser`):

```typescript
static createForNamespace(
  baseDbName: string,
  namespace: string,
  resources?: string[],
  schema?: DatafnSchema,
): IndexedDbStorageAdapter;
```

`createForUser` is deprecated but preserved.

#### `SwitchContextOverride` changes

```typescript
export type SwitchContextOverride = {
  /** New namespace (replaces current) */
  namespace?: string;
  /** @deprecated Use `namespace`. */
  authContext?: AuthContext;
  sync?: DatafnSyncConfig;
  storage?: DatafnStorageAdapter | DatafnStorageFactory;
};
```

#### `currentContext()` → `currentNamespace()`

```typescript
// New method on DatafnClient:
currentNamespace(): string | undefined;

// Deprecated:
currentContext(): AuthContext | undefined;
```

#### Cross-tab `BroadcastChannel` naming

Currently uses `datafn:${namespace}` where `namespace` was internally derived. The channel name construction remains the same — but the input is now the user-supplied `namespace` string directly.

#### Changelog `userId` field → `actorId`

```typescript
export type DatafnChangelogEntry = {
  seq: number;
  clientId: string;
  mutationId: string;
  mutation: Record<string, unknown>;
  timestampMs: number;
  /** Actor ID for audit attribution (when available) - AUD-001 */
  actorId?: string;
  /** @deprecated Use actorId */
  userId?: string;
  timestamp?: string;
};
```

### `@datafn/cli`

#### Drizzle codegen

The CLI codegen MUST check `schema.namespaced !== false` (with fallback to `schema.multiTenant !== false` for compat) when deciding whether to emit `__ns` column.

---

## Data Formats / Protocol

### Namespace string format

- Any non-empty string.
- Convention (not enforced): colon-delimited segments, e.g. `"org:user"`, `"workspace:123"`.
- The `ns()` helper produces colon-delimited strings.
- The `__ns` column stores this string as-is (TEXT NOT NULL).
- No maximum length enforced by datafn (subject to database column limits).

### Server-stored namespace format

| Scenario | Old format | New format |
|---|---|---|
| No provider | `"datafn"` | `"datafn"` (unchanged) |
| User-only | `"user:{userId}"` | Whatever `getNamespace()` returns |
| Tenant+User | `"tenant:{tenantId}:user:{userId}"` | Whatever `getNamespace()` returns |
| Legacy bridge | N/A | `"tenant:{tenantId}:user:{userId}"` or `"user:{userId}"` |

### Client-side storage naming

| Scenario | Old format | New format |
|---|---|---|
| With tenant+user | `{base}_{tenantId}_{userId}` | `{base}_{namespace}` (with `:` replaced by `_`) |
| User-only | `{base}_{userId}` | `{base}_{namespace}` |
| Legacy bridge | N/A | `{base}_{tenantId}_{userId}` (unchanged) |

---

## Semantics

### Namespace resolution order (server)

1. `namespaceProvider.getNamespace(ctx)` — if `namespaceProvider` is configured.
2. Legacy bridge from `authContextProvider.getContext(ctx)` → compose `tenant:X:user:Y` or `user:Y`.
3. Default `"datafn"` when neither is configured.

### Actor ID resolution order (server)

1. `namespaceProvider.getActorId(ctx)` — if configured.
2. Legacy bridge: `authContextProvider.getContext(ctx).userId`.
3. `undefined` when neither is configured (no audit attribution).

### Client namespace resolution

1. `config.namespace` — if provided.
2. Legacy bridge from `config.authContext` → compose namespace from `tenantId`/`userId`.
3. `undefined` — storage MUST be a direct adapter (not factory) when no namespace.

---

## Invariants

1. **INV-001**: The `__ns` column value MUST be identical across all operations (CRUD, change tracking, sequence store, WS broadcast) for a given request context. No partial namespace application.
2. **INV-002**: Empty namespace strings MUST be rejected with error code `NAMESPACE_INVALID`. The minimum valid namespace is 1 character.
3. **INV-003**: Legacy `authContextProvider` MUST produce identical `__ns` values as the current implementation when used via the backward-compat bridge. Existing data MUST remain accessible.
4. **INV-004**: `namespaceProvider.getNamespace()` errors MUST propagate (no silent fallback to default namespace). This preserves SRV-010.
5. **INV-005**: The `ns()` helper MUST be deterministic and pure. Same inputs always produce the same output.
6. **INV-006**: Renaming `multiTenant` → `namespaced` MUST NOT change default behavior. Both default to `true`.

---

## Security

- **SEC-001 (preserved)**: WS namespace MUST be server-derived, never client-supplied.
- **SEC-002 (preserved)**: Namespace injection via request body MUST be impossible. The namespace comes exclusively from the provider.
- **SEC-003**: `namespaceProvider.getNamespace()` MUST NOT accept untrusted client input without server-side validation. This is an application responsibility (documented in JSDoc), not enforced by datafn.
- **SEC-004**: The `actorId` is for attribution, not authorization. It MUST NOT be used for namespace isolation decisions.

---

## Limits/Caps

- No new limits introduced.
- Namespace string length: uncapped by datafn (subject to database TEXT column limits, typically 1GB+ for PostgreSQL, 2^31-1 for SQLite).
- `ns()` segment count: uncapped.

---

## Observability

- **OBS-NS-001**: When legacy `authContextProvider` is used, a deprecation warning MUST be logged once at server startup: `"authContextProvider is deprecated. Use namespaceProvider instead."`
- **OBS-NS-002**: When legacy `multiTenant` schema field is used, a deprecation warning MUST be emitted during schema validation.
- **OBS-NS-003**: Namespace value MUST be included in timing/observability context (already true via change tracking; no change needed).

---

## Compatibility / Versioning Strategy

This is a **non-breaking change** with deprecation:

1. **Phase 1 (this spec)**: Add new APIs (`namespaceProvider`, `namespace`, `namespaced`, `ns()`). Deprecate old APIs (`authContextProvider`, `authContext`, `multiTenant`). Both work.
2. **Phase 2 (future major version)**: Remove deprecated APIs. Out of scope for this spec.

### Migration path for users

```typescript
// Before:
const server = await createDatafnServer({
  schema: defineSchema({ resources: [...], multiTenant: true }),
  authContextProvider: {
    getContext: (ctx) => ({
      userId: ctx.auth.id,
      tenantId: ctx.resourceId,
    }),
  },
});

// After:
const server = await createDatafnServer({
  schema: defineSchema({ resources: [...], namespaced: true }),
  namespaceProvider: {
    getNamespace: (ctx) => ns(ctx.resourceId, ctx.auth.id),
    getActorId: (ctx) => ctx.auth.id,
  },
});
```

```typescript
// Before (client):
const client = createDatafnClient({
  schema,
  clientId: "device-1",
  authContext: { userId: "user-123", tenantId: "org-456" },
  storage: (ctx) => IndexedDbStorageAdapter.createForUser("app", ctx.userId, ctx.tenantId),
});

// After (client):
const client = createDatafnClient({
  schema,
  clientId: "device-1",
  namespace: ns("org-456", "user-123"),
  storage: (ns) => IndexedDbStorageAdapter.createForNamespace("app", ns),
});
```

---

## Undefined / Explicitly User-Deferred Only

- None. All scope items from user intent are covered.

# REQUIREMENTS

## Table of Contents

| ID | Priority | Summary |
|---|---|---|
| NS-001 | P0 | `ns()` helper function in `@datafn/core` |
| NS-002 | P0 | Rename `multiTenant` to `namespaced` in `DatafnSchema` |
| NS-003 | P0 | `namespaceProvider` replaces `authContextProvider` on server |
| NS-004 | P0 | Server `extractNamespace` uses `namespaceProvider` |
| NS-005 | P0 | Legacy `authContextProvider` backward-compat bridge |
| NS-006 | P0 | Server rate-limit key extraction uses namespace |
| NS-007 | P0 | Client `namespace` config replaces `authContext` |
| NS-008 | P0 | `DatafnStorageFactory` signature change |
| NS-009 | P0 | `IndexedDbStorageAdapter.createForNamespace()` |
| NS-010 | P0 | `MemoryStorageAdapter` namespace support |
| NS-011 | P0 | `SwitchContextOverride.namespace` replaces `authContext` |
| NS-012 | P0 | `currentNamespace()` replaces `currentContext()` |
| NS-013 | P0 | Client cross-tab `BroadcastChannel` uses `namespace` |
| NS-014 | P1 | Changelog `actorId` replaces `userId` |
| NS-015 | P0 | Server `actorId` extraction via `namespaceProvider.getActorId()` |
| NS-016 | P0 | CLI codegen respects `namespaced` with `multiTenant` fallback |
| NS-017 | P0 | `defineSchema()` accepts `namespaced` |
| NS-018 | P1 | Deprecation warnings for legacy APIs |
| NS-019 | P0 | Client namespace resolution for storage factory |
| NS-020 | P0 | Client re-exports updated types |
| NS-021 | P0 | WS auth context uses namespace string directly |
| NS-022 | P0 | Empty namespace validation |
| NS-023 | P0 | Client `SyncEngine` / transport uses `namespace` |

---

## NS-001: `ns()` helper function

- **Priority**: P0
- **Statement**: `@datafn/core` MUST export a `ns(...segments: string[]): string` function that joins non-empty string segments with `:` delimiter.
- **Rationale**: Provides a standardized way to compose multi-segment namespace strings without coupling to any specific hierarchy.
- **Acceptance criteria**:
  - Exported from `@datafn/core` package entry point.
  - Filters out empty strings, `undefined`, and `null` values from segments.
  - Joins remaining segments with `:`.
  - Throws `Error` if all segments are empty (result would be empty string).
  - Returns a single segment unchanged (no trailing `:`).
  - Is a pure, deterministic function.
- **Test vectors**: TV-NS-001, TV-NS-002, TV-NS-003
- **Notes**: Segments themselves MAY contain `:` — the function does not escape. This is by design; the function is a convenience, not a strict encoder.

---

## NS-002: Rename `multiTenant` to `namespaced`

- **Priority**: P0
- **Statement**: `DatafnSchema` MUST accept a `namespaced?: boolean` field (default `true`) that controls row-level namespace isolation, replacing `multiTenant`.
- **Rationale**: Removes SaaS-specific terminology. "Namespaced" accurately describes the feature without implying a tenant/user hierarchy.
- **Acceptance criteria**:
  - `DatafnSchema` type includes `namespaced?: boolean`.
  - `multiTenant?: boolean` remains on the type (deprecated).
  - When both are set, `namespaced` takes precedence.
  - When only `multiTenant` is set, its value is used.
  - Default behavior (neither set) is `true` (namespace isolation enabled).
  - Schema validation logic handles both fields.
- **Test vectors**: TV-NS-004, TV-NS-005, TV-NS-006
- **Notes**: `multiTenant` is deprecated, not removed. Removal is deferred to next major version.

---

## NS-003: `namespaceProvider` on server

- **Priority**: P0
- **Statement**: `DatafnServerConfig` MUST accept a `namespaceProvider` field with `getNamespace(ctx) => string | Promise<string>` and optional `getActorId(ctx) => string | Promise<string>`.
- **Rationale**: Replaces the structured `AuthContext` bridge with a single composable string, decoupling datafn from auth type structures.
- **Acceptance criteria**:
  - `namespaceProvider` field added to `DatafnServerConfig<TContext>`.
  - `getNamespace` receives `TContext` and returns `string | Promise<string>`.
  - `getActorId` is optional; receives `TContext` and returns `string | Promise<string>`.
  - `authContextProvider` field remains (deprecated).
  - When both `namespaceProvider` and `authContextProvider` are provided, `namespaceProvider` takes precedence.
  - TypeScript types compile correctly.
- **Test vectors**: TV-NS-007, TV-NS-008
- **Notes**: The `AuthContext` import from `@superfunctions/auth` in server.ts can be removed once `authContextProvider` compat bridge is wired.

---

## NS-004: Server `extractNamespace` uses `namespaceProvider`

- **Priority**: P0
- **Statement**: The server's internal `extractNamespace` function MUST resolve namespace from `namespaceProvider.getNamespace(ctx)` when configured.
- **Rationale**: Core behavioral change — all downstream consumers (query, mutation, sync, change tracking, WS) receive the namespace from this single function.
- **Acceptance criteria**:
  - When `namespaceProvider` is configured, calls `getNamespace(ctx)`.
  - Validates returned value is a non-empty string.
  - Throws with code `NAMESPACE_INVALID` if returned value is empty or not a string.
  - Propagates errors from `getNamespace()` (no silent fallback — INV-004).
  - All route handlers continue to receive `extractNamespace` unchanged.
- **Test vectors**: TV-NS-009, TV-NS-010, TV-NS-011
- **Notes**: The function signature `(ctx: TContext) => Promise<string>` is unchanged.

---

## NS-005: Legacy `authContextProvider` backward-compat bridge

- **Priority**: P0
- **Statement**: When only `authContextProvider` is configured (no `namespaceProvider`), the server MUST auto-construct a namespace using the existing `tenant:{tenantId}:user:{userId}` or `user:{userId}` format.
- **Rationale**: Existing deployments MUST NOT break. Data already stored with old namespace format MUST remain accessible.
- **Acceptance criteria**:
  - `authContextProvider.getContext(ctx)` is called.
  - If `tenantId` is present: namespace = `tenant:{tenantId}:user:{userId}`.
  - If only `userId`: namespace = `user:{userId}`.
  - If `userId` is empty: logs warning, returns `"datafn"` (current behavior).
  - Actor ID is extracted as `authContext.userId`.
  - A deprecation warning is logged once at startup.
  - Behavior is byte-identical to current `extractNamespace` implementation.
- **Test vectors**: TV-NS-012, TV-NS-013, TV-NS-014
- **Notes**: This bridge exists solely for backward compatibility. New code should use `namespaceProvider`.

---

## NS-006: Rate-limit key extraction uses namespace

- **Priority**: P0
- **Statement**: The default rate-limit key extractor MUST use the resolved namespace (from `namespaceProvider` or legacy bridge) instead of `authContext.userId`.
- **Rationale**: Rate limiting should align with the namespace boundary, not auth-specific fields.
- **Acceptance criteria**:
  - When `namespaceProvider` is configured, default key = `getNamespace(ctx)`.
  - When only `authContextProvider` is configured, default key = `authContext.userId` (current behavior, via bridge).
  - Falls back to `"anonymous"` on error.
  - Custom `keyExtractor` override still works.
- **Test vectors**: TV-NS-015
- **Notes**: Minor behavioral change for new `namespaceProvider` users. Existing `authContextProvider` users see no change.

---

## NS-007: Client `namespace` config replaces `authContext`

- **Priority**: P0
- **Statement**: `DatafnClientConfig` MUST accept a `namespace?: string` field for client-side data isolation, replacing `authContext`.
- **Rationale**: The client doesn't need structured auth data for isolation — just a namespace string.
- **Acceptance criteria**:
  - `namespace?: string` added to `DatafnClientConfig`.
  - `authContext` remains (deprecated).
  - When both are set, `namespace` takes precedence.
  - When only `authContext` is set, namespace is composed as `{tenantId}_{userId}` or `{userId}` (legacy behavior for storage).
  - `namespace` is used for: storage factory invocation, BroadcastChannel naming, changelog attribution.
  - Validation: when `storage` is a factory and neither `namespace` nor `authContext` is provided, throw `DFQL_INVALID`.
- **Test vectors**: TV-NS-016, TV-NS-017
- **Notes**: None.

---

## NS-008: `DatafnStorageFactory` signature change

- **Priority**: P0
- **Statement**: `DatafnStorageFactory` MUST accept `(namespace: string) => DatafnStorageAdapter` as its primary signature.
- **Rationale**: Aligns with the generic namespace model; storage factories don't need structured auth data.
- **Acceptance criteria**:
  - New type: `DatafnStorageFactory = (namespace: string) => DatafnStorageAdapter`.
  - When `namespace` config is provided, the factory is called with the namespace string.
  - When legacy `authContext` is used, the factory is called with the `AuthContext` object (backward compat — detected by checking config).
  - TypeScript types are union-compatible to avoid breaking existing code during transition.
- **Test vectors**: TV-NS-018, TV-NS-019
- **Notes**: The factory receives the raw namespace string. If users need to parse it, they manage that themselves.

---

## NS-009: `IndexedDbStorageAdapter.createForNamespace()`

- **Priority**: P0
- **Statement**: `IndexedDbStorageAdapter` MUST provide a `createForNamespace(baseDbName, namespace, resources?, schema?)` static factory.
- **Rationale**: Convenience factory that constructs a database name from a namespace string.
- **Acceptance criteria**:
  - Static method on `IndexedDbStorageAdapter`.
  - Database name = `{baseDbName}_{sanitizedNamespace}` where `:` in namespace is replaced with `_`.
  - `createForUser` remains (deprecated).
  - Derived resources from schema if not provided (existing behavior).
- **Test vectors**: TV-NS-020, TV-NS-021
- **Notes**: Namespace sanitization for IDB name: replace `:` with `_`. Other characters are left as-is (IDB allows most characters in database names).

---

## NS-010: `MemoryStorageAdapter` namespace support

- **Priority**: P0
- **Statement**: `MemoryStorageAdapter` MUST continue to work without requiring namespace configuration (it stores data in-memory, isolation is implicit per instance).
- **Rationale**: Memory adapter doesn't need namespace in construction — each instance is already isolated. But it should be usable as a factory target.
- **Acceptance criteria**:
  - `MemoryStorageAdapter` constructor remains unchanged.
  - Can be used in a namespace factory: `(ns) => new MemoryStorageAdapter(schema)`.
  - No behavioral changes.
- **Test vectors**: TV-NS-022
- **Notes**: Trivial — confirming no breakage.

---

## NS-011: `SwitchContextOverride.namespace`

- **Priority**: P0
- **Statement**: `SwitchContextOverride` MUST accept a `namespace?: string` field, replacing `authContext`.
- **Rationale**: `switchContext()` should accept the same namespace primitive as initial config.
- **Acceptance criteria**:
  - `namespace?: string` added to `SwitchContextOverride`.
  - `authContext` remains (deprecated).
  - When `namespace` is provided, it is used for the new client instance.
  - When `authContext` is provided (legacy), namespace is derived from it.
  - `switchContext({ namespace: "new-ns" })` triggers: destroy old client → create new client with new namespace → resolve storage factory with new namespace.
- **Test vectors**: TV-NS-023, TV-NS-024
- **Notes**: None.

---

## NS-012: `currentNamespace()` replaces `currentContext()`

- **Priority**: P0
- **Statement**: `DatafnClient` MUST expose a `currentNamespace(): string | undefined` method.
- **Rationale**: Consumers need to inspect the active namespace (e.g. for display, debugging).
- **Acceptance criteria**:
  - `currentNamespace()` returns the resolved namespace string.
  - Returns `undefined` when no namespace is configured.
  - `currentContext()` remains (deprecated), returns `AuthContext | undefined` for legacy compat.
  - Both methods are available on the proxy.
- **Test vectors**: TV-NS-025
- **Notes**: None.

---

## NS-013: Cross-tab BroadcastChannel uses `namespace`

- **Priority**: P0
- **Statement**: The `CrossTabRelay` MUST construct its `BroadcastChannel` name using the client's resolved namespace.
- **Rationale**: Cross-tab events must be scoped to the same namespace to prevent data leakage.
- **Acceptance criteria**:
  - Channel name format: `datafn:{namespace}`.
  - When namespace is `undefined`, cross-tab relay SHOULD use `datafn:default` or disable.
  - Events from different namespaces MUST NOT leak across channels.
- **Test vectors**: TV-NS-026
- **Notes**: Current behavior already uses a namespace-derived channel name. This requirement ensures continuity.

---

## NS-014: Changelog `actorId` replaces `userId`

- **Priority**: P1
- **Statement**: `DatafnChangelogEntry` MUST add an `actorId?: string` field for audit attribution, replacing `userId`.
- **Rationale**: Separates audit attribution from namespace isolation. "Actor" is generic — could be a user, API key, service account, etc.
- **Acceptance criteria**:
  - `actorId?: string` added to `DatafnChangelogEntry`.
  - `userId?: string` remains (deprecated).
  - When writing changelog entries, `actorId` is populated from `namespaceProvider.getActorId()` on server or from config on client.
  - When reading, both `actorId` and `userId` are available (for old entries, `userId` may be set but `actorId` may not).
- **Test vectors**: TV-NS-027, TV-NS-028
- **Notes**: Old changelog entries with `userId` remain valid. New entries write `actorId` (and `userId` for compat during transition).

---

## NS-015: Server `actorId` extraction

- **Priority**: P0
- **Statement**: The server MUST extract `actorId` from `namespaceProvider.getActorId(ctx)` when available, for use in change tracking and audit.
- **Rationale**: Actor ID is distinct from namespace — who did it vs. where it's stored.
- **Acceptance criteria**:
  - When `namespaceProvider.getActorId` is configured, it is called per-request.
  - The result is passed to change tracking service for changelog stamping.
  - When not configured, `actorId` is `undefined` (no audit attribution).
  - Legacy bridge: `authContextProvider` → `actorId = authContext.userId`.
  - `actorId` errors are logged but do not fail the request (best-effort attribution).
- **Test vectors**: TV-NS-029
- **Notes**: Actor ID failures are non-fatal. Namespace failures ARE fatal (INV-004).

---

## NS-016: CLI codegen respects `namespaced`

- **Priority**: P0
- **Statement**: The Drizzle codegen MUST check `schema.namespaced !== false` (with fallback to `schema.multiTenant !== false`) when deciding whether to emit the `__ns` column.
- **Rationale**: CLI must honor the renamed schema field.
- **Acceptance criteria**:
  - When `namespaced` is present, use it.
  - When only `multiTenant` is present, use it.
  - When neither is present, default to `true` (emit `__ns`).
  - Generated code is identical regardless of which field name is used (same boolean value → same output).
- **Test vectors**: TV-NS-030, TV-NS-031
- **Notes**: No change to generated SQL or Drizzle schema shape.

---

## NS-017: `defineSchema()` accepts `namespaced`

- **Priority**: P0
- **Statement**: The `defineSchema()` type-safe helper MUST accept `namespaced?: boolean` in its generic constraint.
- **Rationale**: Users of the helper should be able to use the new field name.
- **Acceptance criteria**:
  - `defineSchema({ resources: [...], namespaced: true })` compiles.
  - `defineSchema({ resources: [...], multiTenant: true })` continues to compile.
  - Both produce valid `DatafnSchema` objects.
- **Test vectors**: TV-NS-032
- **Notes**: Type change only — `defineSchema` is a pass-through at runtime.

---

## NS-018: Deprecation warnings

- **Priority**: P1
- **Statement**: Usage of deprecated APIs MUST emit warnings at appropriate points.
- **Rationale**: Guides users toward the new API without breaking existing code.
- **Acceptance criteria**:
  - Server startup with `authContextProvider` (no `namespaceProvider`): logs once `"[datafn] authContextProvider is deprecated. Use namespaceProvider instead."`.
  - Schema validation with `multiTenant` (no `namespaced`): logs once `"[datafn] multiTenant is deprecated. Use namespaced instead."`.
  - Client creation with `authContext` (no `namespace`): logs `console.warn` once.
  - Warnings use `console.warn` on client, logger on server.
  - Each warning fires at most once per process/client lifetime.
- **Test vectors**: TV-NS-033
- **Notes**: Warnings SHOULD NOT appear in test output by default. Test vectors verify behavior, not console output.

---

## NS-019: Client namespace resolution for storage factory

- **Priority**: P0
- **Statement**: When `storage` is a factory function, the client MUST resolve the namespace and pass it to the factory.
- **Rationale**: The factory needs the namespace to create isolated storage.
- **Acceptance criteria**:
  - When `namespace` is provided: factory called with `namespace` string.
  - When `authContext` is provided (legacy): factory called with `AuthContext` object.
  - When neither is provided and storage is a factory: throws `DFQL_INVALID` with message `"namespace is required when storage is a factory function"`.
  - Direct `DatafnStorageAdapter` instances bypass this entirely.
- **Test vectors**: TV-NS-034, TV-NS-035
- **Notes**: None.

---

## NS-020: Client re-exports updated types

- **Priority**: P0
- **Statement**: `@datafn/client` MUST re-export the `ns` function from `@datafn/core`.
- **Rationale**: Convenience — client users should be able to import `ns` from `@datafn/client`.
- **Acceptance criteria**:
  - `export { ns } from "@datafn/core"` in client entry point.
  - Existing re-exports of `AuthContext`, `AuthContextProvider` remain (deprecated).
- **Test vectors**: N/A (import verification)
- **Notes**: None.

---

## NS-021: WS auth context uses namespace string directly

- **Priority**: P0
- **Statement**: `WsAuthContext` MUST continue to use `namespace: string`. The namespace passed to `addClient()` MUST come from the resolved namespace provider.
- **Rationale**: WS already uses `namespace: string` — this requirement confirms alignment.
- **Acceptance criteria**:
  - `WsAuthContext` type unchanged (`{ namespace: string }`).
  - The namespace passed to `wsManager.addClient()` is derived from `namespaceProvider` (or legacy bridge).
  - WS broadcast scoping is namespace-based (unchanged).
- **Test vectors**: TV-NS-036
- **Notes**: WS was already correct. This requirement ensures no regression.

---

## NS-022: Empty namespace validation

- **Priority**: P0
- **Statement**: Empty namespace strings MUST be rejected with a clear error.
- **Rationale**: An empty namespace would bypass isolation, creating a security hole.
- **Acceptance criteria**:
  - Server: `namespaceProvider.getNamespace()` returning `""` triggers `NAMESPACE_INVALID` error response (400).
  - Server: `namespaceProvider.getNamespace()` returning a non-string triggers `NAMESPACE_INVALID` error response.
  - Client: `namespace: ""` in config throws `DFQL_INVALID` during client creation.
  - `ns()` with all empty segments throws `Error`.
- **Test vectors**: TV-NS-037, TV-NS-038, TV-NS-039
- **Notes**: `null` and `undefined` are handled by the type system; this is about runtime validation of empty strings.

---

## NS-023: Client `SyncEngine` / transport uses `namespace`

- **Priority**: P0
- **Statement**: The client `SyncEngine` and WS transport MUST use the resolved `namespace` string for WS hello messages and cursor scoping.
- **Rationale**: Sync operations must be namespace-aware on the client side.
- **Acceptance criteria**:
  - WS `hello` message includes the namespace (already does — confirm no regression).
  - SyncEngine constructs change tracking with the client namespace.
  - Pull/push requests are scoped to the client's namespace (server-side enforcement; client doesn't send namespace in request body).
- **Test vectors**: TV-NS-040
- **Notes**: The client doesn't send namespace in HTTP request bodies — the server derives it from the provider. The client namespace is used only for local concerns (storage, WS, cross-tab).

# TEST VECTORS

## TV-NS-001: `ns()` with two segments

- **Description**: Compose namespace from two segments.
- **Input**: `ns("org-acme", "user-123")`
- **Expected output**: `"org-acme:user-123"`

## TV-NS-002: `ns()` with single segment

- **Description**: Single segment returns as-is (no trailing colon).
- **Input**: `ns("user-1")`
- **Expected output**: `"user-1"`

## TV-NS-003: `ns()` with empty/falsy segments filtered

- **Description**: Empty strings are filtered out.
- **Input**: `ns("org", "", "user")`
- **Expected output**: `"org:user"`

**Negative variant**:
- **Input**: `ns("", "")`
- **Expected error**: `Error` thrown with message containing "at least one non-empty segment"

## TV-NS-004: Schema with `namespaced: true`

- **Description**: `namespaced` field is recognized during schema validation.
- **Input**:
  ```json
  {
    "resources": [{ "name": "todos", "version": 1, "fields": [{ "name": "title", "type": "string", "required": true }] }],
    "namespaced": true
  }
  ```
- **Expected output**: Schema validation succeeds. `schema.namespaced === true`. Codegen emits `__ns` column.

## TV-NS-005: Schema with `namespaced: false`

- **Description**: Disabling namespace isolation via new field.
- **Input**:
  ```json
  {
    "resources": [{ "name": "todos", "version": 1, "fields": [{ "name": "title", "type": "string", "required": true }] }],
    "namespaced": false
  }
  ```
- **Expected output**: Schema validation succeeds. Codegen does NOT emit `__ns` column.

## TV-NS-006: Schema with both `namespaced` and `multiTenant`

- **Description**: `namespaced` takes precedence.
- **Input**:
  ```json
  {
    "resources": [{ "name": "todos", "version": 1, "fields": [] }],
    "namespaced": false,
    "multiTenant": true
  }
  ```
- **Expected output**: Namespace isolation is DISABLED (`namespaced: false` wins). Deprecation warning emitted for `multiTenant`.

## TV-NS-007: Server with `namespaceProvider`

- **Description**: Server configured with namespace provider resolves namespace correctly.
- **Input**:
  ```typescript
  createDatafnServer({
    schema,
    db,
    namespaceProvider: {
      getNamespace: (ctx) => ns(ctx.orgId, ctx.userId),
    },
  })
  ```
  Request context: `{ orgId: "acme", userId: "u1" }`
- **Expected output**: All CRUD operations use namespace `"acme:u1"`. `__ns` column = `"acme:u1"`.

## TV-NS-008: Server with both `namespaceProvider` and `authContextProvider`

- **Description**: `namespaceProvider` takes precedence.
- **Input**:
  ```typescript
  createDatafnServer({
    schema,
    db,
    namespaceProvider: { getNamespace: () => "custom-ns" },
    authContextProvider: { getContext: () => ({ userId: "u1", tenantId: "t1" }) },
  })
  ```
- **Expected output**: Namespace = `"custom-ns"` (not `"tenant:t1:user:u1"`).

## TV-NS-009: `extractNamespace` with `namespaceProvider`

- **Description**: Direct namespace resolution.
- **Input**: `namespaceProvider.getNamespace(ctx)` returns `"workspace:ws-42"`
- **Expected output**: `extractNamespace(ctx)` returns `"workspace:ws-42"`.

## TV-NS-010: `extractNamespace` rejects empty namespace

- **Description**: Empty string from provider is rejected.
- **Input**: `namespaceProvider.getNamespace(ctx)` returns `""`
- **Expected output**: Response with `{ ok: false, error: { code: "NAMESPACE_INVALID", message: "Namespace provider returned empty namespace" } }`, HTTP 400.

## TV-NS-011: `extractNamespace` propagates provider errors

- **Description**: Provider throwing is propagated, not swallowed.
- **Input**: `namespaceProvider.getNamespace(ctx)` throws `new Error("auth expired")`
- **Expected output**: Error propagated. HTTP 500 or appropriate error response. No fallback to `"datafn"`.

## TV-NS-012: Legacy bridge — tenant + user

- **Description**: `authContextProvider` produces same namespace as current behavior.
- **Input**:
  ```typescript
  authContextProvider: { getContext: () => ({ userId: "u1", tenantId: "t1" }) }
  ```
- **Expected output**: Namespace = `"tenant:t1:user:u1"`.

## TV-NS-013: Legacy bridge — user only

- **Description**: `authContextProvider` without tenant.
- **Input**:
  ```typescript
  authContextProvider: { getContext: () => ({ userId: "u1" }) }
  ```
- **Expected output**: Namespace = `"user:u1"`.

## TV-NS-014: Legacy bridge — empty userId fallback

- **Description**: Empty userId falls back to default.
- **Input**:
  ```typescript
  authContextProvider: { getContext: () => ({ userId: "" }) }
  ```
- **Expected output**: Namespace = `"datafn"`. Warning logged.

## TV-NS-015: Rate limit key uses namespace

- **Description**: Default rate limit key extractor returns namespace.
- **Input**: `namespaceProvider.getNamespace(ctx)` returns `"org:u1"`
- **Expected output**: Rate limit key = `"org:u1"`.

## TV-NS-016: Client with `namespace` config

- **Description**: Client uses `namespace` for storage factory.
- **Input**:
  ```typescript
  createDatafnClient({
    schema,
    clientId: "dev1",
    namespace: "org:user-1",
    storage: (ns) => new MemoryStorageAdapter(schema),
  })
  ```
- **Expected output**: Factory called with `"org:user-1"`. Client created successfully.

## TV-NS-017: Client with `namespace` and `authContext` — namespace wins

- **Description**: `namespace` takes precedence over `authContext`.
- **Input**:
  ```typescript
  createDatafnClient({
    schema,
    clientId: "dev1",
    namespace: "custom-ns",
    authContext: { userId: "u1", tenantId: "t1" },
    storage: (ns) => new MemoryStorageAdapter(schema),
  })
  ```
- **Expected output**: Factory called with `"custom-ns"`. `currentNamespace()` returns `"custom-ns"`.

## TV-NS-018: `DatafnStorageFactory` with namespace string

- **Description**: New factory signature receives string.
- **Input**: `storage: (ns: string) => ...`, `namespace: "my-ns"`
- **Expected output**: Factory invoked with `"my-ns"`.

## TV-NS-019: `DatafnStorageFactory` legacy with AuthContext

- **Description**: Legacy factory receives AuthContext when `authContext` is used.
- **Input**: `storage: (ctx: AuthContext) => ...`, `authContext: { userId: "u1" }`
- **Expected output**: Factory invoked with `{ userId: "u1" }`.

## TV-NS-020: `IndexedDbStorageAdapter.createForNamespace()`

- **Description**: Creates adapter with sanitized namespace in DB name.
- **Input**: `IndexedDbStorageAdapter.createForNamespace("app", "org:user-1")`
- **Expected output**: IDB database name = `"app_org_user-1"` (`:` replaced with `_`).

## TV-NS-021: `IndexedDbStorageAdapter.createForNamespace()` simple namespace

- **Description**: Simple namespace without colons.
- **Input**: `IndexedDbStorageAdapter.createForNamespace("app", "user-1")`
- **Expected output**: IDB database name = `"app_user-1"`.

## TV-NS-022: `MemoryStorageAdapter` in namespace factory

- **Description**: Memory adapter works as factory target.
- **Input**: `storage: (ns) => new MemoryStorageAdapter(schema)`, `namespace: "any"`
- **Expected output**: Client created successfully. Storage is a fresh MemoryStorageAdapter.

## TV-NS-023: `switchContext` with `namespace`

- **Description**: Switch context using new namespace field.
- **Input**:
  ```typescript
  client.switchContext({ namespace: "new-org:new-user" })
  ```
- **Expected output**: `currentNamespace()` returns `"new-org:new-user"`. New storage factory called with `"new-org:new-user"`.

## TV-NS-024: `switchContext` with legacy `authContext`

- **Description**: Legacy switch context still works.
- **Input**:
  ```typescript
  client.switchContext({ authContext: { userId: "u2", tenantId: "t2" } })
  ```
- **Expected output**: `currentContext()` returns `{ userId: "u2", tenantId: "t2" }`. Namespace derived as `"t2_u2"` for storage.

## TV-NS-025: `currentNamespace()` returns resolved namespace

- **Description**: New method returns the active namespace.
- **Input**: Client created with `namespace: "workspace:123"`
- **Expected output**: `client.currentNamespace()` returns `"workspace:123"`.

**Negative variant**:
- **Input**: Client created without `namespace` or `authContext`.
- **Expected output**: `client.currentNamespace()` returns `undefined`.

## TV-NS-026: Cross-tab BroadcastChannel scoped by namespace

- **Description**: Channel name includes namespace for isolation.
- **Input**: Client with `namespace: "org:u1"`, `crossTab: true`
- **Expected output**: BroadcastChannel created with name `"datafn:org:u1"`.

## TV-NS-027: Changelog entry with `actorId`

- **Description**: New changelog entries include `actorId`.
- **Input**: Mutation performed with `namespaceProvider.getActorId()` returning `"user-42"`
- **Expected output**: `DatafnChangelogEntry.actorId === "user-42"`.

## TV-NS-028: Changelog entry legacy `userId` compat

- **Description**: Old entries with `userId` remain readable.
- **Input**: Existing changelog entry `{ seq: 1, clientId: "c1", mutationId: "m1", userId: "u1", ... }`
- **Expected output**: Entry readable. `userId` field accessible. `actorId` is `undefined`.

## TV-NS-029: Server `actorId` extraction

- **Description**: `getActorId()` result passed to change tracking.
- **Input**: `namespaceProvider: { getNamespace: () => "ns1", getActorId: () => "actor-7" }`
- **Expected output**: Change entries stamped with `actorId: "actor-7"`.

**Negative variant (non-fatal)**:
- **Input**: `getActorId()` throws
- **Expected output**: Request succeeds. `actorId` is `undefined`. Warning logged.

## TV-NS-030: CLI codegen with `namespaced: true`

- **Description**: Drizzle codegen emits `__ns` column.
- **Input**: Schema with `namespaced: true`
- **Expected output**: Generated code includes `__ns: text("__ns").notNull()`, composite primary key with `__ns`, and index on `__ns`.

## TV-NS-031: CLI codegen with `namespaced: false`

- **Description**: Drizzle codegen omits `__ns` column.
- **Input**: Schema with `namespaced: false`
- **Expected output**: Generated code does NOT include `__ns` column. Primary key is `id` only.

## TV-NS-032: `defineSchema()` with `namespaced`

- **Description**: Type-safe helper accepts new field.
- **Input**:
  ```typescript
  defineSchema({
    resources: [{ name: "todos", version: 1, fields: [{ name: "title", type: "string" as const, required: true }] }],
    namespaced: true,
  })
  ```
- **Expected output**: Compiles without error. Returns valid `DatafnSchema`.

## TV-NS-033: Deprecation warnings

- **Description**: Legacy API usage emits warnings.
- **Input**: Server with `authContextProvider`, schema with `multiTenant`, client with `authContext`.
- **Expected output**: Three separate deprecation warnings emitted (one each). Each fires at most once.

## TV-NS-034: Client factory without namespace throws

- **Description**: Factory requires namespace.
- **Input**:
  ```typescript
  createDatafnClient({
    schema,
    clientId: "dev1",
    storage: (ns) => new MemoryStorageAdapter(schema),
    // no namespace, no authContext
  })
  ```
- **Expected output**: Throws `DFQL_INVALID` error: `"namespace is required when storage is a factory function"`.

## TV-NS-035: Client factory with namespace resolves correctly

- **Description**: Factory receives namespace.
- **Input**: `namespace: "test-ns"`, `storage: (ns) => ...`
- **Expected output**: Factory called with `"test-ns"`.

## TV-NS-036: WS addClient uses provider namespace

- **Description**: WS namespace comes from provider.
- **Input**: `namespaceProvider.getNamespace()` returns `"ws-ns-1"`
- **Expected output**: `wsManager.addClient(client, { namespace: "ws-ns-1" })` called. Client receives broadcast only for `"ws-ns-1"` namespace.

## TV-NS-037: Empty namespace rejected on server

- **Description**: Server rejects empty namespace.
- **Input**: `namespaceProvider.getNamespace()` returns `""`
- **Expected output**: HTTP 400, `{ ok: false, error: { code: "NAMESPACE_INVALID" } }`.

## TV-NS-038: Empty namespace rejected on client

- **Description**: Client rejects empty namespace.
- **Input**: `createDatafnClient({ ..., namespace: "" })`
- **Expected output**: Throws `DFQL_INVALID`.

## TV-NS-039: `ns()` all empty throws

- **Description**: No valid segments.
- **Input**: `ns("")`
- **Expected output**: `Error` thrown.

## TV-NS-040: Client SyncEngine namespace scoping

- **Description**: Sync engine uses resolved namespace for WS hello.
- **Input**: Client with `namespace: "sync-ns"`, `sync.ws: true`
- **Expected output**: WS hello message includes namespace field. Pull/push operations scoped correctly.

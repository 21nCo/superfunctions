# TEST VECTORS

## TV-REM-001: `DatafnSchema` no longer accepts `multiTenant`

- **Description**: Schema type only accepts `namespaced`, not `multiTenant`.
- **Input**: `{ resources: [{ name: "r", version: 1, fields: [] }], multiTenant: true }`
- **Expected output**: TypeScript compile error (excess property).
- **Positive variant**: `{ resources: [...], namespaced: true }` compiles.

---

## TV-REM-002: `defineSchema()` rejects `multiTenant`

- **Description**: Type-safe helper no longer accepts `multiTenant` in its generic constraint.
- **Input**:
  ```typescript
  defineSchema({ resources: [{ name: "r", version: 1, fields: [] }], multiTenant: true });
  ```
- **Expected output**: TypeScript compile error.
- **Positive variant**:
  ```typescript
  defineSchema({ resources: [{ name: "r", version: 1, fields: [] }], namespaced: true });
  ```
  Compiles and returns valid `DatafnSchema`.

---

## TV-REM-003: `validateSchema` ignores `multiTenant`

- **Description**: Validated schema output has `namespaced` but not `multiTenant`.
- **Input**:
  ```json
  { "resources": [{ "name": "r", "version": 1, "fields": [] }] }
  ```
- **Expected output**:
  ```json
  {
    "ok": true,
    "result": {
      "resources": [{ "name": "r", "version": 1, "fields": [], "indices": { "base": [], "search": [], "vector": [] } }],
      "relations": [],
      "namespaced": true
    }
  }
  ```
- **Negative variant**: Output does NOT contain `"multiTenant"` key.

---

## TV-REM-004: `isNamespaced` only checks `namespaced`

- **Description**: Helper function uses only `namespaced`, no `multiTenant` fallback.
- **Input**: `{ resources: [], namespaced: false }`
- **Expected output**: `false`
- **Input**: `{ resources: [] }`
- **Expected output**: `true` (default)
- **Negative variant**: `{ resources: [], multiTenant: true }` → `true` (because `namespaced` defaults to `true` — the `multiTenant` field is ignored, not read).

---

## TV-REM-005: Server rejects `authContextProvider`

- **Description**: `createDatafnServer` does not accept `authContextProvider`.
- **Input**:
  ```typescript
  createDatafnServer({
    schema,
    db: adapter,
    authContextProvider: { getContext: (ctx) => ({ userId: "u1" }) },
  });
  ```
- **Expected output**: TypeScript compile error.
- **Positive variant**:
  ```typescript
  createDatafnServer({
    schema,
    db: adapter,
    namespaceProvider: { getNamespace: (ctx) => "u1" },
  });
  ```
  Succeeds.

---

## TV-REM-006: `extractNamespace` — no legacy bridge

- **Description**: Without `namespaceProvider`, returns `"datafn"` directly. No `authContextProvider` fallback.
- **Input**: Server with no `namespaceProvider` configured, any request context.
- **Expected output**: `"datafn"`.
- **Positive variant**: Server with `namespaceProvider: { getNamespace: () => "custom" }` → `"custom"`.
- **Negative variant**: `namespaceProvider.getNamespace()` returning `""` → throws `NAMESPACE_INVALID`.

---

## TV-REM-007: `extractActorId` — no legacy bridge

- **Description**: Without `namespaceProvider.getActorId`, returns `undefined` directly.
- **Input**: Server with `namespaceProvider: { getNamespace: () => "ns" }` (no `getActorId`).
- **Expected output**: `undefined`.
- **Positive variant**: `namespaceProvider: { getNamespace: () => "ns", getActorId: () => "actor-1" }` → `"actor-1"`.

---

## TV-REM-008: Rate limit key — no legacy bridge

- **Description**: Default key extractor uses `namespaceProvider` only.
- **Input**: Server with no `namespaceProvider`, rate limiting enabled.
- **Expected output**: Rate limit key = `"anonymous"`.
- **Positive variant**: `namespaceProvider.getNamespace()` returns `"org:user"` → rate limit key = `"org:user"`.

---

## TV-REM-009: Client rejects `authContext`

- **Description**: `createDatafnClient` does not accept `authContext`.
- **Input**:
  ```typescript
  createDatafnClient({
    schema,
    clientId: "c1",
    authContext: { userId: "u1" },
    storage: new MemoryStorageAdapter(),
  });
  ```
- **Expected output**: TypeScript compile error.
- **Positive variant**:
  ```typescript
  createDatafnClient({
    schema,
    clientId: "c1",
    namespace: "u1",
    storage: (ns) => new MemoryStorageAdapter(),
  });
  ```
  Succeeds.

---

## TV-REM-010: Client storage factory — namespace only

- **Description**: Storage factory is called with namespace string, never `AuthContext`.
- **Input**:
  ```typescript
  let receivedArg: unknown;
  createDatafnClient({
    schema,
    clientId: "c1",
    namespace: "org:user",
    storage: (ns) => { receivedArg = ns; return new MemoryStorageAdapter(); },
  });
  ```
- **Expected output**: `receivedArg === "org:user"` (string, not object).
- **Negative variant**: Storage is factory but no `namespace` → throws `DFQL_INVALID`.

---

## TV-REM-011: `currentContext()` does not exist

- **Description**: `DatafnClient` does not expose `currentContext()`.
- **Input**: `client.currentContext()`
- **Expected output**: TypeScript compile error (property does not exist).
- **Positive variant**: `client.currentNamespace()` returns `string | undefined`.

---

## TV-REM-012: `SwitchContextOverride` rejects `authContext`

- **Description**: `switchContext` does not accept `authContext` in override.
- **Input**:
  ```typescript
  client.switchContext({ authContext: { userId: "u1" } });
  ```
- **Expected output**: TypeScript compile error.
- **Positive variant**: `client.switchContext({ namespace: "new-ns" })` succeeds.

---

## TV-REM-013: `DatafnStorageFactory` type — string only

- **Description**: Factory type accepts only `string`, not `AuthContext`.
- **Input**:
  ```typescript
  const factory: DatafnStorageFactory = (ns: string) => new MemoryStorageAdapter();
  ```
- **Expected output**: Compiles.
- **Negative variant**:
  ```typescript
  const factory: DatafnStorageFactory = (ctx: { userId: string }) => new MemoryStorageAdapter();
  ```
  TypeScript compile error.

---

## TV-REM-014: `DatafnChangelogEntry` has no `userId`

- **Description**: Changelog entry type only has `actorId`, not `userId`.
- **Input**: `const entry: DatafnChangelogEntry = { seq: 1, clientId: "c1", mutationId: "m1", mutation: {}, timestampMs: 0, userId: "u1" };`
- **Expected output**: TypeScript compile error (excess property `userId`).
- **Positive variant**: `{ ..., actorId: "u1" }` compiles.

---

## TV-REM-015: `createForUser` does not exist

- **Description**: `IndexedDbStorageAdapter.createForUser` is removed.
- **Input**: `IndexedDbStorageAdapter.createForUser("db", "user-1")`
- **Expected output**: TypeScript compile error (property does not exist).
- **Positive variant**: `IndexedDbStorageAdapter.createForNamespace("db", "user-1")` succeeds.

---

## TV-REM-016: CLI codegen uses `isNamespaced` variable name

- **Description**: The drizzle codegen source uses `isNamespaced` variable, not `isMultiTenant`.
- **Input**: `grep "isMultiTenant" datafn/cli/src/drizzle-codegen.ts`
- **Expected output**: No matches.
- **Positive variant**: `grep "isNamespaced" datafn/cli/src/drizzle-codegen.ts` → multiple matches.

---

## TV-REM-017: `validateSchema` output has no `multiTenant` key

- **Description**: Normalized schema from `validateSchema` does not include `multiTenant`.
- **Input**: `validateSchema({ resources: [{ name: "r", version: 1, fields: [] }] })`
- **Expected output**:
  ```typescript
  result.namespaced === true
  "multiTenant" in result === false
  ```

---

## TV-RST-001: DFQL sidebar includes schema sub-topics

- **Description**: After restructuring, the DFQL section in the sidebar includes schema, resources, fields, relations, and system-fields.
- **Input**: `cat datafn/docs/content/docs/dfql/meta.json`
- **Expected output**: `pages` array contains `"schema"`, `"resources"`, `"fields"`, `"relations"`, `"system-fields"` (in addition to existing DFQL pages).
- **Negative variant**: `cat datafn/docs/content/docs/documentation/concepts/meta.json` — `pages` does NOT contain `"schema"`, `"resources"`, `"fields"`, `"relations"`, `"system-fields"`.

---

## TV-RST-002: Concepts overview page exists

- **Description**: A concepts overview page exists and covers all core concepts at a high level.
- **Input**: `cat datafn/docs/content/docs/documentation/concepts/overview.mdx`
- **Expected output**: File exists, contains sections on DFQL, Client, Server, Framework Libraries, Sync.
- **Negative variant**: `cat datafn/docs/content/docs/documentation/concepts/schema.mdx` — file does NOT exist (moved to dfql/).

---

## TV-LNK-001: Client queries doc cross-links to DFQL

- **Description**: The client queries doc contains links to DFQL filter, sort, select, and pagination pages.
- **Input**: `grep -c "dfql/filters\|dfql/sorting\|dfql/pagination\|dfql/select" datafn/docs/content/docs/documentation/client/queries.mdx`
- **Expected output**: At least 4 matches (one per DFQL page linked).

---

## TV-DIA-001: System architecture diagram on home page

- **Description**: The docs home page contains a mermaid diagram.
- **Input**: `grep "mermaid" datafn/docs/content/docs/index.mdx`
- **Expected output**: At least one match.

---

## TV-PY-001: Python sidebar removed

- **Description**: The top-level meta.json does not include Python in its pages.
- **Input**: `cat datafn/docs/content/docs/meta.json`
- **Expected output**: `pages` array does NOT contain `"python"`.
- **Positive variant**: `grep "Tabs" datafn/docs/content/docs/documentation/server/setup.mdx` returns at least one match (tabbed code blocks present).

---

## TV-PY-002: Python examples in server docs via tabs

- **Description**: Server setup docs contain Python examples in tabbed code blocks.
- **Input**: `grep -c "Python" datafn/docs/content/docs/documentation/server/setup.mdx`
- **Expected output**: At least 2 matches (tab label + code examples).

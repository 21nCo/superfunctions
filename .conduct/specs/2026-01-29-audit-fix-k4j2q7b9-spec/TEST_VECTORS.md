# Test Vectors

All vectors are written to be implementable as Vitest tests in `@datafn/server` and `@datafn/client`.

---

## TV-CLONEUP-001

**Description:** Server clone up inserts new records and returns a cursor.

**Preconditions:**

- Fresh server instance with an empty database.
- Schema contains resource `task` with writable field `title`.
- No prior change tracking entries exist for the namespace.

**Input (HTTP):**

`POST /datafn/cloneup`

```json
{
  "clientId": "client:device-1",
  "resource": "task",
  "records": [
    { "id": "task:1", "title": "one" },
    { "id": "task:2", "title": "two" }
  ]
}
```

**Expected output (HTTP 200):**

```json
{
  "ok": true,
  "result": {
    "ok": true,
    "resource": "task",
    "inserted": ["task:1", "task:2"],
    "updated": [],
    "skipped": [],
    "errors": [],
    "cursor": "2"
  }
}
```

**Negative variant:** See TV-CLONEUP-005 / TV-CLONEUP-006.

---

## TV-CLONEUP-002

**Description:** Server clone up partially applies valid records and reports per-record errors.

**Preconditions:** Fresh server (same as TV-CLONEUP-001).

**Input (HTTP):**

```json
{
  "clientId": "client:device-1",
  "resource": "task",
  "records": [
    { "id": "task:1", "title": "ok" },
    { "id": "task:2", "unknownField": "nope" },
    { "title": "missing id" }
  ]
}
```

**Expected output (HTTP 200):**

```json
{
  "ok": true,
  "result": {
    "ok": true,
    "resource": "task",
    "inserted": ["task:1"],
    "updated": [],
    "skipped": [],
    "errors": [
      {
        "id": "",
        "code": "DFQL_INVALID",
        "message": "Invalid DFQL: record.id must be string",
        "path": "records[2].id"
      },
      {
        "id": "task:2",
        "code": "DFQL_UNKNOWN_FIELD",
        "message": "Unknown field: unknownField on task",
        "path": "records[1].unknownField"
      }
    ],
    "cursor": "1"
  }
}
```

**Negative variant:** If the server instead rejects the entire request due to a record error, that violates CLONEUP-003.

---

## TV-CLONEUP-003

**Description:** Server clone up is idempotent by content; repeating identical uploads skips without advancing cursor.

**Preconditions:**

- Execute TV-CLONEUP-001 first (so `task:1` and `task:2` exist and cursor is `2`).

**Input (HTTP):** Same request as TV-CLONEUP-001.

**Expected output (HTTP 200):**

```json
{
  "ok": true,
  "result": {
    "ok": true,
    "resource": "task",
    "inserted": [],
    "updated": [],
    "skipped": ["task:1", "task:2"],
    "errors": [],
    "cursor": "2"
  }
}
```

**Negative variant:** If `cursor` becomes `3` or greater with no content changes, idempotency is violated (CLONEUP-004/005).

---

## TV-CLONEUP-004

**Description:** Server clone up updates an existing record and advances cursor.

**Preconditions:** Execute TV-CLONEUP-001 first.

**Input (HTTP):**

```json
{
  "clientId": "client:device-1",
  "resource": "task",
  "records": [
    { "id": "task:2", "title": "two (edited)" }
  ]
}
```

**Expected output (HTTP 200):**

```json
{
  "ok": true,
  "result": {
    "ok": true,
    "resource": "task",
    "inserted": [],
    "updated": ["task:2"],
    "skipped": [],
    "errors": [],
    "cursor": "3"
  }
}
```

**Negative variant:** If `task:2` is reported as `inserted`, upsert semantics are violated.

---

## TV-CLONEUP-005

**Description:** Server rejects invalid `clientId` at request level.

**Input (HTTP):**

```json
{
  "clientId": 123,
  "resource": "task",
  "records": []
}
```

**Expected output (HTTP 400):**

```json
{
  "ok": false,
  "error": {
    "code": "DFQL_INVALID",
    "message": "Invalid DFQL: clientId must be string",
    "details": { "path": "clientId" }
  }
}
```

---

## TV-CLONEUP-006

**Description:** Server rejects unknown resource at request level.

**Input (HTTP):**

```json
{
  "clientId": "client:device-1",
  "resource": "does_not_exist",
  "records": []
}
```

**Expected output (HTTP 400):**

```json
{
  "ok": false,
  "error": {
    "code": "DFQL_UNKNOWN_RESOURCE",
    "message": "Unknown resource: does_not_exist",
    "details": { "path": "resource" }
  }
}
```

---

## TV-CLONEUP-007

**Description:** Server `beforeSync` / `afterSync` hooks observe clone up with phase `"cloneup"`.

**Preconditions:**

- Server configured with a plugin:
  - `beforeSync(ctx, phase, payload)` asserts `phase === "cloneup"` and transforms payload by dropping one record.
  - `afterSync(ctx, phase, payload, result)` asserts `phase === "cloneup"`.

**Input:** Same as TV-CLONEUP-001.

**Expected output:**

- Hook assertions pass.
- Response indicates only one record inserted (because plugin dropped the other).

**Negative variant:** If `beforeSync` throws `{ code: "DFQL_INVALID", message: "no" }`, server returns `{ ok: false, error.code = "DFQL_INVALID" }`.

---

## TV-CLONEUP-008

**Description:** Authorization denies clone up.

**Preconditions:** Server configured with `authorize(ctx, action, payload)` returning `false` when `action === "cloneup"`.

**Input:** Any valid clone up request.

**Expected output (HTTP 403):**

```json
{
  "ok": false,
  "error": {
    "code": "FORBIDDEN",
    "message": "Authorization denied",
    "details": { "path": "$" }
  }
}
```

**Negative variant:** Invalid JSON still returns `DFQL_INVALID` (parse error) rather than `FORBIDDEN`.

---

## TV-CLONEUP-009

**Description:** Client transport + sync facade delegates `cloneUp` and unwraps envelope errors.

**Input (client):**

- Mock `DefaultHttpTransport.cloneUp` to resolve `{ ok: true, result: { ok: true, cursor: "1", inserted: [], updated: [], skipped: [], errors: [], resource: "task" } }`.
- Call `client.sync.cloneUp({ clientId: "c1", resource: "task", records: [] })`.

**Expected output:**

- Returns the unwrapped `CloneUpResult`.

**Negative variant:** If transport resolves `{ ok: false, error: { code: "DFQL_INVALID", message: "x", details: { path: "clientId" } } }`, `client.sync.cloneUp(...)` throws `DatafnClientError` with `code = "DFQL_INVALID"`.

---

## TV-CLONEUP-010

**Description:** `client.sync.cloneUpNow()` uploads local records resource-by-resource, sorted and chunked, and returns an aggregate summary.

**Preconditions:**

- Client schema resources: `["task", "user"]`.
- Storage contains:
  - `task`: records with ids `task:2`, `task:1`
  - `user`: empty
- Configure `batchSize = 1`.
- Mock transport `cloneUp` to return:
  - For `task:1` batch: cursor `"1"`, inserted `["task:1"]`
  - For `task:2` batch: cursor `"2"`, inserted `["task:2"]`

**Input (client):**

```ts
await client.sync.cloneUpNow({ batchSize: 1 });
```

**Expected output:**

- Transport calls (in order):
  1. `{ clientId: <clientId>, resource: "task", records: [{ id: "task:1", ... }] }`
  2. `{ clientId: <clientId>, resource: "task", records: [{ id: "task:2", ... }] }`
- Summary:

```json
{
  "ok": true,
  "cursor": "2",
  "resources": [
    {
      "resource": "task",
      "inserted": ["task:1", "task:2"],
      "updated": [],
      "skipped": [],
      "errors": []
    }
  ]
}
```

**Negative variant:** If `batchSize = 0`, client throws `DFQL_INVALID` with `details.path = "batchSize"`.

---

## TV-CLONEUP-011

**Description:** `cloneUpNow()` fails deterministically when storage is missing.

**Input (client):**

- Create client without `storage`.
- Call `client.sync.cloneUpNow()`.

**Expected output:** Throws `DatafnClientError` with `code = "DFQL_INVALID"` and `details.path = "storage"`.

---

## TV-CLONEUP-012

**Description:** Namespace isolation: clone up writes in one namespace do not affect another.

**Preconditions:**

- Server configured with `authContextProvider.getContext(ctx)` returning different `userId` based on request context.
- Two requests are sent with different contexts producing namespaces `user:alice` and `user:bob`.

**Input (HTTP):**

1) As Alice:

```json
{ "clientId": "c1", "resource": "task", "records": [{ "id": "task:1", "title": "a" }] }
```

2) As Bob:

```json
{ "clientId": "c2", "resource": "task", "records": [] }
```

**Expected output:**

- Alice’s subsequent `/datafn/clone` returns `task:1`.
- Bob’s subsequent `/datafn/clone` returns no `task:1`.

**Negative variant:** If both namespaces share data, isolation is violated (CLONEUP-006).

---

## TV-CLONEUP-013

**Description:** `cloneUpNow({ resources })` uploads only the requested subset and preserves order.

**Preconditions:**

- Schema resources: `["task", "user"]`.
- Storage has non-empty records for both.
- Mock transport.

**Input:**

```ts
await client.sync.cloneUpNow({ resources: ["user", "task"], batchSize: 500 });
```

**Expected output:**

- First transport call is for `resource: "user"`, second is `resource: "task"`.

**Negative variant:** If `resources` contains an unknown name, the client throws `DFQL_UNKNOWN_RESOURCE` with `details.path = "resources[i]"`.

---

## TV-CLONEUP-014

**Description:** Typecheck: core/client/server compile with the new sync phase `"cloneup"`.

**Input (commands):**

```bash
npm -w @datafn/core typecheck
npm -w @datafn/client typecheck
npm -w @datafn/server typecheck
```

**Expected output:** All commands exit with code 0.

### TV-CLONEUP-014-N

**Description:** Negative typecheck: plugin code using an invalid sync phase string fails compilation.

**Input:** A TypeScript snippet in `@datafn/core` tests that attempts `beforeSync(ctx, "clone_up" as any, payload)`.

**Expected output:** TypeScript compilation fails (non-zero) unless the string is exactly `"cloneup"`.

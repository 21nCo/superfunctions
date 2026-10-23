# TEST VECTORS

## TV-ADP-001

- **Vector ID**: TV-ADP-001
- **Description**: Drizzle adapter update succeeds for existing row.
- **Input**:

```json
{
  "adapter": "drizzle-sqlite",
  "operation": "update",
  "model": "kv",
  "where": [{ "field": "id", "operator": "eq", "value": "kv:pref:theme" }],
  "data": { "value": "dark" },
  "namespace": "user:a"
}
```

- **Expected output**:

```json
{
  "ok": true,
  "result": { "id": "kv:pref:theme", "value": "dark" }
}
```

- **Negative variant(s)**: See TV-ADP-002.

---

## TV-ADP-002

- **Vector ID**: TV-ADP-002
- **Description**: Drizzle adapter update throws not-found when no row matches.
- **Input**:

```json
{
  "adapter": "drizzle-sqlite",
  "operation": "update",
  "model": "kv",
  "where": [{ "field": "id", "operator": "eq", "value": "kv:missing" }],
  "data": { "value": "light" },
  "namespace": "user:a"
}
```

- **Expected output**:

```json
{
  "ok": false,
  "error": { "name": "NotFoundError" }
}
```

- **Negative variant(s)**: N/A (this is the negative case for ADP-001).

---

## TV-MRG-001

- **Vector ID**: TV-MRG-001
- **Description**: Merge updates existing todo row and keeps unspecified fields.
- **Input**:

```json
{
  "endpoint": "/datafn/push",
  "clientId": "c1",
  "mutations": [
    {
      "resource": "todos",
      "version": 1,
      "operation": "merge",
      "id": "todo:1",
      "record": { "completed": true },
      "clientId": "c1",
      "mutationId": "m-merge-existing"
    }
  ]
}
```

- **Expected output**:

```json
{
  "ok": true,
  "result": {
    "ok": true,
    "applied": ["m-merge-existing"],
    "errors": []
  }
}
```

- **Negative variant(s)**: See TV-MRG-002.

---

## TV-MRG-002

- **Vector ID**: TV-MRG-002
- **Description**: Merge on missing todo with incomplete required fields returns NOT_FOUND.
- **Input**:

```json
{
  "endpoint": "/datafn/mutation",
  "resource": "todos",
  "version": 1,
  "operation": "merge",
  "id": "todo:missing",
  "record": { "completed": true },
  "clientId": "c1",
  "mutationId": "m-merge-missing"
}
```

- **Expected output**:

```json
{
  "ok": false,
  "error": {
    "code": "NOT_FOUND",
    "details": { "path": "id" }
  }
}
```

- **Negative variant(s)**: N/A (this is the negative case for TV-MRG-001).

---

## TV-MRG-003

- **Vector ID**: TV-MRG-003
- **Description**: Merge on missing KV row is eligible and creates row.
- **Input**:

```json
{
  "endpoint": "/datafn/push",
  "clientId": "c1",
  "mutations": [
    {
      "resource": "kv",
      "version": 1,
      "operation": "merge",
      "id": "kv:pref:theme",
      "record": { "value": "light" },
      "clientId": "c1",
      "mutationId": "m-kv-create"
    }
  ]
}
```

- **Expected output**:

```json
{
  "ok": true,
  "result": {
    "ok": true,
    "applied": ["m-kv-create"],
    "errors": []
  }
}
```

- **Negative variant(s)**: See TV-MRG-004.

---

## TV-MRG-004

- **Vector ID**: TV-MRG-004
- **Description**: Eligibility blocks create when required fields are missing.
- **Input**:

```json
{
  "resource": "todos",
  "id": "todo:new",
  "operation": "merge",
  "record": { "completed": false },
  "requiredFields": ["title", "createdAt"]
}
```

- **Expected output**:

```json
{
  "decision": "not_found"
}
```

- **Negative variant(s)**: N/A (this is the negative case for TV-MRG-003).

---

## TV-MRG-005

- **Vector ID**: TV-MRG-005
- **Description**: Concurrent create race resolves by one update retry.
- **Input**:

```json
{
  "scenario": "update-miss -> create-conflict -> update-retry",
  "resource": "kv",
  "id": "kv:pref:theme",
  "delta": { "value": "dark" }
}
```

- **Expected output**:

```json
{
  "ok": true,
  "finalWrite": "update-retry",
  "retryCount": 1
}
```

- **Negative variant(s)**: See TV-MRG-006.

---

## TV-MRG-006

- **Vector ID**: TV-MRG-006
- **Description**: Retry path does not loop indefinitely on repeated failure.
- **Input**:

```json
{
  "scenario": "update-miss -> create-conflict -> update-retry-fails",
  "resource": "kv",
  "id": "kv:pref:theme"
}
```

- **Expected output**:

```json
{
  "ok": false,
  "error": { "code": "INTERNAL" },
  "retryCount": 1
}
```

- **Negative variant(s)**: N/A (this is the negative case for TV-MRG-005).

---

## TV-KV-001

- **Vector ID**: TV-KV-001
- **Description**: First `kv.set` persists a DB row for namespace.
- **Input**:

```json
{
  "clientCall": "kv.set('pref:theme', 'light')",
  "namespace": "user:client-1"
}
```

- **Expected output**:

```json
{
  "clientResult": { "ok": true },
  "dbRow": { "id": "kv:pref:theme", "value": "light", "__ns": "user:client-1" }
}
```

- **Negative variant(s)**: See TV-KV-002.

---

## TV-KV-002

- **Vector ID**: TV-KV-002
- **Description**: Regression guard for false success (no DB row must fail test).
- **Input**:

```json
{
  "clientCall": "kv.set('pref:theme', 'light')",
  "serverResponse": { "ok": true, "result": { "ok": true, "applied": ["m1"] } },
  "dbLookup": "select * from kv where __ns='user:client-1' and id='kv:pref:theme'"
}
```

- **Expected output**:

```json
{
  "assertion": "db row exists",
  "pass": true
}
```

- **Negative variant(s)**:

```json
{
  "pass": false,
  "error": { "code": "REGRESSION_FALSE_SUCCESS" }
}
```

---

## TV-OBS-001

- **Vector ID**: TV-OBS-001
- **Description**: Applied list includes only persisted writes.
- **Input**:

```json
{
  "endpoint": "/datafn/push",
  "mutations": [
    { "mutationId": "m-ok", "operation": "merge", "resource": "kv", "id": "kv:a", "record": { "value": "x" } },
    { "mutationId": "m-miss", "operation": "merge", "resource": "todos", "id": "todo:missing", "record": { "completed": true } }
  ]
}
```

- **Expected output**:

```json
{
  "result": {
    "applied": ["m-ok"],
    "errors": [{ "mutationId": "m-miss", "code": "NOT_FOUND" }]
  }
}
```

- **Negative variant(s)**: See TV-OBS-002.

---

## TV-OBS-002

- **Vector ID**: TV-OBS-002
- **Description**: Non-applied merge does not create change-tracking record.
- **Input**:

```json
{
  "mutationId": "m-miss",
  "operation": "merge",
  "resource": "todos",
  "id": "todo:missing",
  "record": { "completed": true }
}
```

- **Expected output**:

```json
{
  "changeLogEntriesForMutation": 0
}
```

- **Negative variant(s)**:

```json
{
  "changeLogEntriesForMutation": 1,
  "error": { "code": "REGRESSION_GHOST_CHANGE" }
}
```

---

## TV-ERR-001

- **Vector ID**: TV-ERR-001
- **Description**: Deterministic error mapping for not-found and invalid payload paths.
- **Input**:

```json
{
  "cases": [
    { "kind": "missing-ineligible-merge", "resource": "todos", "record": { "completed": true } },
    { "kind": "invalid-merge-payload", "resource": "kv", "record": null }
  ]
}
```

- **Expected output**:

```json
{
  "results": [
    { "code": "NOT_FOUND", "path": "id" },
    { "code": "DFQL_INVALID", "path": "record" }
  ]
}
```

- **Negative variant(s)**: See TV-ERR-002.

---

## TV-ERR-002

- **Vector ID**: TV-ERR-002
- **Description**: Unexpected adapter error maps to INTERNAL with generic message.
- **Input**:

```json
{
  "scenario": "adapter throws non-not-found database error during merge"
}
```

- **Expected output**:

```json
{
  "code": "INTERNAL",
  "message": "Internal error",
  "path": "$"
}
```

- **Negative variant(s)**:

```json
{
  "code": "NOT_FOUND",
  "error": { "code": "MAPPING_REGRESSION" }
}
```

---

## TV-TST-001

- **Vector ID**: TV-TST-001
- **Description**: SQL-backed test suite detects and passes merge/KV regression scenarios.
- **Input**:

```json
{
  "command": "npx vitest run packages/db/src/adapters/drizzle/drizzle.test.ts datafn/server/__tests__/merge-sql-regression.test.ts"
}
```

- **Expected output**:

```json
{
  "exitCode": 0,
  "failedTests": 0
}
```

- **Negative variant(s)**: See TV-TST-002.

---

## TV-TST-002

- **Vector ID**: TV-TST-002
- **Description**: Old behavior should fail SQL-backed regression tests.
- **Input**:

```json
{
  "precondition": "drizzle update returns undefined on zero rows and server merge treats it as success"
}
```

- **Expected output**:

```json
{
  "exitCode": 1,
  "failingAssertions": [
    "kv first-write persisted row",
    "missing merge not marked applied"
  ]
}
```

- **Negative variant(s)**: N/A (this is the negative case for TV-TST-001).

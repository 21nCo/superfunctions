# TEST VECTORS

## TV-RCAP-001
- **Description**: Relation schema accepts explicit capability declaration on many-many relation.
- **Input**:
```json
{
  "resources": [
    { "name": "todos", "version": 1, "fields": [{ "name": "id", "type": "string", "required": true }] },
    { "name": "categories", "version": 1, "fields": [{ "name": "id", "type": "string", "required": true }] }
  ],
  "relations": [
    {
      "from": "todos",
      "to": "categories",
      "type": "many-many",
      "relation": "tags",
      "capabilities": ["timestamps", "audit"]
    }
  ]
}
```
- **Expected output**:
```json
{ "ok": true }
```
- **Negative variant(s)**:
  - Input: `"capabilities": "timestamps"` (non-array)
  - Expected: `{ "ok": false, "error": { "code": "SCHEMA_INVALID" } }`

## TV-RCAP-002
- **Description**: Only supported capability values/types are accepted for relation capabilities.
- **Input**:
```json
{
  "relations": [
    {
      "from": "todos",
      "to": "categories",
      "type": "many-many",
      "relation": "tags",
      "capabilities": ["timestamps"]
    }
  ]
}
```
- **Expected output**:
```json
{ "ok": true }
```
- **Negative variant(s)**:
  - Input A: same relation with `"capabilities": ["trash"]`
  - Input B: `type: "one-many"` with `"capabilities": ["timestamps"]`
  - Expected: `{ "ok": false, "error": { "code": "INVALID_CAPABILITY" } }` for A, `{ "ok": false, "error": { "code": "SCHEMA_INVALID" } }` for B.

## TV-RCAP-003
- **Description**: Relation metadata collisions with capability-managed fields are rejected.
- **Input**:
```json
{
  "relations": [
    {
      "from": "todos",
      "to": "categories",
      "type": "many-many",
      "relation": "tags",
      "capabilities": ["timestamps"],
      "metadata": [{ "name": "addedOrder", "type": "number" }]
    }
  ]
}
```
- **Expected output**:
```json
{ "ok": true }
```
- **Negative variant(s)**:
  - Input: metadata includes `{ "name": "createdAt", "type": "date" }`
  - Expected: `{ "ok": false, "error": { "code": "CAPABILITY_FIELD_COLLISION", "path": "relations.tags.metadata.createdAt" } }`

## TV-RCAP-004
- **Description**: Relation capability resolution is deterministic and deduplicated.
- **Input**:
```json
{ "capabilities": ["audit", "timestamps", "audit"] }
```
- **Expected output**:
```json
{ "resolved": ["timestamps", "audit"] }
```
- **Negative variant(s)**:
  - Input: `{"capabilities":["timestamps", 123]}`
  - Expected: `{ "ok": false, "error": { "code": "SCHEMA_INVALID" } }`

## TV-JCG-001
- **Description**: Drizzle join-table codegen injects relation capability columns.
- **Input**:
```json
{
  "relations": [
    {
      "from": "todos",
      "to": "categories",
      "type": "many-many",
      "relation": "tags",
      "capabilities": ["timestamps", "audit"]
    }
  ]
}
```
- **Expected output**:
```json
{
  "contains": [
    "createdAt: bigint(\"created_at\", { mode: \"number\" })",
    "updatedAt: bigint(\"updated_at\", { mode: \"number\" })",
    "createdBy: text(\"created_by\")",
    "updatedBy: text(\"updated_by\")"
  ]
}
```
- **Negative variant(s)**:
  - Input: relation has no `capabilities`
  - Expected: generated join table does not contain capability columns.

## TV-JCG-002
- **Description**: Type codegen emits join interface when relation capabilities are present.
- **Input**:
```json
{
  "relations": [
    {
      "from": "todos",
      "to": "categories",
      "type": "many-many",
      "relation": "tags",
      "capabilities": ["timestamps"]
    }
  ]
}
```
- **Expected output**:
```json
{
  "contains": [
    "export interface __DatafnJoinTodosTags",
    "createdAt?: number",
    "updatedAt?: number"
  ]
}
```
- **Negative variant(s)**:
  - Input: relation has neither metadata nor capabilities
  - Expected: no join interface emitted for that relation.

## TV-JRT-001
- **Description**: Readonly relation capability fields are stripped from relation payload metadata.
- **Input**:
```json
{
  "operation": "relate",
  "resource": "todos",
  "id": "todo:1",
  "relations": {
    "tags": [{ "$ref": "cat:1", "addedOrder": 1, "createdAt": 1, "createdBy": "evil" }]
  }
}
```
- **Expected output**:
```json
{
  "writePayload": {
    "addedOrder": 1,
    "createdAt": "<server-set>",
    "createdBy": "<server-set>"
  }
}
```
- **Negative variant(s)**:
  - Input: relation has no enabled capabilities; metadata contains `createdAt`
  - Expected: `createdAt` is treated as ordinary metadata (not stripped) to preserve non-capability behavior.

## TV-JRT-002
- **Description**: Relate create path injects insert-time relation capability fields.
- **Input**:
```json
{
  "operation": "relate",
  "resource": "todos",
  "id": "todo:1",
  "actorId": "user:alice",
  "relations": { "tags": ["cat:1"] },
  "relationCapabilities": ["timestamps", "audit"],
  "existingJoinRow": null
}
```
- **Expected output**:
```json
{
  "createdRowContains": ["createdAt", "updatedAt", "createdBy", "updatedBy"],
  "createdBy": "user:alice",
  "updatedBy": "user:alice"
}
```
- **Negative variant(s)**:
  - Input: `relationCapabilities: []`
  - Expected: create payload omits capability fields.

## TV-JRT-003
- **Description**: Relate update path injects update fields and preserves immutable create fields.
- **Input**:
```json
{
  "operation": "relate",
  "resource": "todos",
  "id": "todo:1",
  "actorId": "user:bob",
  "relations": { "tags": [{ "$ref": "cat:1", "addedOrder": 2 }] },
  "relationCapabilities": ["timestamps", "audit"],
  "existingJoinRow": {
    "createdAt": 100,
    "updatedAt": 100,
    "createdBy": "user:alice",
    "updatedBy": "user:alice"
  }
}
```
- **Expected output**:
```json
{
  "updatedRow": {
    "addedOrder": 2,
    "createdAt": 100,
    "createdBy": "user:alice",
    "updatedAt": ">=100",
    "updatedBy": "user:bob"
  }
}
```
- **Negative variant(s)**:
  - Input: client sends `createdBy: "user:mallory"` in metadata
  - Expected: persisted `createdBy` remains `user:alice`.

## TV-JRT-004
- **Description**: modifyRelation injects update fields and respects NOT_FOUND semantics.
- **Input**:
```json
{
  "operation": "modifyRelation",
  "resource": "todos",
  "id": "todo:1",
  "actorId": "user:bob",
  "relations": { "tags": [{ "$ref": "cat:1", "addedOrder": 3 }] },
  "relationCapabilities": ["timestamps", "audit"],
  "existingJoinRow": true
}
```
- **Expected output**:
```json
{
  "ok": true,
  "updatedFieldsContain": ["addedOrder", "updatedAt", "updatedBy"]
}
```
- **Negative variant(s)**:
  - Input: `existingJoinRow: false`
  - Expected: `{ "ok": false, "error": { "code": "NOT_FOUND" } }` and no write occurs.

## TV-JSY-001
- **Description**: Push path relation mutation parity with direct mutation path.
- **Input**:
```json
{
  "endpoint": "/datafn/push",
  "mutations": [
    {
      "operation": "relate",
      "resource": "todos",
      "id": "todo:1",
      "relations": { "tags": [{ "$ref": "cat:1", "createdAt": 1 }] }
    }
  ],
  "relationCapabilities": ["timestamps"]
}
```
- **Expected output**:
```json
{
  "results": [{ "ok": true }],
  "persistedJoinRow": { "createdAt": "<server-set>", "updatedAt": "<server-set>" }
}
```
- **Negative variant(s)**:
  - Input: same push request with relation capabilities disabled
  - Expected: no capability field injection.

## TV-JSY-002
- **Description**: Change tracking and pull/clone include relation capability fields.
- **Input**:
```json
{
  "sequence": [
    "relate todo:1 -> cat:1 with capability-enabled relation",
    "pull after seq",
    "clone"
  ]
}
```
- **Expected output**:
```json
{
  "changeEntry.recordContains": ["createdAt", "updatedAt"],
  "pull.joinRowsContain": ["createdAt", "updatedAt"],
  "clone.joinRowsContain": ["createdAt", "updatedAt"]
}
```
- **Negative variant(s)**:
  - Input: relation without capabilities
  - Expected: change/pull/clone join rows do not include capability fields unless declared as metadata.

## TV-SEC-001
- **Description**: Actor and namespace boundaries remain authoritative.
- **Input**:
```json
{
  "operation": "relate",
  "actorId": null,
  "namespace": "tenant:a",
  "relations": { "tags": ["cat:1"] },
  "relationCapabilities": ["audit"]
}
```
- **Expected output**:
```json
{
  "persisted": { "createdBy": null, "updatedBy": null, "__ns": "tenant:a" }
}
```
- **Negative variant(s)**:
  - Input: client metadata attempts `updatedBy: "tenant:b:user"`
  - Expected: persisted `updatedBy` remains server-derived (`null` or actorId), never client-provided.

## TV-COMP-001
- **Description**: Non-opt-in schemas keep existing behavior.
- **Input**:
```json
{
  "relation": {
    "from": "todos",
    "to": "categories",
    "type": "many-many",
    "relation": "tags"
  }
}
```
- **Expected output**:
```json
{
  "drizzleJoinColumns": ["id", "from", "to"],
  "runtimeInjection": "none"
}
```
- **Negative variant(s)**:
  - Input: relation opts in with `capabilities: ["timestamps"]`
  - Expected: generated schema/runtime now includes timestamp fields; behavior change is explicit.

## TV-OBS-001
- **Description**: Debug observability for relation capability decisions.
- **Input**:
```json
{
  "loggerLevel": "debug",
  "operation": "relate",
  "relationCapabilities": ["timestamps", "audit"],
  "clientMetadata": { "createdAt": 1 }
}
```
- **Expected output**:
```json
{
  "logsContain": [
    "resolved relation capabilities: timestamps,audit",
    "stripped readonly relation capability field(s): createdAt",
    "injected relation capability field(s): createdAt,updatedAt,createdBy,updatedBy"
  ]
}
```
- **Negative variant(s)**:
  - Input: auth context includes bearer token internals
  - Expected: logs do not emit token strings or full auth object dump.

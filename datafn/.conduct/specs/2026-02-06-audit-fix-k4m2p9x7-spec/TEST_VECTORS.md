## Test vectors (golden)

Each vector is minimal, deterministic, and may be referenced by multiple requirements.

### TV-CFG-001

- **Vector ID**: TV-CFG-001
- **Description**: `sync.remoteAdapter` is used for remote calls.
- **Input**:

```json
{
  "clientConfig": {
    "clientId": "client:dev-1",
    "schema": { "resources": [{ "name": "node", "version": 1, "fields": [] }] },
    "sync": {
      "mode": "sync",
      "remoteAdapter": "FakeAdapterThatCountsCalls"
    }
  },
  "call": { "method": "query", "payload": { "resource": "node", "version": 1, "select": ["id"] } }
}
```

- **Expected output**:

```json
{
  "remoteAdapterCalls": [{ "method": "query" }],
  "result": { "data": [], "nextCursor": null }
}
```

- **Negative variant(s)**: TV-CFG-001N

### TV-CFG-001N

- **Vector ID**: TV-CFG-001N
- **Description**: `mode:"sync"` without `remote` or `remoteAdapter` is rejected.
- **Input**:

```json
{
  "clientConfig": {
    "clientId": "client:dev-1",
    "schema": { "resources": [{ "name": "node", "version": 1, "fields": [] }] },
    "sync": { "mode": "sync" }
  }
}
```

- **Expected output**:

```json
{
  "error": { "code": "DFQL_INVALID", "message": "Invalid client config: remote or remoteAdapter is required in sync mode", "details": { "path": "sync" } }
}
```

### TV-CFG-002

- **Vector ID**: TV-CFG-002
- **Description**: Local-only mode executes mutate/query locally without remote.
- **Input**:

```json
{
  "clientConfig": {
    "clientId": "client:guest-1",
    "schema": {
      "resources": [
        { "name": "node", "version": 1, "fields": [{ "name": "label", "type": "string", "required": false }] }
      ]
    },
    "sync": { "mode": "local-only", "offlinability": true },
    "storage": "MemoryStorage"
  },
  "steps": [
    { "mutate": { "resource": "node", "version": 1, "operation": "insert", "id": "node:1", "record": { "label": "A" } } },
    { "query": { "resource": "node", "version": 1, "select": ["id", "label"] } }
  ]
}
```

- **Expected output**:

```json
{
  "mutationResult": { "ok": true, "affectedIds": ["node:1"] },
  "queryResult": { "data": [{ "id": "node:1", "label": "A" }], "nextCursor": null }
}
```

- **Negative variant(s)**: TV-CFG-002N

### TV-CFG-002N

- **Vector ID**: TV-CFG-002N
- **Description**: Local-only mode without storage but with offlinability is rejected.
- **Input**:

```json
{
  "clientConfig": {
    "clientId": "client:guest-1",
    "schema": { "resources": [{ "name": "node", "version": 1, "fields": [] }] },
    "sync": { "mode": "local-only", "offlinability": true }
  }
}
```

- **Expected output**:

```json
{
  "error": { "code": "DFQL_INVALID", "message": "Invalid client config: storage is required when offlinability is true", "details": { "path": "storage" } }
}
```

### TV-ID-001

- **Vector ID**: TV-ID-001
- **Description**: Insert without id uses `generateId({resource,idPrefix})` and respects prefix.
- **Input**:

```json
{
  "schema": {
    "resources": [
      { "name": "node", "version": 1, "idPrefix": "node", "fields": [{ "name": "label", "type": "string", "required": false }] }
    ]
  },
  "generateId": { "resource": "node", "returns": "node:abc" },
  "mutation": { "resource": "node", "version": 1, "operation": "insert", "record": { "label": "X" } }
}
```

- **Expected output**:

```json
{ "mutationSent": { "id": "node:abc" }, "result": { "ok": true } }
```

- **Negative variant(s)**: TV-ID-001N

### TV-ID-001N

- **Vector ID**: TV-ID-001N
- **Description**: Generator returns wrong prefix; client rejects deterministically.
- **Input**:

```json
{
  "schema": { "resources": [{ "name": "node", "version": 1, "idPrefix": "node", "fields": [] }] },
  "generateId": { "resource": "node", "returns": "goal:wrong" },
  "mutation": { "resource": "node", "version": 1, "operation": "insert", "record": {} }
}
```

- **Expected output**:

```json
{
  "error": { "code": "DFQL_INVALID", "message": "Invalid id: does not match required prefix", "details": { "path": "id" } }
}
```

### TV-CTX-001

- **Vector ID**: TV-CTX-001
- **Description**: Mutation context is propagated to emitted events.
- **Input**:

```json
{
  "mutation": {
    "resource": "node",
    "version": 1,
    "operation": "merge",
    "id": "node:1",
    "record": { "label": "X" },
    "clientId": "client:1",
    "mutationId": "m-1",
    "context": { "tag": "ComponentBaseLayer", "pane": "left" }
  }
}
```

- **Expected output**:

```json
{
  "event": {
    "type": "mutation_applied",
    "resource": "node",
    "ids": ["node:1"],
    "action": "merge",
    "fields": ["label"],
    "mutationId": "m-1",
    "clientId": "client:1",
    "context": { "tag": "ComponentBaseLayer", "pane": "left" }
  }
}
```

- **Negative variant(s)**: TV-CTX-001N

### TV-CTX-001N

- **Vector ID**: TV-CTX-001N
- **Description**: Non-serializable context is rejected.
- **Input**:

```json
{
  "mutation": {
    "resource": "node",
    "version": 1,
    "operation": "merge",
    "id": "node:1",
    "record": { "label": "X" },
    "clientId": "client:1",
    "mutationId": "m-1",
    "context": { "bad": "<<non-json>>" }
  }
}
```

- **Expected output**:

```json
{
  "error": { "code": "DFQL_INVALID", "message": "Invalid mutation: context must be JSON-serializable", "details": { "path": "context" } }
}
```

### TV-EVT-001

- **Vector ID**: TV-EVT-001
- **Description**: Mutation event includes full metadata deterministically.
- **Input**:

```json
{
  "mutation": {
    "resource": "node",
    "version": 1,
    "operation": "merge",
    "id": "node:1",
    "record": { "label": "X", "notes": "Y" },
    "clientId": "client:1",
    "mutationId": "m-1"
  }
}
```

- **Expected output**:

```json
{
  "event": {
    "type": "mutation_applied",
    "resource": "node",
    "ids": ["node:1"],
    "mutationId": "m-1",
    "clientId": "client:1",
    "action": "merge",
    "fields": ["label", "notes"]
  }
}
```

- **Negative variant(s)**: TV-EVT-001N

### TV-EVT-001N

- **Vector ID**: TV-EVT-001N
- **Description**: Thrown transport error emits mutation_rejected with deterministic context.
- **Input**:

```json
{
  "mutation": {
    "resource": "node",
    "version": 1,
    "operation": "merge",
    "id": "node:1",
    "record": { "label": "X" },
    "clientId": "client:1",
    "mutationId": "m-1"
  },
  "remoteError": { "code": "TRANSPORT_ERROR", "message": "Network down" }
}
```

- **Expected output**:

```json
{
  "event": {
    "type": "mutation_rejected",
    "resource": "node",
    "ids": ["node:1"],
    "mutationId": "m-1",
    "clientId": "client:1",
    "action": "merge",
    "fields": ["label"],
    "context": { "code": "TRANSPORT_ERROR", "message": "Network down", "path": "$" }
  }
}
```

### TV-EVT-002

- **Vector ID**: TV-EVT-002
- **Description**: Context filter matches by shallow equality and keys.
- **Input**:

```json
{
  "filter": { "resource": "node", "contextKeys": ["tag"], "context": { "tag": "ComponentBaseLayer" } },
  "event": { "type": "mutation_applied", "resource": "node", "timestampMs": 1, "context": { "tag": "ComponentBaseLayer", "pane": "left" } }
}
```

- **Expected output**:

```json
{ "matches": true }
```

- **Negative variant(s)**: TV-EVT-002N

### TV-EVT-002N

- **Vector ID**: TV-EVT-002N
- **Description**: Context filter fails when values differ.
- **Input**:

```json
{
  "filter": { "resource": "node", "context": { "tag": "A" } },
  "event": { "type": "mutation_applied", "resource": "node", "timestampMs": 1, "context": { "tag": "B" } }
}
```

- **Expected output**:

```json
{ "matches": false }
```

### TV-SIG-001

- **Vector ID**: TV-SIG-001
- **Description**: Signals refresh selectively based on footprint.
- **Input**:

```json
{
  "signalQuery": { "resource": "node", "version": 1, "select": ["id", "label"] },
  "events": [
    { "type": "mutation_applied", "resource": "goal", "timestampMs": 1 },
    { "type": "mutation_applied", "resource": "node", "timestampMs": 2 }
  ]
}
```

- **Expected output**:

```json
{ "refreshCount": 1 }
```

- **Negative variant(s)**: TV-SIG-001N

### TV-SIG-001N

- **Vector ID**: TV-SIG-001N
- **Description**: Signal does not refresh for unrelated resources.
- **Input**:

```json
{
  "signalQuery": { "resource": "node", "version": 1, "select": ["id"] },
  "events": [{ "type": "mutation_applied", "resource": "goal", "timestampMs": 1 }]
}
```

- **Expected output**:

```json
{ "refreshCount": 0 }
```

### TV-SIG-002

- **Vector ID**: TV-SIG-002
- **Description**: Multiple matching events in same tick cause one refresh.
- **Input**:

```json
{
  "signalQuery": { "resource": "node", "version": 1, "select": ["id"] },
  "eventsSameTick": [
    { "type": "mutation_applied", "resource": "node", "timestampMs": 1 },
    { "type": "mutation_applied", "resource": "node", "timestampMs": 1 }
  ]
}
```

- **Expected output**:

```json
{ "refreshCount": 1 }
```

- **Negative variant(s)**: TV-SIG-002N

### TV-SIG-002N

- **Vector ID**: TV-SIG-002N
- **Description**: A refresh queued during in-flight fetch executes once after completion.
- **Input**:

```json
{
  "signalQuery": { "resource": "node", "version": 1, "select": ["id"] },
  "events": [
    { "type": "mutation_applied", "resource": "node", "timestampMs": 1, "duringInFlight": true }
  ]
}
```

- **Expected output**:

```json
{ "refreshes": ["inFlightFetch", "queuedRefresh"] }
```

### TV-KV-001

- **Vector ID**: TV-KV-001
- **Description**: KV resource exists without being in user schema.
- **Input**:

```json
{
  "clientConfig": {
    "clientId": "client:1",
    "schema": { "resources": [{ "name": "node", "version": 1, "fields": [] }] },
    "sync": { "mode": "local-only", "offlinability": true },
    "storage": "IndexedDbStorage"
  },
  "operation": { "kvSet": { "key": "preferences.theme", "value": { "mode": "dark" } } }
}
```

- **Expected output**:

```json
{ "ok": true, "stored": { "key": "preferences.theme" } }
```

- **Negative variant(s)**: TV-KV-001N

### TV-KV-001N

- **Vector ID**: TV-KV-001N
- **Description**: KV key must be string.
- **Input**:

```json
{ "kvSet": { "key": 123, "value": "x" } }
```

- **Expected output**:

```json
{
  "error": { "code": "DFQL_INVALID", "message": "Invalid KV key: must be string", "details": { "path": "key" } }
}
```

### TV-KV-002

- **Vector ID**: TV-KV-002
- **Description**: KV merge shallow-merges object and emits fields metadata.
- **Input**:

```json
{
  "initial": { "preferences.theme": { "mode": "light", "accent": "blue" } },
  "merge": { "key": "preferences.theme", "patch": { "mode": "dark" } }
}
```

- **Expected output**:

```json
{
  "value": { "mode": "dark", "accent": "blue" },
  "event": { "resource": "kv", "action": "merge", "fields": ["mode"] }
}
```

- **Negative variant(s)**: TV-KV-002N

### TV-KV-002N

- **Vector ID**: TV-KV-002N
- **Description**: KV merge rejects non-object existing value.
- **Input**:

```json
{
  "initial": { "k": "not-an-object" },
  "merge": { "key": "k", "patch": { "a": 1 } }
}
```

- **Expected output**:

```json
{ "error": { "code": "DFQL_INVALID", "message": "Invalid KV merge: existing value is not an object", "details": { "path": "value" } } }
```

### TV-SYNC-001

- **Vector ID**: TV-SYNC-001
- **Description**: Paginated clone returns deterministic page and `next` marker.
- **Input**:

```json
{
  "request": { "clientId": "client:1", "tables": ["node"], "page": { "table": "node", "afterId": null, "limit": 2 }, "includeJoins": true },
  "dbState": { "node": [{ "id": "node:1" }, { "id": "node:2" }, { "id": "node:3" }] }
}
```

- **Expected output**:

```json
{
  "result": {
    "ok": true,
    "data": { "node": [{ "id": "node:1" }, { "id": "node:2" }] },
    "next": { "node": "node:2" }
  }
}
```

- **Negative variant(s)**: TV-SYNC-001N

### TV-SYNC-001N

- **Vector ID**: TV-SYNC-001N
- **Description**: Clone rejects remote-only resources.
- **Input**:

```json
{
  "schema": { "resources": [{ "name": "vector", "version": 1, "isRemoteOnly": true, "fields": [] }] },
  "request": { "clientId": "client:1", "tables": ["vector"] }
}
```

- **Expected output**:

```json
{
  "error": { "code": "DFQL_INVALID", "message": "Invalid DFQL: remote-only table cannot be cloned: vector", "details": { "path": "tables" } }
}
```

### TV-SYNC-002

- **Vector ID**: TV-SYNC-002
- **Description**: Hydration plan hydrates boot resources before background resources.
- **Input**:

```json
{
  "hydration": { "bootResources": ["goal"], "backgroundResources": ["node"] },
  "initialHydrationState": { "goal": "notStarted", "node": "notStarted" }
}
```

- **Expected output**:

```json
{
  "order": ["clone(goal)->ready", "clone(node)->ready"],
  "bootReadyWhenGoalReady": true
}
```

- **Negative variant(s)**: TV-SYNC-002N

### TV-SYNC-002N

- **Vector ID**: TV-SYNC-002N
- **Description**: Query on hydrating table uses remote fallback when available.
- **Input**:

```json
{
  "hydrationState": { "node": "hydrating" },
  "query": { "resource": "node", "version": 1, "select": ["id"] },
  "remoteAvailable": true
}
```

- **Expected output**:

```json
{ "routedTo": "remote" }
```

### TV-SYNC-003

- **Vector ID**: TV-SYNC-003
- **Description**: Per-table pull returns grouped records/deletes and updated cursors.
- **Input**:

```json
{
  "request": { "clientId": "client:1", "cursors": { "node": "10", "goal": "0" }, "limit": 100, "includeJoins": true },
  "changeLog": [
    { "serverSeq": 11, "resource": "node", "id": "node:1", "op": "upsert", "record": { "id": "node:1", "label": "X" } },
    { "serverSeq": 12, "resource": "goal", "id": "goal:1", "op": "delete", "record": null }
  ]
}
```

- **Expected output**:

```json
{
  "result": {
    "ok": true,
    "records": { "node": [{ "id": "node:1", "label": "X" }], "goal": [] },
    "deleted": { "node": [], "goal": ["goal:1"] },
    "cursors": { "node": "11", "goal": "12" }
  }
}
```

- **Negative variant(s)**: TV-SYNC-003N

### TV-SYNC-003N

- **Vector ID**: TV-SYNC-003N
- **Description**: Pull rejects invalid cursor format.
- **Input**:

```json
{ "request": { "clientId": "client:1", "cursors": { "node": "not-an-int" } } }
```

- **Expected output**:

```json
{ "error": { "code": "DFQL_INVALID", "message": "Invalid DFQL: cursor must be an integer string", "details": { "path": "cursors.node" } } }
```

### TV-SYNC-004

- **Vector ID**: TV-SYNC-004
- **Description**: Legacy global-cursor pull remains supported.
- **Input**:

```json
{ "request": { "clientId": "client:1", "cursor": "10", "limit": 2 } }
```

- **Expected output**:

```json
{ "result": { "ok": true, "changes": [], "nextCursor": null } }
```

- **Negative variant(s)**: TV-SYNC-004N

### TV-SYNC-004N

- **Vector ID**: TV-SYNC-004N
- **Description**: Legacy pull rejects non-integer cursor.
- **Input**:

```json
{ "request": { "clientId": "client:1", "cursor": "x" } }
```

- **Expected output**:

```json
{ "error": { "code": "DFQL_INVALID", "message": "Invalid DFQL: cursor must be an integer string", "details": { "path": "cursor" } } }
```

### TV-REL-001

- **Vector ID**: TV-REL-001
- **Description**: Push applies relation mutation and records join delta.
- **Input**:

```json
{
  "schema": {
    "resources": [
      { "name": "node", "version": 1, "fields": [] },
      { "name": "property", "version": 1, "fields": [] }
    ],
    "relations": [
      { "from": "node", "to": "property", "type": "many-many", "relation": "properties" }
    ]
  },
  "push": {
    "clientId": "client:1",
    "mutations": [
      {
        "resource": "node",
        "version": 1,
        "operation": "relate",
        "id": "node:1",
        "relations": { "properties": [{ "$ref": "property:1", "value": "v" }] },
        "clientId": "client:1",
        "mutationId": "m-1"
      }
    ]
  }
}
```

- **Expected output**:

```json
{ "result": { "ok": true, "applied": ["m-1"], "errors": [] } }
```

- **Negative variant(s)**: TV-REL-001N

### TV-REL-001N

- **Vector ID**: TV-REL-001N
- **Description**: Push rejects relation mutation for unknown relation.
- **Input**:

```json
{
  "push": {
    "clientId": "client:1",
    "mutations": [
      {
        "resource": "node",
        "version": 1,
        "operation": "relate",
        "id": "node:1",
        "relations": { "unknownRel": "x" },
        "clientId": "client:1",
        "mutationId": "m-1"
      }
    ]
  }
}
```

- **Expected output**:

```json
{ "error": { "code": "DFQL_UNKNOWN_RELATION", "message": "Unknown relation: unknownRel", "details": { "path": "mutations[0].relations.unknownRel" } } }
```

### TV-REL-002

- **Vector ID**: TV-REL-002
- **Description**: Pull/clone hydrates join rows into client join stores.
- **Input**:

```json
{
  "cloneResult": {
    "ok": true,
    "data": { "node": [{ "id": "node:1" }], "property": [{ "id": "property:1" }] },
    "joins": { "join_node_properties_property": [{ "from": "node:1", "to": "property:1", "value": "v" }] },
    "cursors": { "node": "1", "property": "1" }
  }
}
```

- **Expected output**:

```json
{
  "storage": {
    "records": { "node": ["node:1"], "property": ["property:1"] },
    "joins": { "join_node_properties_property": [{ "from": "node:1", "to": "property:1", "value": "v" }] }
  }
}
```

- **Negative variant(s)**: TV-REL-002N

### TV-REL-002N

- **Vector ID**: TV-REL-002N
- **Description**: Join store delta with missing store is rejected deterministically.
- **Input**:

```json
{
  "pullResult": {
    "ok": true,
    "records": {},
    "deleted": {},
    "joins": { "join_missing_store": { "upsert": [{ "from": "a", "to": "b" }], "delete": [] } },
    "cursors": {}
  }
}
```

- **Expected output**:

```json
{ "error": { "code": "INTERNAL", "message": "Store not found: join_missing_store", "details": { "path": "joins.join_missing_store" } } }
```

### TV-RECON-001

- **Vector ID**: TV-RECON-001
- **Description**: Reconcile identifies count mismatch and triggers re-clone.
- **Input**:

```json
{
  "serverCounts": { "node": 3 },
  "localCounts": { "node": 2 },
  "resource": "node"
}
```

- **Expected output**:

```json
{ "recloneResources": ["node"] }
```

- **Negative variant(s)**: TV-RECON-001N

### TV-RECON-001N

- **Vector ID**: TV-RECON-001N
- **Description**: Reconcile endpoint rejects unknown resource.
- **Input**:

```json
{ "request": { "clientId": "client:1", "resources": ["unknown"] } }
```

- **Expected output**:

```json
{ "error": { "code": "DFQL_UNKNOWN_RESOURCE", "message": "Unknown resource: unknown", "details": { "path": "resources[0]" } } }
```

### TV-OFFQ-001

- **Vector ID**: TV-OFFQ-001
- **Description**: Local query routes `id eq` to getRecord.
- **Input**:

```json
{
  "query": { "resource": "node", "version": 1, "filters": { "id": { "eq": "node:1" } } },
  "storageState": { "node": [{ "id": "node:1", "label": "X" }] }
}
```

- **Expected output**:

```json
{ "calls": ["getRecord(node,node:1)"], "data": [{ "id": "node:1", "label": "X" }] }
```

- **Negative variant(s)**: TV-OFFQ-001N

### TV-OFFQ-001N

- **Vector ID**: TV-OFFQ-001N
- **Description**: Unsupported operator is rejected.
- **Input**:

```json
{ "query": { "resource": "node", "version": 1, "filters": { "label": { "$regex": "x" } } } }
```

- **Expected output**:

```json
{ "error": { "code": "DFQL_UNSUPPORTED", "message": "Unsupported DFQL feature: filters.label.$regex", "details": { "path": "filters.label" } } }
```

### TV-OFFQ-002

- **Vector ID**: TV-OFFQ-002
- **Description**: `$or` works deterministically.
- **Input**:

```json
{
  "query": { "resource": "node", "version": 1, "filters": { "$or": [{ "label": { "eq": "A" } }, { "label": { "eq": "B" } }] } },
  "storageState": { "node": [{ "id": "node:1", "label": "B" }, { "id": "node:2", "label": "C" }] }
}
```

- **Expected output**:

```json
{ "data": [{ "id": "node:1", "label": "B" }], "nextCursor": null }
```

- **Negative variant(s)**: TV-OFFQ-002N

### TV-OFFQ-002N

- **Vector ID**: TV-OFFQ-002N
- **Description**: `$or` must be array; otherwise false/invalid.
- **Input**:

```json
{ "query": { "resource": "node", "version": 1, "filters": { "$or": { "label": { "eq": "A" } } } } }
```

- **Expected output**:

```json
{ "error": { "code": "DFQL_INVALID", "message": "Invalid DFQL: $or must be array", "details": { "path": "filters.$or" } } }
```

### TV-OFFM-001

- **Vector ID**: TV-OFFM-001
- **Description**: Offline relate upserts join row locally.
- **Input**:

```json
{
  "mutation": {
    "resource": "node",
    "version": 1,
    "operation": "relate",
    "id": "node:1",
    "relations": { "properties": [{ "$ref": "property:1", "value": "v" }] },
    "clientId": "client:1",
    "mutationId": "m-1"
  }
}
```

- **Expected output**:

```json
{ "joinWrites": [{ "store": "join_node_properties_property", "row": { "from": "node:1", "to": "property:1", "value": "v" } }] }
```

- **Negative variant(s)**: TV-OFFM-001N

### TV-OFFM-001N

- **Vector ID**: TV-OFFM-001N
- **Description**: Offline modifyRelation rejects when join row missing.
- **Input**:

```json
{
  "mutation": {
    "resource": "node",
    "version": 1,
    "operation": "modifyRelation",
    "id": "node:1",
    "relations": { "properties": [{ "$ref": "property:1", "value": "new" }] },
    "clientId": "client:1",
    "mutationId": "m-2"
  },
  "existingJoins": []
}
```

- **Expected output**:

```json
{ "error": { "code": "NOT_FOUND", "message": "Relation not found between node:1 and property:1", "details": { "path": "relations.properties" } } }
```

### TV-CODEC-001

- **Vector ID**: TV-CODEC-001
- **Description**: Date codec serializes and parses ISO strings.
- **Input**:

```json
{
  "schema": { "resources": [{ "name": "task", "version": 1, "fields": [{ "name": "date", "type": "date", "required": false }] }] },
  "mutation": { "resource": "task", "version": 1, "operation": "merge", "id": "task:1", "record": { "date": "Date(2026-02-06T00:00:00Z)" } },
  "queryResult": { "data": [{ "id": "task:1", "date": "2026-02-06T00:00:00.000Z" }], "nextCursor": null }
}
```

- **Expected output**:

```json
{
  "serializedOutbound": { "date": "2026-02-06T00:00:00.000Z" },
  "parsedInbound": { "date": "Date(2026-02-06T00:00:00Z)" }
}
```

- **Negative variant(s)**: TV-CODEC-001N

### TV-CODEC-001N

- **Vector ID**: TV-CODEC-001N
- **Description**: Invalid date string is rejected deterministically.
- **Input**:

```json
{
  "schema": { "resources": [{ "name": "task", "version": 1, "fields": [{ "name": "date", "type": "date", "required": false }] }] },
  "queryResult": { "data": [{ "id": "task:1", "date": "not-a-date" }], "nextCursor": null }
}
```

- **Expected output**:

```json
{ "error": { "code": "DFQL_INVALID", "message": "Invalid date value", "details": { "path": "data[0].date" } } }
```

### TV-HOOK-001

- **Vector ID**: TV-HOOK-001
- **Description**: Client beforeSync/afterSync hooks run with correct phase.
- **Input**:

```json
{
  "plugins": [
    { "name": "p1", "runsOn": ["client"], "beforeSync": "appendFlag", "afterSync": "recordPhase" }
  ],
  "syncCall": { "phase": "pull", "payload": { "clientId": "client:1", "cursors": { "node": "0" } } }
}
```

- **Expected output**:

```json
{ "beforeSyncRan": true, "afterSyncRan": true, "phaseSeen": "pull" }
```

- **Negative variant(s)**: TV-HOOK-001N

### TV-HOOK-001N

- **Vector ID**: TV-HOOK-001N
- **Description**: beforeSync failure is fail-closed.
- **Input**:

```json
{
  "plugins": [{ "name": "p1", "runsOn": ["client"], "beforeSync": "throw(INTERNAL)" }],
  "syncCall": { "phase": "pull", "payload": {} }
}
```

- **Expected output**:

```json
{ "error": { "code": "INTERNAL", "message": "Plugin error", "details": { "path": "plugins.p1.beforeSync" } } }
```

### TV-EVT-003

- **Vector ID**: TV-EVT-003
- **Description**: sync_applied emitted with phase context.
- **Input**:

```json
{ "syncResult": { "phase": "pull", "ok": true, "cursors": { "node": "1" } } }
```

- **Expected output**:

```json
{ "event": { "type": "sync_applied", "context": { "phase": "pull" } } }
```

- **Negative variant(s)**: TV-EVT-003N

### TV-EVT-003N

- **Vector ID**: TV-EVT-003N
- **Description**: sync_failed emitted with error context.
- **Input**:

```json
{ "syncError": { "phase": "pull", "error": "Network down" } }
```

- **Expected output**:

```json
{ "event": { "type": "sync_failed", "context": { "phase": "pull" } } }
```

### TV-AUTH-001

- **Vector ID**: TV-AUTH-001
- **Description**: Authorized query passes; unauthorized field is rejected.
- **Input**:

```json
{
  "policy": { "resource": "node", "read": { "fields": ["id", "label"] } },
  "query": { "resource": "node", "version": 1, "select": ["id", "label"] }
}
```

- **Expected output**:

```json
{ "ok": true }
```

- **Negative variant(s)**: TV-AUTH-001N

### TV-AUTH-001N

- **Vector ID**: TV-AUTH-001N
- **Description**: Query selecting forbidden field is rejected with FORBIDDEN.
- **Input**:

```json
{
  "policy": { "resource": "node", "read": { "fields": ["id"] } },
  "query": { "resource": "node", "version": 1, "select": ["id", "label"] }
}
```

- **Expected output**:

```json
{ "error": { "code": "FORBIDDEN", "message": "Authorization denied", "details": { "path": "select[1]" } } }
```

### TV-AUTH-002

- **Vector ID**: TV-AUTH-002
- **Description**: Namespace isolation is enforced end-to-end.
- **Input**:

```json
{
  "namespaces": ["user:1", "user:2"],
  "mutation": { "resource": "node", "version": 1, "operation": "insert", "id": "node:1", "clientId": "client:1", "mutationId": "m-1" }
}
```

- **Expected output**:

```json
{ "dataIsolation": true }
```

- **Negative variant(s)**: TV-AUTH-002N

### TV-AUTH-002N

- **Vector ID**: TV-AUTH-002N
- **Description**: Hard-coded namespace would cause leakage; must not occur.
- **Input**:

```json
{ "assertNoHardcodedNamespace": "datafn" }
```

- **Expected output**:

```json
{ "passes": true }
```

### TV-EXT-001

- **Vector ID**: TV-EXT-001
- **Description**: Extension remote events feed local subscriptions.
- **Input**:

```json
{
  "remoteAdapter": "ExtensionTransport",
  "remoteEvent": { "type": "event", "subscriptionId": "s1", "event": { "type": "mutation_applied", "resource": "node", "timestampMs": 1 } }
}
```

- **Expected output**:

```json
{ "subscriberReceived": true }
```

- **Negative variant(s)**: TV-EXT-001N

### TV-EXT-001N

- **Vector ID**: TV-EXT-001N
- **Description**: Unsubscribe stops deliveries deterministically.
- **Input**:

```json
{ "unsubscribe": true, "remoteEventAfterUnsub": { "type": "mutation_applied", "resource": "node", "timestampMs": 2 } }
```

- **Expected output**:

```json
{ "subscriberReceived": false }
```

### TV-NUC-001

- **Vector ID**: TV-NUC-001
- **Description**: Nucleus builds with no Flux runtime imports.
- **Input**:

```json
{
  "commands": [
    { "cwd": "/Users/ar/dev/nucleus", "run": "npm run build:nucleus" },
    { "cwd": "/Users/ar/dev/nucleus", "run": "rg \"from '@nucleus/client/components/flux|client/components/flux\" client -g'*.{ts,tsx,js,svelte}'" }
  ]
}
```

- **Expected output**:

```json
{
  "buildExitCode": 0,
  "rgExitCode": 1,
  "rgStdout": ""
}
```

- **Negative variant(s)**: TV-NUC-001N

### TV-NUC-001N

- **Vector ID**: TV-NUC-001N
- **Description**: Flux import in runtime path fails the requirement.
- **Input**:

```json
{ "rgStdout": "client/components/flux/flux.ts: import ..." }
```

- **Expected output**:

```json
{ "error": { "code": "NUC_ASSERTION_FAILED", "message": "Flux import present in runtime path" } }
```

### TV-NUC-002

- **Vector ID**: TV-NUC-002
- **Description**: ComponentBaseLayer-like filtering is expressed via DatafnEventFilter (resource, ids, context, fields).
- **Input**:

```json
{
  "filter": {
    "resource": "node",
    "ids": ["node:1"],
    "context": { "tag": "ComponentBaseLayer" },
    "fields": ["properties"]
  },
  "event": {
    "type": "mutation_applied",
    "resource": "node",
    "ids": ["node:1"],
    "fields": ["properties", "label"],
    "context": { "tag": "ComponentBaseLayer" }
  }
}
```

- **Expected output**:

```json
{ "matches": true }
```

- **Negative variant(s)**: TV-NUC-002N

### TV-NUC-002N

- **Vector ID**: TV-NUC-002N
- **Description**: Context mismatch prevents refresh.
- **Input**:

```json
{
  "filter": { "resource": "node", "context": { "tag": "A" } },
  "event": { "type": "mutation_applied", "resource": "node", "context": { "tag": "B" } }
}
```

- **Expected output**:

```json
{ "matches": false }
```

### TV-NUC-003

- **Vector ID**: TV-NUC-003
- **Description**: Nucleus KV uses `client.kv` and persists across reload (local-only).
- **Input**:

```json
{
  "steps": [
    { "kvSet": { "key": "ui.theme", "value": { "mode": "dark" } } },
    { "reloadClient": true },
    { "kvGet": { "key": "ui.theme" } }
  ]
}
```

- **Expected output**:

```json
{ "valueAfterReload": { "mode": "dark" } }
```

- **Negative variant(s)**: TV-NUC-003N

### TV-NUC-003N

- **Vector ID**: TV-NUC-003N
- **Description**: Old Flux KV read/write usage is considered non-compliant.
- **Input**:

```json
{ "rgStdout": "client/components/flux/resourceStores/kv.store.ts imported" }
```

- **Expected output**:

```json
{ "error": { "code": "NUC_ASSERTION_FAILED", "message": "Flux KeyValueStore usage remains" } }
```

### TV-NUC-004

- **Vector ID**: TV-NUC-004
- **Description**: Extension contexts use remoteAdapter and receive background events.
- **Input**:

```json
{
  "extensionConfig": { "sync": { "remoteAdapter": "ExtensionTransport" } },
  "backgroundEmits": { "type": "mutation_applied", "resource": "node", "ids": ["node:1"], "timestampMs": 1 }
}
```

- **Expected output**:

```json
{ "contentSubscriberReceived": true }
```

- **Negative variant(s)**: TV-NUC-004N

### TV-NUC-004N

- **Vector ID**: TV-NUC-004N
- **Description**: Without remoteAdapter, extension subscription cannot receive background events.
- **Input**:

```json
{ "extensionConfig": { "sync": {} } }
```

- **Expected output**:

```json
{ "error": { "code": "DFQL_INVALID", "message": "Invalid extension config: remoteAdapter is required", "details": { "path": "sync.remoteAdapter" } } }
```

### TV-NUC-005

- **Vector ID**: TV-NUC-005
- **Description**: Nucleus uses direct signals + small utilities (no Flux-like wrapper store layer).
- **Input**:

```json
{
  "assertions": [
    "nucleus has a single datafn client instance module (e.g. client/data/datafn.ts)",
    "components import data from datafn tables/signals, not from ResourceStore wrappers"
  ]
}
```

- **Expected output**:

```json
{ "passes": true }
```

- **Negative variant(s)**: TV-NUC-005N

### TV-NUC-005N

- **Vector ID**: TV-NUC-005N
- **Description**: Introducing Flux-like wrapper stores around datafn is non-compliant.
- **Input**:

```json
{ "wrapperDetected": "client/stores/ResourceStore.ts wraps table.signal and re-implements caching" }
```

- **Expected output**:

```json
{ "error": { "code": "NUC_ASSERTION_FAILED", "message": "Flux-like wrapper store detected" } }
```


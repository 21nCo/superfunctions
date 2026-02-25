# TEST VECTORS: DataFn Production-Readiness Audit Fix

---

## Query Planner Classification

### TV-PLAN-001: Simple query → FULL_PUSHDOWN

- **Description**: A query with only base-field filters and scalar select should be classified as FULL_PUSHDOWN.
- **Input**:
  ```json
  {
    "query": {
      "resource": "task",
      "filters": { "status": { "$eq": "active" } },
      "sort": ["priority:desc", "id:asc"],
      "limit": 10,
      "select": ["id", "title", "status", "priority"]
    },
    "schema": {
      "resources": [{ "name": "task", "fields": [{ "name": "title", "type": "string" }, { "name": "status", "type": "string" }, { "name": "priority", "type": "number" }] }],
      "relations": [{ "from": "task", "to": "tag", "relation": "tags", "inverse": "tasks", "type": "many-many" }]
    }
  }
  ```
- **Expected Output**: `{ "strategy": "FULL_PUSHDOWN" }`

### TV-PLAN-002: Relation select → PARTIAL_PUSHDOWN

- **Description**: A query with a relation expansion token but no relation filter should be classified as PARTIAL_PUSHDOWN.
- **Input**:
  ```json
  {
    "query": {
      "resource": "task",
      "filters": { "status": { "$eq": "active" } },
      "select": ["id", "title", "tags.*"],
      "limit": 10
    }
  }
  ```
- **Expected Output**: `{ "strategy": "PARTIAL_PUSHDOWN" }`

### TV-PLAN-003: Relation filter → IN_MEMORY

- **Description**: A query with `$any` relation quantifier should be classified as IN_MEMORY.
- **Input**:
  ```json
  {
    "query": {
      "resource": "task",
      "filters": { "tags": { "$any": { "label": { "$eq": "urgent" } } } },
      "limit": 10
    }
  }
  ```
- **Expected Output**: `{ "strategy": "IN_MEMORY" }`

### TV-PLAN-004: GroupBy → IN_MEMORY

- **Description**: A query with groupBy should be classified as IN_MEMORY.
- **Input**:
  ```json
  {
    "query": {
      "resource": "task",
      "groupBy": ["status"],
      "aggregations": { "count": { "op": "count", "field": "*" } }
    }
  }
  ```
- **Expected Output**: `{ "strategy": "IN_MEMORY" }`

---

## Query Push-Down Execution

### TV-PUSHDOWN-001: Full push-down returns correct results

- **Description**: A simple query with filter + sort + limit executed via push-down produces the same results as in-memory.
- **Input**:
  ```json
  {
    "resource": "task",
    "filters": { "status": { "$eq": "active" } },
    "sort": ["priority:desc", "id:asc"],
    "limit": 2
  }
  ```
- **Seed Data** (task table):
  ```json
  [
    { "id": "t1", "title": "Low", "status": "active", "priority": 1 },
    { "id": "t2", "title": "High", "status": "active", "priority": 3 },
    { "id": "t3", "title": "Mid", "status": "done", "priority": 2 },
    { "id": "t4", "title": "Med", "status": "active", "priority": 2 }
  ]
  ```
- **Expected Output**:
  ```json
  {
    "data": [
      { "id": "t2", "title": "High", "status": "active", "priority": 3 },
      { "id": "t4", "title": "Med", "status": "active", "priority": 2 }
    ],
    "nextCursor": { "priority": 2, "id": "t4" }
  }
  ```
- **Expected Adapter Call**: `findMany({ model: "task", where: [{ field: "status", operator: "eq", value: "active" }], orderBy: [{ field: "priority", direction: "desc" }, { field: "id", direction: "asc" }], limit: 3 })`

### TV-PUSHDOWN-002: Push-down with offset

- **Description**: Offset is correctly passed to the adapter.
- **Input**:
  ```json
  { "resource": "task", "limit": 2, "offset": 1, "sort": ["id:asc"] }
  ```
- **Seed Data**: Same as TV-PUSHDOWN-001.
- **Expected Output**:
  ```json
  {
    "data": [
      { "id": "t2", "title": "High", "status": "active", "priority": 3 },
      { "id": "t3", "title": "Mid", "status": "done", "priority": 2 }
    ],
    "nextCursor": { "id": "t3" }
  }
  ```

### TV-PUSHDOWN-003: Push-down with no results

- **Description**: Empty result set from adapter is handled correctly.
- **Input**:
  ```json
  { "resource": "task", "filters": { "status": { "$eq": "nonexistent" } }, "limit": 10 }
  ```
- **Expected Output**:
  ```json
  { "data": [], "nextCursor": null }
  ```

---

## Partial Push-Down

### TV-PARTIAL-001: Primary resource pushed, relations loaded on-demand

- **Description**: Query with `tags.*` loads primary records via push-down, then loads related tags only for matched records.
- **Input**:
  ```json
  {
    "resource": "task",
    "filters": { "status": { "$eq": "active" } },
    "select": ["id", "title", "tags.*"],
    "limit": 2,
    "sort": ["id:asc"]
  }
  ```
- **Seed Data**:
  - tasks: `[{ "id": "t1", "title": "A", "status": "active" }, { "id": "t2", "title": "B", "status": "active" }, { "id": "t3", "title": "C", "status": "done" }]`
  - tags: `[{ "id": "tag1", "label": "urgent" }, { "id": "tag2", "label": "bug" }]`
  - join_task_tags: `[{ "from": "t1", "to": "tag1" }, { "from": "t2", "to": "tag2" }]`
- **Expected Output**:
  ```json
  {
    "data": [
      { "id": "t1", "title": "A", "tags": [{ "id": "tag1", "label": "urgent" }] },
      { "id": "t2", "title": "B", "tags": [{ "id": "tag2", "label": "bug" }] }
    ],
    "nextCursor": null
  }
  ```
- **Expected Adapter Calls**:
  1. `findMany({ model: "task", where: [status=active], orderBy: [id:asc], limit: 3 })` → primary push-down
  2. `findMany({ model: "__datafn_join_task_tags", where: [] })` → join table (scoped to needed keys)
  3. `findMany({ model: "tag", where: [{ field: "id", operator: "in", value: ["tag1", "tag2"] }] })` → targeted tag load

### TV-PARTIAL-002: Many-one relation targeted load

- **Description**: Query with `category.*` for many-one relation loads only referenced categories.
- **Input**:
  ```json
  {
    "resource": "task",
    "select": ["id", "title", "category.*"],
    "limit": 2,
    "sort": ["id:asc"]
  }
  ```
- **Seed Data**:
  - tasks: `[{ "id": "t1", "title": "A", "categoryId": "c1" }, { "id": "t2", "title": "B", "categoryId": "c1" }]`
  - categories: `[{ "id": "c1", "name": "Work" }, { "id": "c2", "name": "Personal" }]`
  - relation: `{ from: "task", to: "category", relation: "category", type: "many-one", fkField: "categoryId" }`
- **Expected Output**: Tasks with expanded category. Only category `c1` is fetched, NOT `c2`.

---

## In-Memory with Pre-Filtering

### TV-INMEM-001: Base-field filter pushed down for IN_MEMORY query

- **Description**: A query with both a base-field filter and a relation filter pushes the base-field filter to the adapter.
- **Input**:
  ```json
  {
    "resource": "task",
    "filters": {
      "status": { "$eq": "active" },
      "tags": { "$any": { "label": { "$eq": "urgent" } } }
    },
    "limit": 10
  }
  ```
- **Expected Adapter Call**: `findMany({ model: "task", where: [{ field: "status", operator: "eq", value: "active" }] })` — only the base-field filter is pushed. The relation filter is evaluated in-memory.
- **Negative Variant**: Without the optimization, `findMany` would be called with `where: []` (no filter), loading ALL task records.

---

## Filter Conversion

### TV-CONVERT-001: Simple equality conversion

- **Input**: `{ "status": "active" }`
- **Expected Output**: `[{ "field": "status", "operator": "eq", "value": "active" }]`

### TV-CONVERT-002: Multiple operator conversion

- **Input**: `{ "priority": { "$gte": 3 }, "status": { "$ne": "done" } }`
- **Expected Output**: `[{ "field": "priority", "operator": "gte", "value": 3 }, { "field": "status", "operator": "ne", "value": "done" }]`

### TV-CONVERT-003: $and flattening

- **Input**: `{ "$and": [{ "status": "active" }, { "priority": { "$gt": 1 } }] }`
- **Expected Output**: `[{ "field": "status", "operator": "eq", "value": "active" }, { "field": "priority", "operator": "gt", "value": 1 }]`

### TV-CONVERT-004: Unpushable filter returns null

- **Input**: `{ "$or": [{ "status": "active" }, { "status": "pending" }] }`
- **Expected Output**: `null` (cannot push $or to WhereClause)
- **Input (variant)**: `{ "tags": { "$any": { "label": "urgent" } } }`
- **Expected Output**: `null` (relation quantifier cannot be pushed)

---

## Sort Conversion

### TV-SORT-001: DFQL sort to OrderBy

- **Input**: `["name:asc", "-priority", "id"]`
- **Expected Output**: `[{ "field": "name", "direction": "asc" }, { "field": "priority", "direction": "desc" }, { "field": "id", "direction": "asc" }]`

---

## Bounded Sync

### TV-SYNC-BOUND-001: getChangesSince with limit

- **Description**: Changes returned are bounded by the limit parameter.
- **Setup**: 100 change entries for resource "task" with server_seq 1-100.
- **Input**: `getChangesSince({ resource: "task", sinceSeq: 0, limit: 10 })`
- **Expected Output**: Array of 10 entries with server_seq 1-10, ordered ASC.

### TV-SYNC-BOUND-002: getChangesSince without limit (backward compat)

- **Description**: Omitting limit returns all changes (current behavior).
- **Input**: `getChangesSince({ resource: "task", sinceSeq: 0 })`
- **Expected Output**: Array of 100 entries.

### TV-SYNC-BOUND-003: Pull canonical enforces server max

- **Description**: Even if client requests limit=5000, server caps to maxPullLimit.
- **Input**: POST /datafn/pull `{ "clientId": "c1", "cursors": { "task": "0" }, "limit": 5000 }`
- **Server Config**: `{ limits: { maxPullLimit: 1000 } }`
- **Expected**: Total changes returned ≤ 1000.

---

## Mutation Optimization

### TV-MUT-UPSERT-001: Merge uses upsert — new record

- **Description**: Merge on non-existent record creates it via upsert.
- **Input**:
  ```json
  {
    "clientId": "c1", "mutationId": "m1",
    "operation": "merge", "resource": "task", "id": "t-new",
    "record": { "title": "New Task", "status": "active" }
  }
  ```
- **Expected**: `{ ok: true }`. Record `t-new` exists with `{ title: "New Task", status: "active" }`.
- **Adapter Call**: `upsert({ model: "task", where: [{ field: "id", operator: "eq", value: "t-new" }], create: { id: "t-new", title: "New Task", status: "active" }, update: { title: "New Task", status: "active" } })`

### TV-MUT-UPSERT-002: Merge uses upsert — existing record

- **Description**: Merge on existing record updates it via upsert.
- **Precondition**: Record `t1` exists with `{ title: "Old", status: "done" }`.
- **Input**: `{ ..., operation: "merge", id: "t1", record: { status: "active" } }`
- **Expected**: `{ ok: true }`. Record `t1` has `{ title: "Old", status: "active" }`.

### TV-MUT-INSERT-001: Insert direct create — success

- **Description**: Insert calls create directly without findOne pre-check.
- **Input**: `{ ..., operation: "insert", id: "t-new", record: { title: "X" } }`
- **Expected**: `{ ok: true }`. No `findOne` call made.

### TV-MUT-INSERT-002: Insert direct create — conflict

- **Description**: Insert on existing record catches duplicate error.
- **Precondition**: Record `t1` exists.
- **Input**: `{ ..., operation: "insert", id: "t1", record: { title: "X" } }`
- **Expected**: `{ ok: false, errors: [{ code: "CONFLICT", message: "Record already exists" }] }`

### TV-MUT-PUSH-001: Push merge uses upsert

- **Description**: Push with merge mutations uses upsert path.
- **Input**: POST /datafn/push with 3 merge mutations.
- **Expected**: Each mutation calls `upsert` instead of `findOne` + `create/update`.

---

## Data Retention

### TV-RET-CHANGE-001: Prune changes older than N days

- **Setup**: 50 change entries — 25 created 60 days ago, 25 created today.
- **Input**: `pruneChanges(30)`
- **Expected**: Returns `25`. 25 entries remain (today's entries).

### TV-RET-CHANGE-002: Prune respects namespace

- **Setup**: 10 entries in namespace "user:1", 10 in namespace "user:2", all 60 days old.
- **Input**: `pruneChanges(30)` on service with namespace "user:1".
- **Expected**: Returns `10`. Namespace "user:2" entries are untouched.

### TV-RET-IDEMP-001: Prune idempotency records

- **Setup**: 20 idempotency records — 10 created 14 days ago, 10 created today.
- **Input**: `pruneIdempotency(7)`
- **Expected**: Returns `10`. 10 entries remain.

### TV-RET-CONFIG-001: Retention defaults

- **Input**: `createDatafnServer({ schema, db })` (no retention config).
- **Expected**: No pruning occurs at startup or on interval.

### TV-RET-STARTUP-001: Prune on startup

- **Input**: `createDatafnServer({ schema, db, retention: { changeLogDays: 30, idempotencyDays: 7, pruneOnStartup: true } })`
- **Expected**: Pruning runs during initialization. Server still starts even if pruning throws.

### TV-RET-INTERVAL-001: Periodic pruning

- **Input**: `createDatafnServer({ ..., retention: { changeLogDays: 30, pruneIntervalMs: 3600000 } })`
- **Expected**: `setInterval` is called. Timer can be cleared via server close/shutdown.

---

## Rate Limiting

### TV-RATE-001: Under limit — request passes

- **Config**: `rateLimit: { enabled: true, maxRequests: 5, windowSeconds: 60 }`
- **Input**: 5 POST /datafn/query requests from same client within 60s.
- **Expected**: All 5 return HTTP 200.

### TV-RATE-002: Over limit — request rejected

- **Config**: Same as TV-RATE-001.
- **Input**: 6th POST /datafn/query request from same client within 60s.
- **Expected**: HTTP 429 with `{ ok: false, error: { code: "RATE_LIMITED", message: "Too many requests" } }`.

### TV-RATE-REDIS-001: Redis-backed rate limiter

- **Config**: Redis adapter provided + `rateLimit: { enabled: true }`.
- **Input**: Request from client "user:1".
- **Expected**: Redis `INCR` called with key matching `ratelimit:query:user:1:*`. TTL set on first call.

### TV-RATE-MEMORY-001: Memory fallback

- **Config**: No Redis + `rateLimit: { enabled: true, maxRequests: 2, windowSeconds: 10 }`.
- **Input**: 3 requests within 10s.
- **Expected**: First 2 pass, 3rd returns 429. After 10s window expires, requests pass again.

### TV-RATE-OVERRIDE-001: Per-endpoint override

- **Config**: `rateLimit: { enabled: true, maxRequests: 100, endpoints: { mutation: { maxRequests: 10, windowSeconds: 60 } } }`
- **Input**: 11 POST /datafn/mutation requests.
- **Expected**: 11th mutation returns 429. Query endpoint still allows up to 100.

### TV-RATE-CONFIG-001: Disabled rate limiting

- **Config**: `rateLimit: { enabled: false }` or no rateLimit config.
- **Expected**: No requests are ever rate-limited.

---

## Observability

### TV-OBS-QUERY-001: Query timing event

- **Config**: `observability: { timing: true }`
- **Input**: POST /datafn/query with a simple query.
- **Expected**: `onTiming` (or `console.debug`) called with:
  ```json
  {
    "endpoint": "/datafn/query",
    "resource": "task",
    "phases": {
      "validate": 1,
      "plan": 0,
      "fetch": 5,
      "filter": 0,
      "sort": 0,
      "paginate": 0,
      "materialize": 1,
      "total": 7
    },
    "totalMs": 7,
    "timestamp": "2026-02-24T20:15:00.000Z"
  }
  ```
  (Exact durations vary; structure and field presence is what matters.)

### TV-OBS-MUT-001: Mutation timing event

- **Config**: `observability: { timing: true }`
- **Input**: POST /datafn/mutation with an insert.
- **Expected**: Event with phases: `validate`, `guard`, `execute`, `changeLog`, `idempotency`.

### TV-OBS-SYNC-001: Pull timing event

- **Config**: `observability: { timing: true }`
- **Input**: POST /datafn/pull.
- **Expected**: Event with phases: `validate`, `fetchChanges`, `buildResult`.

### TV-OBS-CONFIG-001: Timing disabled

- **Config**: No observability config.
- **Expected**: No timing events emitted. No performance overhead.

---

## Python

### TV-PY-BATCH-001: Batch record fetch in pull

- **Setup**: 50 change entries (all upserts) for resource "task".
- **Input**: `handle_pull({ cursors: { "task": "0" } })`
- **Expected**: Records fetched with a single `find_many(where=[id IN [...]])` call instead of 50 individual `find_one` calls.

### TV-PY-BOUND-001: Bounded change fetch in Python

- **Setup**: 1000 change entries for resource "task".
- **Input**: `get_changes_since("task", 0, limit=100)`
- **Expected**: Returns exactly 100 entries with server_seq 1-100.

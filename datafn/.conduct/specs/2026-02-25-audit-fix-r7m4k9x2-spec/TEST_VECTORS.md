# TEST VECTORS: DataFn Remaining Production-Readiness Fixes

---

## IN_MEMORY Targeted Secondary Loading

### TV-INMEM-SEC-001

- **Description**: IN_MEMORY query with `$any` relation filter loads only referenced secondary records (many-many).
- **Input**:
  - Schema: `tasks` (primary), `tags` (secondary), many-many relation `tasks.tags`.
  - Data: `tasks` = 3 records (t1: tagIds [tag1, tag2], t2: tagIds [tag1], t3: no tags), `tags` = 1000 records (tag1..tag1000).
  - SCALE-004 pre-filter: `{ status: "active" }` → primary returns t1, t2 (t3 is status=inactive).
  - Query: `{ resource: "tasks", filters: { status: "active", tags: { $any: { label: "urgent" } } }, limit: 10 }`.
- **Expected Output**:
  - `adapter.findMany` for `tags` is called with `where: [{ field: "id", operator: "in", value: ["tag1", "tag2"] }]` (only IDs from t1, t2's join rows).
  - NOT called with empty `where` (which would load all 1000 tags).
  - Final result contains only tasks whose tags match `{ label: "urgent" }`.
- **Negative Variant**:
  - If the relation path cannot be determined (missing schema metadata), falls back to full load and emits warning (TV-INMEM-SEC-006).

### TV-INMEM-SEC-002

- **Description**: IN_MEMORY query with `$any` relation filter loads only referenced secondary records (many-one).
- **Input**:
  - Schema: `tasks` (primary), `categories` (secondary), many-one relation `tasks.category` with FK `categoryId`.
  - Data: `tasks` = 5 records with categoryId values [cat1, cat1, cat2, cat3, cat1], `categories` = 500 records.
  - Query: `{ resource: "tasks", filters: { category: { $any: { type: "work" } } } }`.
- **Expected Output**:
  - After primary load (5 tasks), extract unique FK values: `["cat1", "cat2", "cat3"]`.
  - `adapter.findMany` for `categories` called with `where: [{ field: "id", operator: "in", value: ["cat1", "cat2", "cat3"] }]`.
  - Only 3 category records loaded, not 500.

### TV-INMEM-SEC-003

- **Description**: IN_MEMORY query with `$any` relation filter loads only referenced secondary records (one-many inverse).
- **Input**:
  - Schema: `projects` (primary), `tasks` (secondary), one-many relation where tasks have `projectId` FK.
  - Data: `projects` = 2 records (p1, p2), `tasks` = 10000 records.
  - Query: `{ resource: "projects", filters: { tasks: { $any: { status: "done" } } } }`.
- **Expected Output**:
  - After primary load (2 projects), extract primary IDs: `["p1", "p2"]`.
  - `adapter.findMany` for `tasks` called with `where: [{ field: "projectId", operator: "in", value: ["p1", "p2"] }]`.
  - Only tasks belonging to p1 and p2 are loaded, not all 10000.

### TV-INMEM-SEC-004

- **Description**: IN_MEMORY query with both relation filter and relation select — secondary loaded once.
- **Input**:
  - Schema: `tasks`, `tags`, many-many.
  - Query: `{ resource: "tasks", select: ["id", "title", "tags.*"], filters: { tags: { $any: { label: "urgent" } } } }`.
- **Expected Output**:
  - `tags` resource appears in `resourcesToLoad` from BOTH filter discovery and select discovery.
  - `adapter.findMany` for `tags` is called exactly ONCE (not twice).
  - Both filter evaluation and select materialization use the same loaded tag records.

### TV-INMEM-SEC-005

- **Description**: IN_MEMORY query where pre-filtered primary set is empty — skip secondary loading.
- **Input**:
  - Schema: `tasks`, `tags`, many-many.
  - Data: `tasks` = 100 records, all with `status: "archived"`.
  - Pre-filter: `{ status: "active" }` → 0 primary records.
  - Query: `{ resource: "tasks", filters: { status: "active", tags: { $any: { label: "urgent" } } } }`.
- **Expected Output**:
  - `adapter.findMany` for `tasks` returns `[]`.
  - `adapter.findMany` for `tags` is NEVER called.
  - Query result: `{ data: [], count: 0 }`.

### TV-INMEM-SEC-006

- **Description**: Fallback to full secondary load when FK path is undetermined.
- **Input**:
  - Schema: `tasks`, `mystery` (relation defined but missing `fkField`, `joinTable`, `joinColumns`).
  - Query triggers IN_MEMORY with `mystery` as secondary resource.
- **Expected Output**:
  - `adapter.findMany` for `mystery` is called with empty `where: []` (full load).
  - `console.warn` is called with message containing "Falling back to full secondary load for resource: mystery".
  - Query results are still correct.

---

## getLatestServerSeq Fix

### TV-SEQ-001

- **Description**: getLatestServerSeq returns correct value using DESC + limit:1.
- **Input**:
  - `__datafn_changes` contains 5 entries for resource "tasks" with server_seq values [1, 5, 3, 10, 7].
- **Expected Output**:
  - `db.internal.findMany` called with `{ orderBy: "-server_seq", limit: 1 }`.
  - Returns `10`.
- **Negative Variant**:
  - `db.internal.findMany` is NOT called with `{ orderBy: "server_seq" }` (ascending, no limit).

### TV-SEQ-002

- **Description**: getLatestServerSeq returns 0 when no changes exist.
- **Input**:
  - `__datafn_changes` contains 0 entries for resource "tasks".
- **Expected Output**:
  - `db.internal.findMany` returns `[]`.
  - Returns `0`.

---

## Batch ServerSeq Allocation

### TV-BATCH-SEQ-001

- **Description**: getNextN allocates contiguous range.
- **Input**:
  - `__datafn_meta` row: `{ namespace: "datafn", next_server_seq: 10 }`.
  - Call: `getNextN("datafn", 3)`.
- **Expected Output**:
  - Returns `[10, 11, 12]`.
  - `__datafn_meta` row updated to `{ next_server_seq: 13 }`.

### TV-BATCH-SEQ-002

- **Description**: getNextN with count=1 is equivalent to getNext.
- **Input**:
  - `__datafn_meta` row: `{ namespace: "datafn", next_server_seq: 5 }`.
  - Call: `getNextN("datafn", 1)`.
- **Expected Output**:
  - Returns `[5]`.
  - `__datafn_meta` row updated to `{ next_server_seq: 6 }`.

### TV-BATCH-SEQ-003

- **Description**: getNextN rejects invalid count.
- **Input**:
  - Call: `getNextN("datafn", 0)`.
  - Call: `getNextN("datafn", -1)`.
  - Call: `getNextN("datafn", 1001)`.
- **Expected Output**:
  - All throw Error with message containing "count must be a positive integer".

### TV-BATCH-SEQ-004

- **Description**: FallbackSequenceStore.getNextN delegates correctly.
- **Input**:
  - Primary: healthy, returns `[10, 11, 12]` for `getNextN("datafn", 3)`.
  - Call: `fallbackStore.getNextN("datafn", 3)`.
- **Expected Output**:
  - Returns `[10, 11, 12]` (delegated to primary).
- **Negative Variant**:
  - Primary unhealthy → delegates to fallback (DB store), returns correct contiguous range.

---

## Batch Change Recording

### TV-BATCH-CHG-001

- **Description**: recordChanges inserts multiple entries.
- **Input**:
  ```json
  [
    { "serverSeq": 10, "resource": "tasks", "id": "t1", "op": "merge", "record": { "id": "t1", "categoryId": "c1" } },
    { "serverSeq": 11, "resource": "join_tasks_tags", "id": "t1:tag1", "op": "insert", "record": { "from": "t1", "to": "tag1" } },
    { "serverSeq": 12, "resource": "join_tasks_tags", "id": "t1:tag2", "op": "insert", "record": { "from": "t1", "to": "tag2" } }
  ]
  ```
- **Expected Output**:
  - 3 rows created in `__datafn_changes`.
  - `db.internal.create` called 3 times with correct data.
  - Entries inserted in array order (serverSeq 10, 11, 12).

### TV-BATCH-CHG-002

- **Description**: recordChanges propagates error on failure.
- **Input**:
  - 3 entries, second entry causes `db.internal.create` to throw.
- **Expected Output**:
  - Error is thrown after the second entry.
  - First entry was successfully created.
  - Third entry is NOT created (early exit on error).

### TV-BATCH-CHG-003

- **Description**: Relation mutation uses batch allocation + recording.
- **Input**:
  - Relate mutation: `{ operation: "relate", resource: "tasks", id: "t1", relations: { tags: [{ toId: "tag1" }, { toId: "tag2" }] } }`.
  - Schema: many-many with join table.
  - This produces 2 FK deltas + 2 join deltas = 4 total deltas.
- **Expected Output**:
  - `getNextServerSeqBatch(4)` called once (NOT 4x `getNextServerSeq()`).
  - `recordChanges([...4 entries...])` called once (NOT 4x `recordChange()`).
  - Change entries have contiguous serverSeq values.
- **Negative Variant**:
  - Regular (non-relation) mutations still use singular `getNextServerSeq()` + `recordChange()` (no regression).

---

## Relation Mutation Optimization

### TV-REL-OPT-001

- **Description**: Batch target existence validation with all targets existing.
- **Input**:
  - Relate: `{ resource: "tasks", id: "t1", relations: { tags: [{ toId: "tag1" }, { toId: "tag2" }, { toId: "tag3" }] } }`.
  - All 3 tags exist in database.
- **Expected Output**:
  - `adapter.findMany({ model: "tags", where: [{ field: "id", operator: "in", value: ["tag1", "tag2", "tag3"] }] })` called once.
  - `adapter.findOne` for target validation is NOT called.
  - Mutation succeeds.

### TV-REL-OPT-002

- **Description**: Batch target existence validation with missing target.
- **Input**:
  - Relate: `{ resource: "tasks", id: "t1", relations: { tags: [{ toId: "tag1" }, { toId: "tag999" }, { toId: "tag3" }] } }`.
  - `tag999` does NOT exist.
- **Expected Output**:
  - `adapter.findMany` returns `[tag1, tag3]` (2 records).
  - Mutation returns `{ ok: false, code: "NOT_FOUND", message: "Related record not found: tag999" }`.
  - No join rows are created (early exit before any writes).

### TV-REL-OPT-003

- **Description**: Many-many join uses upsert instead of findOne+create.
- **Input**:
  - Relate: `{ resource: "tasks", id: "t1", relations: { tags: [{ toId: "tag1", metadata: { order: 1 } }] } }`.
  - Join row `t1:tag1` does NOT exist.
- **Expected Output**:
  - `adapter.upsert({ model: joinTable, where: [{ field: "from", ... }, { field: "to", ... }], create: { id: "t1:tag1", from: "t1", to: "tag1", order: 1 }, update: { order: 1 } })` called.
  - `adapter.findOne` for join existence check is NOT called.
  - Join row created with all fields.

### TV-REL-OPT-004

- **Description**: Many-many join upsert updates existing row with metadata.
- **Input**:
  - Relate: `{ resource: "tasks", id: "t1", relations: { tags: [{ toId: "tag1", metadata: { order: 5 } }] } }`.
  - Join row `t1:tag1` ALREADY exists with `{ order: 1 }`.
- **Expected Output**:
  - `adapter.upsert` called with `update: { order: 5 }`.
  - Join row updated to `{ order: 5 }`.
  - `from` and `to` columns are NOT modified (only metadata updated).

---

## Client Pull Pagination

### TV-CLIENT-PULL-001

- **Description**: Server sets hasMore=true when changes are truncated.
- **Input**:
  - 150 total changes across all resources.
  - Request `limit: 100`.
- **Expected Output**:
  - Response contains first 100 changes (sorted by serverSeq).
  - `hasMore: true` in response.
  - `cursors` reflect the highest serverSeq in the returned 100 changes.

### TV-CLIENT-PULL-002

- **Description**: Server sets hasMore=false when all changes fit.
- **Input**:
  - 50 total changes across all resources.
  - Request `limit: 100`.
- **Expected Output**:
  - Response contains all 50 changes.
  - `hasMore: false` (or field absent).
  - `cursors` reflect the highest serverSeq across all resources.

### TV-CLIENT-PULL-003

- **Description**: Client catch-up loop pulls until hasMore is false.
- **Input**:
  - Mock server: first pull returns `{ hasMore: true, cursors: { tasks: "50" } }`, second pull returns `{ hasMore: false, cursors: { tasks: "80" } }`.
  - Client `pullBatchSize: 50`.
- **Expected Output**:
  - `remote.pull()` called exactly 2 times.
  - First call: `cursors: { tasks: "0" }`.
  - Second call: `cursors: { tasks: "50" }` (updated from first response).
  - `applyPullResult()` called 2 times (once per iteration).
  - `sync_applied` event emitted once (after second iteration).

### TV-CLIENT-PULL-004

- **Description**: Client handles single-batch pull (no catch-up needed).
- **Input**:
  - Mock server: pull returns `{ hasMore: false, cursors: { tasks: "30" } }`.
- **Expected Output**:
  - `remote.pull()` called exactly 1 time.
  - `applyPullResult()` called 1 time.
  - `sync_applied` event emitted 1 time.
  - Behavior identical to current (no regression).

### TV-CLIENT-PULL-005

- **Description**: Client catch-up loop stops at maxPullIterations.
- **Input**:
  - Mock server: always returns `{ hasMore: true }`.
  - Client `maxPullIterations: 3`.
- **Expected Output**:
  - `remote.pull()` called exactly 3 times.
  - `console.warn` emitted with message containing "max iterations".
  - `sync_applied` event still emitted (not treated as failure).
  - Changes from all 3 iterations are applied to storage.

### TV-CLIENT-PULL-006

- **Description**: Hooks run once across all catch-up iterations.
- **Input**:
  - Mock server: 2 iterations (first hasMore=true, second hasMore=false).
  - `beforeSync` and `afterSync` hooks configured.
- **Expected Output**:
  - `runBeforeSync()` called exactly 1 time (before first pull).
  - `runAfterSync()` called exactly 1 time (after last pull, with last result).
  - Hooks do NOT run per-iteration.

# TEST VECTORS: Python Package Parity with TypeScript (Non-Capabilities)

---

## Filter Operators

### TV-FILT-001: $in operator
- **Description**: Filter with $in checks array membership
- **Input**:
  ```json
  {"record": {"status": "active"}, "filter": {"status": {"$in": ["active", "pending"]}}}
  ```
- **Expected output**: `true`
- **Negative variant**:
  ```json
  {"record": {"status": "closed"}, "filter": {"status": {"$in": ["active", "pending"]}}}
  ```
  Expected: `false`

### TV-FILT-002: $nin operator
- **Description**: Filter with $nin checks array non-membership
- **Input**:
  ```json
  {"record": {"status": "closed"}, "filter": {"status": {"$nin": ["active", "pending"]}}}
  ```
- **Expected output**: `true`
- **Negative variant**:
  ```json
  {"record": {"status": "active"}, "filter": {"status": {"$nin": ["active", "pending"]}}}
  ```
  Expected: `false`

### TV-FILT-003: $like operator
- **Description**: SQL LIKE pattern matching (case-sensitive)
- **Input**:
  ```json
  {"record": {"name": "Hello World"}, "filter": {"name": {"$like": "Hello%"}}}
  ```
- **Expected output**: `true`
- **Negative variant**:
  ```json
  {"record": {"name": "hello world"}, "filter": {"name": {"$like": "Hello%"}}}
  ```
  Expected: `false` (case-sensitive)

### TV-FILT-004: $ilike operator
- **Description**: SQL LIKE pattern matching (case-insensitive)
- **Input**:
  ```json
  {"record": {"name": "Hello World"}, "filter": {"name": {"$ilike": "hello%"}}}
  ```
- **Expected output**: `true`

### TV-FILT-005: $is_null operator
- **Description**: Check if value is None
- **Input**:
  ```json
  {"record": {"email": null}, "filter": {"email": {"$is_null": true}}}
  ```
- **Expected output**: `true`
- **Negative variant**:
  ```json
  {"record": {"email": "test@example.com"}, "filter": {"email": {"$is_null": true}}}
  ```
  Expected: `false`
- **Inverse variant**:
  ```json
  {"record": {"email": "test@example.com"}, "filter": {"email": {"$is_null": false}}}
  ```
  Expected: `true`

### TV-FILT-006: $is_empty operator
- **Description**: Check if value is empty (None, empty string, empty list)
- **Input (None)**:
  ```json
  {"record": {"tags": null}, "filter": {"tags": {"$is_empty": true}}}
  ```
  Expected: `true`
- **Input (empty string)**:
  ```json
  {"record": {"name": ""}, "filter": {"name": {"$is_empty": true}}}
  ```
  Expected: `true`
- **Input (empty list)**:
  ```json
  {"record": {"items": []}, "filter": {"items": {"$is_empty": true}}}
  ```
  Expected: `true`
- **Negative variant**:
  ```json
  {"record": {"name": "hello"}, "filter": {"name": {"$is_empty": true}}}
  ```
  Expected: `false`

### TV-FILT-007: $contains / $startsWith / $endsWith
- **Description**: String containment operators
- **Input ($contains)**:
  ```json
  {"record": {"title": "Hello World"}, "filter": {"title": {"$contains": "lo Wor"}}}
  ```
  Expected: `true`
- **Input ($startsWith)**:
  ```json
  {"record": {"title": "Hello World"}, "filter": {"title": {"$startsWith": "Hello"}}}
  ```
  Expected: `true`
- **Input ($endsWith)**:
  ```json
  {"record": {"title": "Hello World"}, "filter": {"title": {"$endsWith": "World"}}}
  ```
  Expected: `true`
- **Negative variant**:
  ```json
  {"record": {"title": "Hello World"}, "filter": {"title": {"$startsWith": "World"}}}
  ```
  Expected: `false`

### TV-FILT-008: $before / $after (date comparison)
- **Description**: Epoch millisecond comparison for dates
- **Input ($before)**:
  ```json
  {"record": {"createdAt": 1704067200000}, "filter": {"createdAt": {"$before": 1704153600000}}}
  ```
  Expected: `true`
- **Input ($after)**:
  ```json
  {"record": {"createdAt": 1704153600000}, "filter": {"createdAt": {"$after": 1704067200000}}}
  ```
  Expected: `true`

### TV-FILT-009: $between / $not_between
- **Description**: Range check (inclusive)
- **Input ($between)**:
  ```json
  {"record": {"priority": 5}, "filter": {"priority": {"$between": [3, 7]}}}
  ```
  Expected: `true`
- **Boundary ($between)**:
  ```json
  {"record": {"priority": 3}, "filter": {"priority": {"$between": [3, 7]}}}
  ```
  Expected: `true` (inclusive)
- **Negative ($not_between)**:
  ```json
  {"record": {"priority": 5}, "filter": {"priority": {"$not_between": [3, 7]}}}
  ```
  Expected: `false`

### TV-FILT-010: Null values with comparison operators
- **Description**: Null values with comparison operators return False
- **Input**:
  ```json
  {"record": {"score": null}, "filter": {"score": {"$gt": 5}}}
  ```
- **Expected output**: `false`

### TV-FILT-011: normalize_filter_ops remapping
- **Description**: Remap non-$ operators to $-prefixed
- **Input**:
  ```json
  {"status": {"eq": "active"}, "priority": {"gte": 3, "lte": 10}}
  ```
- **Expected output**:
  ```json
  {"status": {"$eq": "active"}, "priority": {"$gte": 3, "$lte": 10}}
  ```

### TV-FILT-012: $and logical operator
- **Description**: All conditions must be true
- **Input**:
  ```json
  {"record": {"status": "active", "priority": 5}, "filter": {"$and": [{"status": {"$eq": "active"}}, {"priority": {"$gte": 3}}]}}
  ```
- **Expected output**: `true`
- **Negative variant**:
  ```json
  {"record": {"status": "closed", "priority": 5}, "filter": {"$and": [{"status": {"$eq": "active"}}, {"priority": {"$gte": 3}}]}}
  ```
  Expected: `false`

### TV-FILT-013: $or logical operator
- **Description**: Any condition must be true
- **Input**:
  ```json
  {"record": {"status": "closed", "priority": 5}, "filter": {"$or": [{"status": {"$eq": "active"}}, {"priority": {"$gte": 3}}]}}
  ```
- **Expected output**: `true`
- **Negative variant**:
  ```json
  {"record": {"status": "closed", "priority": 1}, "filter": {"$or": [{"status": {"$eq": "active"}}, {"priority": {"$gte": 3}}]}}
  ```
  Expected: `false`

### TV-FILT-014: Dot-path filter traversal
- **Description**: Nested object field access via dot notation
- **Input**:
  ```json
  {"record": {"metadata": {"priority": 5}}, "filter": {"metadata.priority": {"$eq": 5}}}
  ```
- **Expected output**: `true`
- **Missing intermediate key**:
  ```json
  {"record": {"metadata": {}}, "filter": {"metadata.priority": {"$eq": 5}}}
  ```
  Expected: `false`

### TV-FILT-015: Filter depth limit exceeded
- **Description**: Deeply nested filter rejected
- **Input**: Filter with 11 levels of `$and` nesting (exceeds default maxFilterDepth=10)
- **Expected output**: `{"ok": false, "error": {"code": "LIMIT_EXCEEDED", "message": "Filter depth exceeds maximum of 10"}}`

---

## Sort

### TV-SORT-001: Sort term parsing
- **Description**: Parse various sort formats
- **Input**: `["name", "priority:desc", "-createdAt", "id:asc"]`
- **Expected output**:
  ```json
  [
    {"field": "name", "direction": "asc"},
    {"field": "priority", "direction": "desc"},
    {"field": "createdAt", "direction": "desc"},
    {"field": "id", "direction": "asc"}
  ]
  ```

### TV-SORT-002: In-memory sorting with nulls
- **Description**: Records sorted with null handling
- **Input**:
  ```json
  {
    "records": [
      {"id": "3", "name": null},
      {"id": "1", "name": "Alice"},
      {"id": "2", "name": "Bob"}
    ],
    "sort": [{"field": "name", "direction": "asc"}]
  }
  ```
- **Expected output** (nulls last in ascending):
  ```json
  [
    {"id": "1", "name": "Alice"},
    {"id": "2", "name": "Bob"},
    {"id": "3", "name": null}
  ]
  ```

### TV-SORT-003: Sort tie-breaking by id
- **Description**: Equal sort values tie-broken by id ascending
- **Input**:
  ```json
  {
    "records": [
      {"id": "c", "priority": 1},
      {"id": "a", "priority": 1},
      {"id": "b", "priority": 1}
    ],
    "sort": [{"field": "priority", "direction": "asc"}]
  }
  ```
- **Expected output**:
  ```json
  [
    {"id": "a", "priority": 1},
    {"id": "b", "priority": 1},
    {"id": "c", "priority": 1}
  ]
  ```

### TV-SORT-004: Default sort when none provided
- **Description**: Query without sort gets id:asc default
- **Input**: Query payload with no `sort` field
- **Expected output**: Results sorted by `id` ascending

---

## Select/Omit

### TV-SEL-001: Select token parsing
- **Description**: Parse select token strings
- **Input**: `"tags.*"`
- **Expected output**: `{"path": ["tags", "*"], "base_name": "tags", "directive": "*"}`

### TV-SEL-002: Select whitelist
- **Description**: Only selected fields returned
- **Input**:
  ```json
  {
    "query": {"resource": "tasks", "version": 1, "select": ["id", "title"]},
    "records": [{"id": "1", "title": "Task 1", "description": "desc", "priority": 5}]
  }
  ```
- **Expected output**:
  ```json
  [{"id": "1", "title": "Task 1"}]
  ```

### TV-SEL-003: Omit blacklist
- **Description**: Omitted fields excluded
- **Input**:
  ```json
  {
    "query": {"resource": "tasks", "version": 1, "omit": ["description"]},
    "records": [{"id": "1", "title": "Task 1", "description": "desc", "priority": 5}]
  }
  ```
- **Expected output**:
  ```json
  [{"id": "1", "title": "Task 1", "priority": 5}]
  ```

---

## Date Utilities

### TV-DATE-001: Date coercion
- **Description**: Various date formats coerced to epoch ms
- **Input (ISO string)**: `"2024-01-01T00:00:00Z"` → `1704067200000`
- **Input (epoch int)**: `1704067200000` → `1704067200000`
- **Input (datetime)**: `datetime(2024, 1, 1, tzinfo=UTC)` → `1704067200000`
- **Negative (invalid)**: `"not-a-date"` → `ValueError`

---

## Aggregation

### TV-AGG-001: Aggregation operations
- **Description**: All aggregation ops on a set of records
- **Input**:
  ```json
  {
    "records": [
      {"id": "1", "score": 10},
      {"id": "2", "score": 20},
      {"id": "3", "score": null},
      {"id": "4", "score": 30}
    ]
  }
  ```
- **Expected outputs**:
  - `count("score")` → `4` (includes null in count)
  - `sum("score")` → `60` (excludes null)
  - `avg("score")` → `20.0` (excludes null)
  - `min("score")` → `10` (excludes null)
  - `max("score")` → `30` (excludes null)
- **Empty set**: All return `null` except count returns `0`

---

## DFQL Normalization

### TV-NORM-001: DFQL normalization
- **Description**: Deterministic key ordering
- **Input**: `{"b": 2, "a": 1, "c": {"z": 3, "y": 2}}`
- **Expected output**: `{"a": 1, "b": 2, "c": {"y": 2, "z": 3}}`
- **dfql_key output**: `'{"a":1,"b":2,"c":{"y":2,"z":3}}'`

---

## Join Table Utilities

### TV-JOIN-001: Join table name derivation
- **Description**: Canonical join table naming
- **Input**: `get_join_table_name("tasks", "tags")`
- **Expected output**: `"__datafn_join_tasks_tags"`
- **Custom joinTable**: `get_join_table_name("tasks", "tags", joinTable="custom_join")` → `"custom_join"`

---

## Namespace Helper

### TV-NS-001: Namespace composition
- **Description**: Compose namespace string
- **Input**: `ns("org-acme", "user-123")`
- **Expected output**: `"org-acme:user-123"`
- **Empty segments**: `ns("org", "", "user")` → `"org:user"`
- **Negative**: `ns()` → `ValueError`

---

## Validation

### TV-VAL-001: Schema validation - valid schema
- **Description**: Valid schema passes validation
- **Input**:
  ```json
  {
    "resources": [
      {"name": "tasks", "version": 1, "fields": [{"name": "title", "type": "string", "required": true}]}
    ]
  }
  ```
- **Expected output**: No error, server created successfully

### TV-VAL-002: Schema validation - duplicate resource
- **Description**: Duplicate resource names rejected
- **Input**:
  ```json
  {
    "resources": [
      {"name": "tasks", "version": 1, "fields": []},
      {"name": "tasks", "version": 1, "fields": []}
    ]
  }
  ```
- **Expected output**: Error with code `SCHEMA_INVALID`

### TV-VAL-003: FK field injection
- **Description**: FK field added to writable fields
- **Input**: Schema with `relations: [{"from": "tasks", "to": "projects", "type": "many-one", "relation": "project"}]`
- **Expected**: `projectId` appears in tasks' writable fields; mutation with `{"projectId": "proj_1"}` is valid

### TV-VAL-004: Read-only field rejection
- **Description**: Mutation writing read-only field rejected
- **Input**: Mutation with `{"id": "new_id"}` in record
- **Expected output**: Error — `id` is read-only

### TV-VAL-005: Field type validation
- **Description**: Wrong type rejected
- **Input**: Field `title` (type: string) with value `123`
- **Expected output**: `{"ok": false, "error": {"code": "DFQL_INVALID", "message": "Field 'title' expects string, got number"}}`

### TV-VAL-006: Required field missing
- **Description**: Insert without required field
- **Input**: Insert mutation for resource with required `title` field, record `{"priority": 5}`
- **Expected output**: `{"ok": false, "error": {"code": "DFQL_INVALID", "message": "Required field 'title' missing"}}`

### TV-VAL-007: Default value application
- **Description**: Missing field gets default value
- **Input**: Insert for resource with field `{"name": "status", "type": "string", "default": "pending"}`, record `{"title": "Task 1"}`
- **Expected**: Record inserted with `status: "pending"`

### TV-VAL-008: Prototype pollution rejected
- **Description**: Record with __proto__ key rejected
- **Input**: `{"__proto__": {"isAdmin": true}, "title": "hack"}`
- **Expected output**: `{"ok": false, "error": {"code": "DFQL_INVALID", "message": "Prototype pollution detected: __proto__"}}`
- **Nested variant**: `{"data": {"__proto__": {}}}` → same error

### TV-VAL-009: Limit enforcement
- **Description**: Query exceeding maxSelectTokens rejected
- **Input**: Query with 51 select tokens, config `maxSelectTokens: 50`
- **Expected output**: `{"ok": false, "error": {"code": "LIMIT_EXCEEDED"}}`

### TV-VAL-010: ID length validation
- **Description**: Excessively long ID rejected
- **Input**: Mutation with `id` of 300 characters, config `maxIdLength: 255`
- **Expected output**: `{"ok": false, "error": {"code": "DFQL_INVALID", "message": "ID exceeds maximum length of 255"}}`

---

## Query Handler

### TV-QRY-001: Forward cursor pagination
- **Description**: cursor.after skips records at/before cursor
- **Input**:
  ```json
  {
    "resource": "tasks", "version": 1,
    "sort": ["priority:desc", "id"],
    "limit": 2,
    "cursor": {"after": {"priority": 5, "id": "task_3"}}
  }
  ```
  With records: `[{id: "task_1", priority: 8}, {id: "task_2", priority: 5}, {id: "task_3", priority: 5}, {id: "task_4", priority: 3}, {id: "task_5", priority: 1}]`
- **Expected output**: `data: [{id: "task_4", priority: 3}, {id: "task_5", priority: 1}]`, `nextCursor: null`

### TV-QRY-002: Backward cursor pagination
- **Description**: cursor.before returns records before cursor
- **Input**:
  ```json
  {
    "resource": "tasks", "version": 1,
    "sort": ["id"],
    "limit": 2,
    "cursor": {"before": {"id": "task_4"}}
  }
  ```
  With records sorted by id: task_1, task_2, task_3, task_4, task_5
- **Expected output**: `data: [{id: "task_2"}, {id: "task_3"}]`

### TV-QRY-003: nextCursor computation
- **Description**: nextCursor returned when more records exist
- **Input**: Query with `limit: 2`, 5 total records sorted by id
- **Expected output**: `data: [{id: "task_1"}, {id: "task_2"}]`, `nextCursor: {"id": "task_2"}`

### TV-QRY-004: Offset pagination
- **Description**: Offset skips first N records
- **Input**: Query with `limit: 2, offset: 2`, 5 records
- **Expected output**: `data: [{id: "task_3"}, {id: "task_4"}]`

### TV-QRY-005: Limit clamping
- **Description**: Query limit clamped to maxLimit
- **Input**: Query with `limit: 5000`, config `maxLimit: 1000`
- **Expected**: Only 1000 records returned (or fewer if dataset is smaller)

### TV-QRY-006: Count query
- **Description**: Count returns total matching records
- **Input**: Query with `count: true, limit: 2`, 10 matching records
- **Expected output**: `data: [2 records], count: 10`

### TV-QRY-007: Aggregation query
- **Description**: groupBy with aggregation
- **Input**:
  ```json
  {
    "resource": "tasks", "version": 1,
    "groupBy": ["status"],
    "aggregations": {"total": {"count": "*"}, "avgPriority": {"avg": "priority"}}
  }
  ```
  With records: `[{status: "active", priority: 5}, {status: "active", priority: 3}, {status: "closed", priority: 1}]`
- **Expected output**:
  ```json
  {"data": [
    {"status": "active", "total": 2, "avgPriority": 4.0},
    {"status": "closed", "total": 1, "avgPriority": 1.0}
  ]}
  ```

### TV-QRY-008: Cursor requires id in sort
- **Description**: Cursor pagination without id sort fails
- **Input**: Query with `cursor: {"after": {"priority": 5}}`, `sort: ["priority"]` (no id)
- **Expected output**: `{"ok": false, "error": {"code": "DFQL_INVALID", "message": "Cursor pagination requires 'id' as the final sort field"}}`

---

## Mutation Handler

### TV-MUT-001: Merge decision - create vs update
- **Description**: Merge on non-existent record creates it
- **Input**: `{"operation": "merge", "id": "new_task", "record": {"title": "New Task", "status": "active"}}`
  Where `new_task` does not exist
- **Expected output**: Record created with all fields
- **Update variant**: Same id when record exists → only provided fields updated

### TV-MUT-002: Replace preserves system fields
- **Description**: Replace does not overwrite system fields from input
- **Input**: `{"operation": "replace", "id": "task_1", "record": {"title": "New Title", "createdAt": 9999}}`
- **Expected output**: `createdAt` is NOT overwritten (original value preserved), `title` is updated

### TV-MUT-003: Batch insert with records[]
- **Description**: Multiple records inserted via records[] array
- **Input**: `{"operation": "insert", "records": [{"id": "t1", "title": "A"}, {"id": "t2", "title": "B"}]}`
- **Expected output**: `affectedIds: ["t1", "t2"]`

### TV-MUT-004: Error classification
- **Description**: Database errors classified correctly
- **Duplicate key input**: Insert with existing id
- **Expected**: `{"code": "CONFLICT", "message": "..."}`
- **Guard failure input**: Mutation with failing guard
- **Expected**: `{"code": "CONFLICT", "message": "Guard condition not met"}`

### TV-MUT-005: Change tracking in mutation
- **Description**: Successful mutation writes change tracking record
- **Input**: Insert mutation for tasks resource
- **Expected**: `__datafn_changes` table has a new row with operation "insert", table "tasks"

### TV-MUT-006: Idempotent delete of non-existent record
- **Description**: Delete of missing record succeeds silently
- **Input**: `{"operation": "delete", "id": "nonexistent_id"}`
- **Expected output**: `{"ok": true, "affectedIds": []}`
- **No change tracking**: `__datafn_changes` has no new row

### TV-MUT-007: Guard with transaction
- **Description**: Guard + mutation atomic when adapter supports transactions
- **Input**: Mutation with `if: {"status": {"$eq": "active"}}` on a record that changes between guard check and mutation in non-transactional flow
- **Expected**: With transaction: guard and mutation are atomic. Without: sequential with TOCTOU risk (documented).

### TV-MUT-008: Mutation result structure
- **Description**: Complete mutation result structure
- **Input**: Successful insert mutation
- **Expected output**:
  ```json
  {"ok": true, "mutationId": "mut_xyz", "affectedIds": ["task_1"], "deduped": false, "errors": []}
  ```

---

## Transaction Handler

### TV-TXN-001: Atomic rollback
- **Description**: All steps roll back on error in atomic mode
- **Input**: 3-step transaction: insert A, insert B, insert C (C fails)
- **Expected**: A and B are NOT in database after rollback

### TV-TXN-002: Rollback annotation
- **Description**: Rolled-back results annotated
- **Input**: Same as TV-TXN-001
- **Expected output**: Steps 1 and 2 have `rolledBack: true` in results

---

## Sync Handler

### TV-SYN-001: Push date coercion
- **Description**: Date fields coerced in push mutations
- **Input**: Push with mutation record containing `{"createdAt": "2024-01-01T00:00:00Z"}`
- **Expected**: Value stored as `1704067200000` (epoch ms)

### TV-SYN-002: Pull cursor validation
- **Description**: Invalid cursor format rejected
- **Input**: Pull with `cursors: {"tasks": "abc"}`
- **Expected output**: `{"ok": false, "error": {"code": "DFQL_INVALID", "message": "Invalid cursor format"}}`

### TV-SYN-003: Pull limit enforcement
- **Description**: Pull clamped to maxPullLimit with hasMore flag
- **Input**: Pull with 200 pending changes, config `maxPullLimit: 100`
- **Expected**: 100 changes returned, `hasMore: true`

### TV-SYN-004: Join table sync in pull
- **Description**: Pull includes join table changes
- **Input**: Schema with many-many `tasks↔tags` relation; push with relate operation
- **Expected**: Pull response includes `__datafn_join_tasks_tags` changes

### TV-SYN-005: Namespace consistency
- **Description**: All adapter calls include namespace
- **Input**: Query/mutation/sync request with namespace `"org-acme:user-1"`
- **Expected**: All adapter method calls include `namespace="org-acme:user-1"`

---

## Server Infrastructure

### TV-SRV-001: Logger usage
- **Description**: Logger called on server init
- **Input**: `create_datafn_server({"schema": valid_schema, "db": adapter, "logger": mock_logger})`
- **Expected**: `mock_logger.info()` called with "DataFn server initialized"

### TV-SRV-002: Plugin before_query hook
- **Description**: Plugin modifies query before execution
- **Input**: Plugin that adds `{"limit": 10}` to all queries
- **Expected**: All queries have limit 10 regardless of input

### TV-SRV-003: Payload size limit
- **Description**: Oversized payload rejected
- **Input**: Request body of 6MB, config `maxPayloadBytes: 5242880`
- **Expected output**: `{"ok": false, "error": {"code": "LIMIT_EXCEEDED"}}`

### TV-SRV-004: Config validation
- **Description**: Missing schema config rejected
- **Input**: `create_datafn_server({"db": adapter})`
- **Expected**: `ValueError: schema is required`

---

## Authorization

### TV-AUTH-001: Field-level auth
- **Description**: Query for unauthorized field rejected
- **Input**: Query selecting `["id", "salary"]` on resource with `permissions: {"read": {"fields": ["id", "name", "email"]}}`
- **Expected output**: `{"ok": false, "error": {"code": "FORBIDDEN", "message": "Access denied for field 'salary' on resource 'employees'"}}`

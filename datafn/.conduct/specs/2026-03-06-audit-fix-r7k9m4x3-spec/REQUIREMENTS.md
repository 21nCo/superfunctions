# REQUIREMENTS: Python Package Parity with TypeScript (Non-Capabilities)

## Table of Contents

### Core Utilities
- [FILT-001](#filt-001) Full filter operator support
- [FILT-002](#filt-002) Filter operator remapping (normalizeFilterOps)
- [FILT-003](#filt-003) Logical operators ($and, $or)
- [FILT-004](#filt-004) Dot-path filter traversal
- [FILT-005](#filt-005) Filter depth limiting
- [SORT-001](#sort-001) Sort term parsing
- [SORT-002](#sort-002) In-memory record sorting
- [SORT-003](#sort-003) Default sort enforcement
- [SEL-001](#sel-001) Select token parsing
- [SEL-002](#sel-002) Select/omit application on results
- [DATE-001](#date-001) Date coercion utilities
- [AGG-001](#agg-001) Aggregation operations
- [NORM-001](#norm-001) DFQL normalization
- [JOIN-001](#join-001) Join table utilities
- [NS-001](#ns-001) Namespace helper

### Validation & Schema
- [VAL-001](#val-001) Schema validation on init
- [VAL-002](#val-002) FK field injection in SchemaIndex
- [VAL-003](#val-003) Read-only field tracking
- [VAL-004](#val-004) Field type validation
- [VAL-005](#val-005) Required field validation
- [VAL-006](#val-006) Default value application
- [VAL-007](#val-007) Prototype pollution check
- [VAL-008](#val-008) Limit enforcement
- [VAL-009](#val-009) ID length validation

### Query Handler
- [QRY-001](#qry-001) Cursor pagination (forward)
- [QRY-002](#qry-002) Cursor pagination (backward)
- [QRY-003](#qry-003) nextCursor computation
- [QRY-004](#qry-004) Offset pagination
- [QRY-005](#qry-005) Limit enforcement
- [QRY-006](#qry-006) Count queries
- [QRY-007](#qry-007) Aggregation queries
- [QRY-008](#qry-008) Select/omit in query results
- [QRY-009](#qry-009) Sort validation for cursor

### Mutation Handler
- [MUT-001](#mut-001) Merge decision logic
- [MUT-002](#mut-002) Replace record logic
- [MUT-003](#mut-003) Batch insert (records[])
- [MUT-004](#mut-004) Error classification
- [MUT-005](#mut-005) Change tracking in mutations
- [MUT-006](#mut-006) Idempotent delete
- [MUT-007](#mut-007) Guard transaction wrapping
- [MUT-008](#mut-008) Mutation result structure

### Transaction Handler
- [TXN-001](#txn-001) Atomic transaction wrapping
- [TXN-002](#txn-002) Rollback annotation

### Sync Handler
- [SYN-001](#syn-001) Push date coercion
- [SYN-002](#syn-002) Pull cursor validation
- [SYN-003](#syn-003) Pull limit enforcement
- [SYN-004](#syn-004) Join table sync in pull
- [SYN-005](#syn-005) Namespace consistency

### Server Infrastructure
- [SRV-001](#srv-001) Logger interface
- [SRV-002](#srv-002) Plugin/hook system
- [SRV-003](#srv-003) Payload size limit
- [SRV-004](#srv-004) Config validation

### Authorization
- [AUTH-001](#auth-001) Field-level authorization

---

## Core Utilities

### FILT-001
- **ID**: FILT-001
- **Priority**: P0
- **Statement**: Python `evaluate_filter()` MUST support all 22 filter operators matching the TypeScript implementation.
- **Rationale**: Currently only 6 operators are implemented (`eq`, `ne`, `gt`, `gte`, `lt`, `lte`). Production queries require `$in`, `$like`, `$is_null`, `$between`, etc.
- **Acceptance criteria**:
  - `$in` and `$nin` evaluate array membership correctly
  - `$like` and `$ilike` support SQL LIKE patterns (`%` and `_` wildcards)
  - `$not_like` and `$not_ilike` negate pattern matches
  - `$is_null` returns True when value is None and argument is True
  - `$is_not_null` returns True when value is not None
  - `$is_empty` returns True for None, empty string, empty list
  - `$is_not_empty` returns True for non-empty values
  - `$contains`, `$startsWith`, `$endsWith` perform string operations
  - `$before` and `$after` compare epoch millisecond values
  - `$between` returns True when value is within [min, max] inclusive
  - `$not_between` negates `$between`
- **Test vectors**: TV-FILT-001 through TV-FILT-010
- **Notes**: Operator behavior MUST match TypeScript exactly. Null values for comparison operators return False (not an error).

### FILT-002
- **ID**: FILT-002
- **Priority**: P0
- **Statement**: Python MUST implement `normalize_filter_ops()` that remaps non-`$`-prefixed operators to `$`-prefixed form.
- **Rationale**: TypeScript supports both `eq` and `$eq` syntax. Python must accept both.
- **Acceptance criteria**:
  - `{"status": {"eq": "active"}}` is remapped to `{"status": {"$eq": "active"}}`
  - All 22 operators have remapping entries matching `OP_REMAP` in TypeScript
  - Nested filters are remapped recursively
  - Already-`$`-prefixed operators are preserved
- **Test vectors**: TV-FILT-011
- **Notes**: Edge case — operator keys that start with `$` are NOT remapped.

### FILT-003
- **ID**: FILT-003
- **Priority**: P0
- **Statement**: Python `evaluate_filter()` MUST support `$and` and `$or` logical operators.
- **Rationale**: Complex filter conditions require logical combination.
- **Acceptance criteria**:
  - `$and` requires ALL conditions to be true
  - `$or` requires ANY condition to be true
  - Logical operators can be nested
  - Empty `$and` array returns True
  - Empty `$or` array returns False
- **Test vectors**: TV-FILT-012, TV-FILT-013
- **Notes**: `$and` is the implicit default when multiple keys are at the same level.

### FILT-004
- **ID**: FILT-004
- **Priority**: P1
- **Statement**: Python `evaluate_filter()` MUST support dot-path traversal for nested object fields.
- **Rationale**: Filters like `{"metadata.priority": {"$eq": 1}}` need nested access.
- **Acceptance criteria**:
  - `{"a.b": {"$eq": 1}}` traverses record `{"a": {"b": 1}}`
  - Missing intermediate keys return None (no error)
  - Array indices are NOT supported (only object keys)
- **Test vectors**: TV-FILT-014
- **Notes**: Relation traversal is deferred (requires adapter callback).

### FILT-005
- **ID**: FILT-005
- **Priority**: P1
- **Statement**: Python MUST reject filters that exceed `maxFilterDepth` nesting levels.
- **Rationale**: Prevents abuse via deeply nested filter trees.
- **Acceptance criteria**:
  - Filters deeper than `maxFilterDepth` (default 10) return `LIMIT_EXCEEDED` error
  - Depth counts each nested `$and`/`$or` level
- **Test vectors**: TV-FILT-015
- **Notes**: Counted at filter evaluation time, not at normalization time.

### SORT-001
- **ID**: SORT-001
- **Priority**: P0
- **Statement**: Python MUST implement `parse_sort_terms()` that parses DFQL sort strings into structured terms.
- **Rationale**: TypeScript has `parseSortTerms()` in `sort.ts`. Python currently has no sort parsing.
- **Acceptance criteria**:
  - `"field"` → `{"field": "field", "direction": "asc"}`
  - `"field:asc"` → `{"field": "field", "direction": "asc"}`
  - `"field:desc"` → `{"field": "field", "direction": "desc"}`
  - `"-field"` → `{"field": "field", "direction": "desc"}`
  - Returns list of parsed terms
- **Test vectors**: TV-SORT-001
- **Notes**: None.

### SORT-002
- **ID**: SORT-002
- **Priority**: P0
- **Statement**: Python MUST implement `sort_records()` for in-memory record sorting with null handling and id tie-breaking.
- **Rationale**: TypeScript has `sortRecords()`. Python queries return unsorted results.
- **Acceptance criteria**:
  - Sorts by multiple terms in order
  - Nulls sort AFTER non-nulls in ascending, BEFORE in descending
  - Equal-valued records are tie-broken by `id` ascending
  - Stable sort (preserves insertion order for equal keys)
- **Test vectors**: TV-SORT-002, TV-SORT-003
- **Notes**: Uses Python's `functools.cmp_to_key` for multi-key sorting.

### SORT-003
- **ID**: SORT-003
- **Priority**: P0
- **Statement**: When no sort is provided in a query, Python MUST default to `["id:asc"]`.
- **Rationale**: Deterministic ordering is required for cursor pagination and test reproducibility.
- **Acceptance criteria**:
  - Query with no `sort` field gets sorted by `id` ascending
  - Query with explicit `sort` is not modified
- **Test vectors**: TV-SORT-004
- **Notes**: Applied in query handler before sorting/pagination.

### SEL-001
- **ID**: SEL-001
- **Priority**: P1
- **Statement**: Python MUST implement `parse_select_token()` for parsing field selection tokens.
- **Rationale**: TypeScript supports select/omit tokens with dot-paths and directives.
- **Acceptance criteria**:
  - `"id"` → `{"path": ["id"], "base_name": "id", "directive": None}`
  - `"tags.*"` → `{"path": ["tags", "*"], "base_name": "tags", "directive": "*"}`
- **Test vectors**: TV-SEL-001
- **Notes**: Used internally by select/omit application.

### SEL-002
- **ID**: SEL-002
- **Priority**: P1
- **Statement**: Python query handler MUST apply `select` and `omit` to query results, filtering returned fields.
- **Rationale**: Currently Python returns all fields regardless of select/omit.
- **Acceptance criteria**:
  - When `select` is provided, only listed fields (plus `id`) appear in results
  - When `omit` is provided, listed fields are excluded from results
  - `select` and `omit` MUST NOT be used together (return error)
  - `id` is always included regardless of omit
- **Test vectors**: TV-SEL-002, TV-SEL-003
- **Notes**: Relation expansion via select tokens is deferred.

### DATE-001
- **ID**: DATE-001
- **Priority**: P0
- **Statement**: Python MUST implement `to_epoch_ms()`, `from_epoch_ms()`, and `coerce_date_fields_to_epoch()` utilities.
- **Rationale**: TypeScript coerces dates in push/mutation; Python does not.
- **Acceptance criteria**:
  - `to_epoch_ms(datetime)` returns epoch milliseconds as int
  - `to_epoch_ms("2024-01-01T00:00:00Z")` parses ISO 8601 string
  - `to_epoch_ms(1704067200000)` returns the number unchanged
  - `from_epoch_ms(1704067200000)` returns datetime object
  - `coerce_date_fields_to_epoch(record, fields)` converts date-typed fields in-place
  - Invalid dates raise ValueError
- **Test vectors**: TV-DATE-001
- **Notes**: Used in push handler and mutation handler.

### AGG-001
- **ID**: AGG-001
- **Priority**: P1
- **Statement**: Python MUST implement `calculate_aggregation()` supporting `count`, `sum`, `min`, `max`, `avg`.
- **Rationale**: TypeScript supports aggregation queries. Python has no aggregation.
- **Acceptance criteria**:
  - `count` returns record count regardless of field
  - `sum` returns sum of field values, excluding None
  - `min` / `max` return min/max of field values, excluding None
  - `avg` returns average of field values, excluding None
  - All return `None` for empty record sets (SQL semantics)
- **Test vectors**: TV-AGG-001
- **Notes**: Used by query handler when `aggregations` key is present.

### NORM-001
- **ID**: NORM-001
- **Priority**: P2
- **Statement**: Python MUST implement `normalize_dfql()` and `dfql_key()` for deterministic DFQL normalization.
- **Rationale**: Needed for cache key generation and deterministic comparison.
- **Acceptance criteria**:
  - Object keys are sorted alphabetically
  - `None` is preserved, missing keys are dropped
  - `dfql_key()` returns stable JSON string
- **Test vectors**: TV-NORM-001
- **Notes**: Lower priority — primarily used for caching.

### JOIN-001
- **ID**: JOIN-001
- **Priority**: P1
- **Statement**: Python MUST implement `get_join_table_name()` and `get_join_store_key()` matching TypeScript.
- **Rationale**: Python has hardcoded join table logic instead of using canonical utilities.
- **Acceptance criteria**:
  - `get_join_table_name("tasks", "tags")` → `"__datafn_join_tasks_tags"`
  - Custom `joinTable` from relation schema is used when specified
  - `get_join_store_key("tasks", "tags", "tags")` → `"join_tasks_tags_tags"`
- **Test vectors**: TV-JOIN-001
- **Notes**: Must be used everywhere join tables are referenced.

### NS-001
- **ID**: NS-001
- **Priority**: P2
- **Statement**: Python MUST implement `ns()` helper for composing namespace strings.
- **Rationale**: TypeScript exports `ns()`. Python hardcodes "datafn" as namespace.
- **Acceptance criteria**:
  - `ns("org-acme", "user-123")` → `"org-acme:user-123"`
  - Empty segments are skipped: `ns("org", "", "user")` → `"org:user"`
  - No args raises ValueError
- **Test vectors**: TV-NS-001
- **Notes**: Low priority — namespace provider is deferred.

---

## Validation & Schema

### VAL-001
- **ID**: VAL-001
- **Priority**: P0
- **Statement**: `create_datafn_server()` MUST validate the schema at initialization and raise an error immediately if invalid.
- **Rationale**: TypeScript validates schema on init. Python currently accepts any dict.
- **Acceptance criteria**:
  - Missing `resources` key raises error
  - Empty resources list raises error
  - Duplicate resource names raise error
  - Duplicate field names within a resource raise error
  - Resources exceeding 100 raises error
  - Fields exceeding 200 per resource raises error
  - Invalid relation references raise error
- **Test vectors**: TV-VAL-001, TV-VAL-002
- **Notes**: Validation runs synchronously before returning server instance.

### VAL-002
- **ID**: VAL-002
- **Priority**: P0
- **Statement**: `SchemaIndex._build_index()` MUST inject FK fields from many-one relations into the resource's field set.
- **Rationale**: TypeScript SchemaIndex adds FK fields. Python ignores them, causing validation to reject valid FK updates.
- **Acceptance criteria**:
  - For a many-one relation with `fkField: "projectId"`, the FK field appears in the resource's writable fields
  - FK field has type `string`, required `false`, readonly `false`
  - If `fkField` is not specified, it is derived as `{relationName}Id`
- **Test vectors**: TV-VAL-003
- **Notes**: Critical for relation mutation validation.

### VAL-003
- **ID**: VAL-003
- **Priority**: P0
- **Statement**: `SchemaIndex` MUST track read-only fields separately from writable fields.
- **Rationale**: TypeScript distinguishes `READONLY_SYSTEM_FIELDS`. Python treats all system fields uniformly.
- **Acceptance criteria**:
  - `id` is always read-only
  - Fields with `readonly: true` in schema are tracked as read-only
  - `validate_record_keys()` rejects writes to read-only fields
- **Test vectors**: TV-VAL-004
- **Notes**: Critical for mutation safety.

### VAL-004
- **ID**: VAL-004
- **Priority**: P0
- **Statement**: Python MUST validate field values against their schema-defined types during mutations.
- **Rationale**: TypeScript validates field types. Python accepts any value for any field.
- **Acceptance criteria**:
  - `string` fields reject non-string values
  - `number` fields reject non-numeric values
  - `boolean` fields reject non-boolean values
  - `date` fields accept ISO 8601 strings, epoch numbers, and datetime objects
  - `object` fields accept dicts
  - `array` fields accept lists
  - `json` fields accept any JSON-serializable value
  - Nullable fields accept `None` regardless of type
- **Test vectors**: TV-VAL-005
- **Notes**: Applied in mutation handler before DB write.

### VAL-005
- **ID**: VAL-005
- **Priority**: P0
- **Statement**: Python MUST validate that required fields are present for insert operations.
- **Rationale**: TypeScript validates required fields. Python inserts incomplete records.
- **Acceptance criteria**:
  - Insert mutation without required field returns `DFQL_INVALID` error
  - Merge (update) mutation does NOT require required fields (partial update)
  - Fields with defaults are not required even when `required: true`
- **Test vectors**: TV-VAL-006
- **Notes**: Only applies to insert, not merge/update.

### VAL-006
- **ID**: VAL-006
- **Priority**: P1
- **Statement**: Python MUST apply schema-defined default values when fields are missing from insert records.
- **Rationale**: TypeScript applies defaults. Python does not.
- **Acceptance criteria**:
  - Fields with `default` in schema get the default value when not provided
  - Default values are applied only for insert (not merge/update)
  - Default values are applied before validation
- **Test vectors**: TV-VAL-007
- **Notes**: Applied in mutation handler.

### VAL-007
- **ID**: VAL-007
- **Priority**: P0
- **Statement**: Python MUST check all incoming record data for prototype pollution keys (`__proto__`, `constructor`, `prototype`).
- **Rationale**: Security requirement. TypeScript has `checkPrototypePollution()`. Python has none.
- **Acceptance criteria**:
  - Records containing `__proto__` key at any depth are rejected with `DFQL_INVALID`
  - Records containing `constructor` key at any depth are rejected
  - Records containing `prototype` key at any depth are rejected
  - Check is recursive (nested objects are scanned)
- **Test vectors**: TV-VAL-008
- **Notes**: Applied in mutation handler and push handler.

### VAL-008
- **ID**: VAL-008
- **Priority**: P1
- **Statement**: Python query/mutation handlers MUST enforce limits from the config.
- **Rationale**: TypeScript enforces limits. Python does not check any limits except maxTransactSteps.
- **Acceptance criteria**:
  - Query with more than `maxSelectTokens` select fields returns `LIMIT_EXCEEDED`
  - Query with more than `maxSortFields` sort fields returns `LIMIT_EXCEEDED`
  - Query with more than `maxFilterKeysPerLevel` filter keys returns `LIMIT_EXCEEDED`
  - Aggregation with more than `maxAggregations` returns `LIMIT_EXCEEDED`
  - Batch mutation with more than `maxBatchSize` mutations returns `LIMIT_EXCEEDED`
- **Test vectors**: TV-VAL-009
- **Notes**: Limits are validated before execution.

### VAL-009
- **ID**: VAL-009
- **Priority**: P1
- **Statement**: Python MUST validate that record IDs do not exceed `maxIdLength`.
- **Rationale**: Prevents abuse via excessively long IDs.
- **Acceptance criteria**:
  - IDs longer than `maxIdLength` (default 255) return `DFQL_INVALID`
  - Applied in mutation handler for insert/merge/replace/delete
- **Test vectors**: TV-VAL-010
- **Notes**: None.

---

## Query Handler

### QRY-001
- **ID**: QRY-001
- **Priority**: P0
- **Statement**: Python query handler MUST implement forward cursor pagination (`cursor.after`).
- **Rationale**: TypeScript has full cursor pagination. Python returns `nextCursor: null` always.
- **Acceptance criteria**:
  - When `cursor.after` is provided, records before and including the cursor position are excluded
  - Cursor values are compared against the sort fields in order
  - Cursor pagination requires `id` as the final sort field
  - Results are limited by `limit` parameter
- **Test vectors**: TV-QRY-001
- **Notes**: Uses the limit+1 fetch strategy to detect next page.

### QRY-002
- **ID**: QRY-002
- **Priority**: P1
- **Statement**: Python query handler MUST implement backward cursor pagination (`cursor.before`).
- **Rationale**: TypeScript supports reverse pagination.
- **Acceptance criteria**:
  - When `cursor.before` is provided, records after and including the cursor position are excluded
  - Results are returned in the original sort order (not reversed)
  - Combined with `limit`, returns the last N records before the cursor
- **Test vectors**: TV-QRY-002
- **Notes**: Less common than forward pagination but required for parity.

### QRY-003
- **ID**: QRY-003
- **Priority**: P0
- **Statement**: Python query handler MUST compute and return `nextCursor` when more records exist.
- **Rationale**: Clients need `nextCursor` to paginate.
- **Acceptance criteria**:
  - When fetching `limit + 1` records and getting more than `limit`, return `nextCursor` from the last returned record
  - `nextCursor` contains the sort field values of the last returned record
  - When no more records exist, `nextCursor` is `null`
- **Test vectors**: TV-QRY-003
- **Notes**: The cursor is a dict mapping sort field names to their values.

### QRY-004
- **ID**: QRY-004
- **Priority**: P1
- **Statement**: Python query handler MUST support `offset` pagination.
- **Rationale**: TypeScript supports offset. Python ignores it.
- **Acceptance criteria**:
  - `offset: N` skips the first N records after filtering/sorting
  - Combined with `limit`, returns a window of records
  - `offset` without `limit` returns all remaining records
- **Test vectors**: TV-QRY-004
- **Notes**: Offset is simpler than cursor but less efficient for large datasets.

### QRY-005
- **ID**: QRY-005
- **Priority**: P0
- **Statement**: Python query handler MUST enforce `maxLimit` from config, clamping query limits.
- **Rationale**: Prevents unbounded result sets.
- **Acceptance criteria**:
  - Query with `limit > maxLimit` is clamped to `maxLimit`
  - Query with no `limit` uses `maxLimit` as default
  - Clamping is silent (no error)
- **Test vectors**: TV-QRY-005
- **Notes**: Applied before pagination logic.

### QRY-006
- **ID**: QRY-006
- **Priority**: P1
- **Statement**: Python query handler MUST support `count: true` to return total record count.
- **Rationale**: TypeScript supports count queries. Python does not.
- **Acceptance criteria**:
  - When `count: true`, response includes `count` field with total matching records
  - Count is computed before limit/offset/cursor pagination
  - When `count: false` or absent, `count` is not included in response
- **Test vectors**: TV-QRY-006
- **Notes**: Count may be used with or without data retrieval.

### QRY-007
- **ID**: QRY-007
- **Priority**: P1
- **Statement**: Python query handler MUST support `groupBy`, `aggregations`, and `having` for aggregation queries.
- **Rationale**: TypeScript has full aggregation support. Python has none.
- **Acceptance criteria**:
  - `groupBy: ["status"]` groups records by field values
  - `aggregations: {"total": {"count": "*"}}` computes aggregates per group
  - `having: {"total": {"$gte": 5}}` filters groups by aggregate values
  - Without `groupBy`, aggregations are computed over the entire result set
  - Aggregation result replaces normal `data` array
- **Test vectors**: TV-QRY-007
- **Notes**: In-memory aggregation (no pushdown).

### QRY-008
- **ID**: QRY-008
- **Priority**: P1
- **Statement**: Python query handler MUST apply `select` and `omit` from the query to filter result fields.
- **Rationale**: Python currently ignores select/omit.
- **Acceptance criteria**:
  - Same as SEL-002 but applied in query execution path
  - Applied after sorting and pagination
- **Test vectors**: TV-SEL-002
- **Notes**: Reuses SEL-002 logic.

### QRY-009
- **ID**: QRY-009
- **Priority**: P0
- **Statement**: When cursor pagination is used, Python MUST validate that the sort includes `id` as the final field.
- **Rationale**: Cursor pagination requires a unique tie-breaker.
- **Acceptance criteria**:
  - If `cursor` is provided and sort does not end with `id`, return `DFQL_INVALID` error
  - Auto-appending `id` to sort is acceptable as alternative
- **Test vectors**: TV-QRY-008
- **Notes**: TypeScript auto-appends `id` to sort when cursor is used.

---

## Mutation Handler

### MUT-001
- **ID**: MUT-001
- **Priority**: P0
- **Statement**: Python MUST implement schema-aware merge decision logic (create vs update based on record existence).
- **Rationale**: TypeScript has `merge-decision.ts`. Python's merge always does update.
- **Acceptance criteria**:
  - Merge on non-existent record → insert (create)
  - Merge on existing record → update (partial merge)
  - For insert path: required fields are validated, defaults applied
  - For update path: only provided fields are updated
- **Test vectors**: TV-MUT-001
- **Notes**: Requires checking record existence before mutation.

### MUT-002
- **ID**: MUT-002
- **Priority**: P0
- **Statement**: Python MUST implement correct replace logic that preserves system fields and replaces all schema fields.
- **Rationale**: TypeScript's replace preserves `id`, `createdAt`, `createdBy`, `version`. Python overwrites everything.
- **Acceptance criteria**:
  - Replace operation preserves `id` (never overwritten)
  - Replace sets all schema fields — fields not in the incoming record are set to `null` / default
  - System fields (`createdAt`, `updatedAt`, `createdBy`, `updatedBy`) are NOT overwritten from input
- **Test vectors**: TV-MUT-002
- **Notes**: Uses schema to determine which fields to set.

### MUT-003
- **ID**: MUT-003
- **Priority**: P1
- **Statement**: Python mutation handler MUST support `records[]` array for batch inserts.
- **Rationale**: TypeScript supports batch inserts via `records` key. Python only supports single `record`.
- **Acceptance criteria**:
  - `{"operation": "insert", "records": [{...}, {...}]}` inserts multiple records
  - Each record is validated independently
  - `affectedIds` includes all inserted IDs
  - Batch respects `maxBatchSize` limit
- **Test vectors**: TV-MUT-003
- **Notes**: Only applies to `insert` operation.

### MUT-004
- **ID**: MUT-004
- **Priority**: P0
- **Statement**: Python MUST classify database errors into deterministic error codes.
- **Rationale**: TypeScript maps errors to CONFLICT, NOT_FOUND, etc. Python returns generic INTERNAL.
- **Acceptance criteria**:
  - Duplicate key / unique constraint violation → `CONFLICT`
  - Record not found for update/delete → `NOT_FOUND` (when applicable)
  - Guard condition failure → `CONFLICT` with guard details
  - Invalid field value → `DFQL_INVALID`
  - Unknown error → `INTERNAL`
- **Test vectors**: TV-MUT-004
- **Notes**: Error classification happens in a utility function, not inline.

### MUT-005
- **ID**: MUT-005
- **Priority**: P0
- **Statement**: Python mutation handler MUST integrate change tracking for all successful mutations.
- **Rationale**: TypeScript writes change tracking in mutations. Python only writes it in push.
- **Acceptance criteria**:
  - Every successful insert/merge/replace/delete writes a change tracking record
  - Change tracking includes namespace, table, operation, recordId, serverSeq, timestamp
  - Change tracking is written in the same transaction as the mutation (when transaction support exists)
- **Test vectors**: TV-MUT-005
- **Notes**: Must not write change tracking for idempotent (deduped) mutations.

### MUT-006
- **ID**: MUT-006
- **Priority**: P1
- **Statement**: Deleting a non-existent record MUST succeed without error and MUST NOT write change tracking.
- **Rationale**: Idempotent deletes. TypeScript skips change tracking for non-existent deletes.
- **Acceptance criteria**:
  - Delete of non-existent ID returns `ok: true` with empty `affectedIds`
  - No change tracking record is written
  - No error is returned
- **Test vectors**: TV-MUT-006
- **Notes**: This is the existing behavior but must be verified and change tracking must be conditional.

### MUT-007
- **ID**: MUT-007
- **Priority**: P1
- **Statement**: Python MUST evaluate guards within a transaction to prevent TOCTOU races.
- **Rationale**: TypeScript wraps guard check + mutation in a transaction. Python evaluates guard then mutates separately.
- **Acceptance criteria**:
  - When `if` guard is present and adapter supports transactions, guard check + mutation are atomic
  - If adapter lacks transaction support, guard check + mutation are sequential (with documented TOCTOU risk)
- **Test vectors**: TV-MUT-007
- **Notes**: Only changes behavior when adapter supports transactions.

### MUT-008
- **ID**: MUT-008
- **Priority**: P0
- **Statement**: Python mutation result MUST match the TypeScript structure exactly.
- **Rationale**: Response structure inconsistency causes client-side parsing failures.
- **Acceptance criteria**:
  - Result includes `ok: bool`, `mutationId: str`, `affectedIds: list`, `deduped: bool`, `errors: list`
  - `deduped` is `True` when idempotency cache was hit
  - `errors` is always a list (empty on success)
  - `affectedIds` includes all IDs affected by the mutation
- **Test vectors**: TV-MUT-008
- **Notes**: Verify against existing parity tests.

---

## Transaction Handler

### TXN-001
- **ID**: TXN-001
- **Priority**: P0
- **Statement**: Python atomic transactions MUST wrap all steps in a single database transaction.
- **Rationale**: Current implementation's atomicity is questionable.
- **Acceptance criteria**:
  - All steps in an atomic transaction either all commit or all roll back
  - On first error in atomic mode, all prior mutations are rolled back
  - Non-atomic mode continues on errors and returns partial results
- **Test vectors**: TV-TXN-001
- **Notes**: Depends on adapter supporting transaction() method.

### TXN-002
- **ID**: TXN-002
- **Priority**: P1
- **Statement**: When an atomic transaction rolls back, prior successful step results MUST be annotated as rolled back.
- **Rationale**: TypeScript marks rolled-back results. Python does not.
- **Acceptance criteria**:
  - On rollback, prior mutation results get `rolledBack: true` flag
  - Query results from prior steps are preserved (queries don't roll back)
  - The error result is included as the final entry
- **Test vectors**: TV-TXN-002
- **Notes**: Visual signal to clients that data was not persisted.

---

## Sync Handler

### SYN-001
- **ID**: SYN-001
- **Priority**: P0
- **Statement**: Python push handler MUST coerce date fields to epoch milliseconds before processing.
- **Rationale**: TypeScript coerces dates in push. Python does not, causing type mismatches.
- **Acceptance criteria**:
  - Date-typed fields in push mutation records are converted to epoch ms
  - ISO 8601 strings, datetime objects, and epoch numbers are all accepted
  - Non-date fields are not modified
- **Test vectors**: TV-SYN-001
- **Notes**: Uses DATE-001 utilities.

### SYN-002
- **ID**: SYN-002
- **Priority**: P1
- **Statement**: Python pull handler MUST validate cursor format (base-10 integer string).
- **Rationale**: TypeScript validates cursors. Python accepts anything.
- **Acceptance criteria**:
  - Non-numeric cursor values return `DFQL_INVALID` error
  - Negative cursor values return `DFQL_INVALID` error
  - Valid numeric string cursors are accepted
- **Test vectors**: TV-SYN-002
- **Notes**: None.

### SYN-003
- **ID**: SYN-003
- **Priority**: P0
- **Statement**: Python pull handler MUST enforce `maxPullLimit` and return `hasMore` flag.
- **Rationale**: TypeScript limits pull results. Python has no limit.
- **Acceptance criteria**:
  - Pull fetches at most `maxPullLimit` changes
  - When more changes exist, response includes `hasMore: true`
  - Client uses cursor from response to paginate remaining changes
- **Test vectors**: TV-SYN-003
- **Notes**: Uses limit+1 strategy to detect hasMore.

### SYN-004
- **ID**: SYN-004
- **Priority**: P1
- **Statement**: Python pull handler MUST include join table changes in pull response.
- **Rationale**: TypeScript syncs join tables. Python does not.
- **Acceptance criteria**:
  - Many-many join tables are included in pull cursors
  - Join table changes are fetched and included in upserts/deletes
  - Join table names use `get_join_table_name()` utility
- **Test vectors**: TV-SYN-004
- **Notes**: Requires JOIN-001 to be implemented first.

### SYN-005
- **ID**: SYN-005
- **Priority**: P1
- **Statement**: Python sync handlers MUST consistently pass namespace to all adapter calls.
- **Rationale**: Python inconsistently passes namespace. Some calls omit it.
- **Acceptance criteria**:
  - All `find_many`, `find_one`, `create`, `update`, `delete` calls include `namespace` parameter
  - Namespace is extracted from the request context
  - Default namespace is `"datafn"` when not provided
- **Test vectors**: TV-SYN-005
- **Notes**: Review all adapter calls in all handlers.

---

## Server Infrastructure

### SRV-001
- **ID**: SRV-001
- **Priority**: P1
- **Statement**: Python MUST implement a logger interface and accept an optional logger in config.
- **Rationale**: TypeScript has structured logging. Python has none.
- **Acceptance criteria**:
  - `DatafnLogger` protocol with `info`, `warn`, `error`, `debug` methods
  - Logger is called at server init, request start/end, and errors
  - When no logger is provided, a noop logger is used
  - Logger MUST NOT log record data or PII
- **Test vectors**: TV-SRV-001
- **Notes**: Console logger implementation is optional.

### SRV-002
- **ID**: SRV-002
- **Priority**: P2
- **Statement**: Python MUST implement a plugin/hook system matching the TypeScript before/after hook pattern.
- **Rationale**: TypeScript has a plugin system with hooks. Python has none.
- **Acceptance criteria**:
  - `before_query` hook can modify or reject queries
  - `after_query` hook can transform results
  - `before_mutation` hook can modify or reject mutations
  - `after_mutation` hook runs after successful mutations
  - Before hooks are fail-closed (first error stops chain)
  - After hooks are fail-open (errors logged but don't stop chain)
  - Plugins filtered by `runs_on: ["server"]`
- **Test vectors**: TV-SRV-002
- **Notes**: Required for search plugin integration.

### SRV-003
- **ID**: SRV-003
- **Priority**: P1
- **Statement**: Python MUST enforce `maxPayloadBytes` on incoming request bodies.
- **Rationale**: Prevents resource exhaustion from oversized payloads.
- **Acceptance criteria**:
  - Request bodies exceeding `maxPayloadBytes` return `LIMIT_EXCEEDED` error
  - Check happens before JSON parsing
  - Default limit is 5MB (5,242,880 bytes)
- **Test vectors**: TV-SRV-003
- **Notes**: Implementation depends on how the Python server integrates with ASGI/WSGI frameworks.

### SRV-004
- **ID**: SRV-004
- **Priority**: P1
- **Statement**: Python MUST validate all config parameters at server initialization.
- **Rationale**: TypeScript validates config. Python accepts any dict.
- **Acceptance criteria**:
  - Missing `schema` raises error
  - Missing `db` raises error
  - Invalid `limits` values (negative, non-numeric) raise error
  - Invalid `authorize` type (not callable) raises error
- **Test vectors**: TV-SRV-004
- **Notes**: Synchronous validation at init time.

---

## Authorization

### AUTH-001
- **ID**: AUTH-001
- **Priority**: P1
- **Statement**: Python MUST validate field-level authorization when `permissions.read.fields` or `permissions.write.fields` are defined on a resource.
- **Rationale**: TypeScript has `validateQueryAuthz` and `validateMutationAuthz`. Python has none.
- **Acceptance criteria**:
  - Query selecting fields not in `permissions.read.fields` returns `FORBIDDEN`
  - Mutation writing fields not in `permissions.write.fields` returns `FORBIDDEN`
  - When no permissions are defined, all fields are accessible (backward compatible)
  - `id` is always readable
- **Test vectors**: TV-AUTH-001
- **Notes**: Depends on resource having `permissions` in schema.

# SPEC: Python Package Parity with TypeScript (Non-Capabilities)

## Metadata

- **Timestamp**: 2026-03-06T23:45:00Z
- **Agent name**: unknown-agent
- **Model**: Claude Opus 4.6
- **Launcher**: VS Code (Claude Code Extension)
- **Workspace**: /Users/serro/Documents/dev/n/superfunctions
- **OS**: Darwin 25.3.0 / zsh
- **Git branch**: next
- **Git commit**: 635bf28 (dirty)
- **spec_folder**: `2026-03-06-audit-fix-r7k9m4x3-spec`
- **spec_folder path**: `datafn/.conduct/specs/2026-03-06-audit-fix-r7k9m4x3-spec/`
- **spec_type**: `audit-fix`
- **spec_id**: `r7k9m4x3`
- **Input paths**:
  - `datafn/.conduct/audits/2026-03-06-py7k4m9x-full-audit.md` (audit report)
  - `datafn/.conduct/specs/2026-03-06-new-k4m7x9r3-spec/` (capabilities spec — referenced but excluded from scope)
- **Audit reference**: `2026-03-06-py7k4m9x-full-audit.md`
- **Related spec**: `2026-03-06-new-k4m7x9r3-spec` (capabilities — explicitly excluded from this spec's scope)

---

## Overview

The Python server package (`datafn/python/datafn/`) implements the basic datafn server protocol (CRUD, relations, transactions, sync, idempotency, change tracking, guards, envelope pattern) but is missing approximately 70–80% of the functionality present in the TypeScript server (`datafn/server/src/`). This spec covers **all non-capabilities parity gaps** to bring Python to full feature parity with the TypeScript server.

**Explicitly excluded**: The entire capabilities system (timestamps, audit, trash, archivable, shareable) — this is handled by spec `2026-03-06-new-k4m7x9r3-spec` and is in-progress.

---

## Glossary

| Term | Definition |
|---|---|
| **DFQL** | DataFn Query Language — the JSON-based query/mutation/transaction protocol |
| **Adapter** | Database abstraction interface (Python: `Adapter` protocol in `db.py`) |
| **SchemaIndex** | In-memory indexed representation of the schema for O(1) lookups |
| **Pushdown** | Strategy where query filters/sort are delegated to the adapter vs evaluated in-memory |
| **Envelope** | Standard response wrapper `{ok: true, result: T} | {ok: false, error: E}` |
| **Guard** | Pre-mutation condition that must hold on the target record |
| **Join Table** | Internal table (`__datafn_join_{from}_{relation}`) for many-many relationships |
| **FK Field** | Foreign key field auto-injected into resources for many-one/one-many relations |
| **serverSeq** | Monotonically increasing sequence number for change tracking |
| **Cursor** | Opaque pagination token based on sort field values |
| **Select Token** | Field selection specifier supporting dot-paths and directives (e.g. `tags.*`) |
| **Namespace** | Tenant isolation string (e.g. `org-acme:user-123`) |

---

## Goals

1. Bring the Python `datafn` server package to **full feature parity** with the TypeScript server on ALL non-capabilities functionality.
2. Ensure Python error codes, envelope shapes, and behavior match TypeScript exactly.
3. Add comprehensive test coverage for all new functionality.
4. Maintain the existing Python API surface — no breaking changes to `create_datafn_server()`.

## Non-Goals

- Capabilities system (timestamps, audit, trash, archivable, shareable) — handled by separate spec.
- Client-side SDK (Python is server-only).
- Codegen (Drizzle is TS-only).
- WebSocket support (deferred — TS has it, but complex to port).
- Redis adapter integration (deferred — Python adapters are user-provided).
- REST endpoint generation (deferred — TS optional feature).
- Rate limiting (deferred — depends on Redis/external store).

---

## Public API

### `create_datafn_server(config) -> dict`

No signature changes. The `config` dict gains enforcement of existing keys:

```python
config = {
    "schema": DatafnSchema,       # MUST be validated on init (NEW)
    "db": Adapter,                 # Database adapter (unchanged)
    "authorize": Optional[Callable],  # Async auth function (unchanged)
    "plugins": Optional[List[DatafnPlugin]],  # NEW: Plugin list
    "logger": Optional[DatafnLogger],  # NEW: Logger interface
    "limits": Optional[Dict],      # NEW: Enforced limits config
}
```

Returns `{"routes": {...}}` — unchanged.

### Limits Config

```python
limits = {
    "maxLimit": 1000,               # Max records per query (default 1000)
    "maxTransactSteps": 100,        # Max steps per transaction (default 100, unchanged)
    "maxPayloadBytes": 5_242_880,   # Max request body size (5MB default)
    "maxPullLimit": 5000,           # Max changes per pull (default 5000)
    "maxBatchSize": 100,            # Max mutations in batch (default 100)
    "maxSelectTokens": 50,          # Max select/omit tokens (default 50)
    "maxFilterKeysPerLevel": 20,    # Max filter keys per nesting level (default 20)
    "maxSortFields": 10,            # Max sort fields (default 10)
    "maxAggregations": 10,          # Max aggregation ops (default 10)
    "maxIdLength": 255,             # Max ID string length (default 255)
    "maxFilterDepth": 10,           # Max filter nesting depth (default 10)
    "maxSearchQueryLength": 500,    # Max search query string (default 500)
    "maxLikePatternLength": 200,    # Max LIKE pattern length (default 200)
}
```

### Logger Interface

```python
class DatafnLogger(Protocol):
    def info(self, message: str, context: Optional[Dict] = None) -> None: ...
    def warn(self, message: str, context: Optional[Dict] = None) -> None: ...
    def error(self, message: str, context: Optional[Dict] = None) -> None: ...
    def debug(self, message: str, context: Optional[Dict] = None) -> None: ...
```

### Plugin Interface

```python
class DatafnPlugin(Protocol):
    name: str
    runs_on: List[str]  # ["server"]

    async def before_query(self, ctx: HookContext, query: dict) -> Optional[dict]: ...
    async def after_query(self, ctx: HookContext, query: dict, result: Any) -> Optional[Any]: ...
    async def before_mutation(self, ctx: HookContext, mutation: Union[dict, List[dict]]) -> Optional[Union[dict, List[dict]]]: ...
    async def after_mutation(self, ctx: HookContext, mutation: Union[dict, List[dict]], result: Any) -> None: ...
```

---

## Data Formats / Protocol

### Query Request Envelope

```json
{
  "resource": "tasks",
  "version": 1,
  "select": ["id", "title", "tags.*"],
  "omit": ["internalNotes"],
  "filters": {"status": {"$eq": "active"}, "priority": {"$gte": 3}},
  "sort": ["priority:desc", "-createdAt", "id"],
  "limit": 25,
  "offset": 0,
  "cursor": {"after": {"priority": 3, "createdAt": 1709000000000, "id": "task_abc"}},
  "count": true,
  "groupBy": ["status"],
  "aggregations": {"totalPriority": {"sum": "priority"}, "avgPriority": {"avg": "priority"}},
  "having": {"totalPriority": {"$gte": 10}}
}
```

### Query Response Envelope

```json
{
  "ok": true,
  "result": {
    "data": [...],
    "nextCursor": {"priority": 1, "createdAt": 1709000000000, "id": "task_xyz"},
    "count": 42
  }
}
```

### Mutation Result Shape

```json
{
  "ok": true,
  "result": {
    "ok": true,
    "mutationId": "mut_abc",
    "affectedIds": ["task_1", "task_2"],
    "deduped": false,
    "errors": []
  }
}
```

### Error Response Envelope

```json
{
  "ok": false,
  "error": {
    "code": "DFQL_UNKNOWN_FIELD",
    "message": "Unknown field 'foo' on resource 'tasks'",
    "details": {"path": "mutation.record.foo"}
  }
}
```

---

## Semantics

### Filter Evaluation

Python MUST support ALL filter operators from the TypeScript implementation:

| Operator | Semantics |
|---|---|
| `$eq` / `eq` | Equality (strict) |
| `$ne` / `ne` | Not equal |
| `$gt` / `gt` | Greater than |
| `$gte` / `gte` | Greater than or equal |
| `$lt` / `lt` | Less than |
| `$lte` / `lte` | Less than or equal |
| `$in` / `in` | Value in array |
| `$nin` / `not_in` | Value not in array |
| `$like` / `like` | SQL LIKE pattern match (case-sensitive) |
| `$ilike` / `ilike` | SQL LIKE pattern match (case-insensitive) |
| `$not_like` / `not_like` | Negated LIKE |
| `$not_ilike` / `not_ilike` | Negated ILIKE |
| `$is_null` / `is_null` | Value is None (when `true`) or is not None (when `false`) |
| `$is_not_null` / `is_not_null` | Value is not None |
| `$is_empty` / `is_empty` | Value is empty string, empty list, or None |
| `$is_not_empty` / `is_not_empty` | Value is non-empty |
| `$contains` | String contains substring |
| `$startsWith` | String starts with |
| `$endsWith` | String ends with |
| `$before` | Date before value (epoch ms comparison) |
| `$after` | Date after value |
| `$between` | Value between [min, max] inclusive |
| `$not_between` | Value not between [min, max] |
| `$and` | Logical AND of conditions array |
| `$or` | Logical OR of conditions array |

Non-`$`-prefixed operators MUST be remapped to `$`-prefixed form via `normalize_filter_ops()`.

### Sort Parsing

Sort terms MUST support these formats:
- `"field"` → ascending
- `"field:asc"` → ascending
- `"field:desc"` → descending
- `"-field"` → descending

Default sort: if no sort provided, MUST default to `["id:asc"]` for deterministic ordering.

Null handling: nulls sort AFTER non-nulls in ascending, BEFORE non-nulls in descending.

### Cursor Pagination

- `cursor.after`: return records after this composite key
- `cursor.before`: return records before this composite key (reverse scan)
- Cursor keys MUST match the sort fields
- When `cursor` is used, sort MUST include `id` as the final field
- `nextCursor`: computed when more records exist (limit+1 fetch strategy)

### Aggregation

Supported operations: `count`, `sum`, `min`, `max`, `avg`
- Null/undefined values MUST be excluded from sum/min/max/avg
- Empty sets MUST return `null` (SQL semantics)
- `count` MUST return record count regardless of field

### Select/Omit

- `select`: whitelist of fields to include
- `omit`: blacklist of fields to exclude
- `select` and `omit` MUST NOT be used together
- Dot-path tokens (e.g. `tags.*`) MUST be parsed for relation expansion

### Merge Decision

When `operation: "merge"` is received:
- If record exists → update (partial merge)
- If record does not exist → insert (create)
- Required fields MUST be validated only for insert path
- Default values MUST be applied only for insert path

### Error Classification

Python MUST classify database errors into deterministic error codes:
- Duplicate key → `CONFLICT`
- Record not found → `NOT_FOUND`
- Guard failure → `CONFLICT` (with guard context)
- Validation error → `DFQL_INVALID`
- Unknown → `INTERNAL`

---

## Invariants

1. **Deterministic ordering**: Queries without explicit sort MUST default to `id:asc`.
2. **Idempotent deletes**: Deleting a non-existent record MUST succeed without error and MUST NOT write change tracking.
3. **Envelope consistency**: ALL responses MUST use `{ok, result}` or `{ok: false, error}` envelope.
4. **Filter depth limit**: Filters nested beyond `maxFilterDepth` MUST be rejected.
5. **Prototype pollution**: Record keys `__proto__`, `constructor`, `prototype` MUST be rejected.
6. **Schema validation**: Schema MUST be validated at server init; invalid schemas MUST raise immediately.
7. **Transaction atomicity**: Atomic transactions MUST roll back all changes on any step failure.
8. **Sort stability**: Records with equal sort values MUST be tie-broken by `id`.

---

## Security

- **Prototype pollution protection**: All incoming record data MUST be checked for `__proto__`, `constructor`, `prototype` keys.
- **Field-level authorization**: When `permissions.read.fields` or `permissions.write.fields` are defined on a resource, the query/mutation MUST validate field access.
- **Payload size limit**: Request bodies exceeding `maxPayloadBytes` MUST be rejected before parsing.
- **ID length limit**: Record IDs exceeding `maxIdLength` MUST be rejected.

---

## Limits/Caps

| Limit | Default | Behavior on Exceed |
|---|---|---|
| `maxLimit` | 1000 | Clamp query limit to this value |
| `maxTransactSteps` | 100 | Return `LIMIT_EXCEEDED` error |
| `maxPayloadBytes` | 5,242,880 | Return `LIMIT_EXCEEDED` error |
| `maxPullLimit` | 5000 | Clamp pull limit; set `hasMore: true` |
| `maxBatchSize` | 100 | Return `LIMIT_EXCEEDED` error |
| `maxSelectTokens` | 50 | Return `LIMIT_EXCEEDED` error |
| `maxFilterKeysPerLevel` | 20 | Return `LIMIT_EXCEEDED` error |
| `maxSortFields` | 10 | Return `LIMIT_EXCEEDED` error |
| `maxAggregations` | 10 | Return `LIMIT_EXCEEDED` error |
| `maxIdLength` | 255 | Return `DFQL_INVALID` error |
| `maxFilterDepth` | 10 | Return `LIMIT_EXCEEDED` error |

---

## Observability

- Logger MUST be called for: server init, schema validation result, each request start/end, errors.
- Logger MUST NOT log record data or PII.
- Logger MUST support `info`, `warn`, `error`, `debug` levels.
- A noop logger MUST be used when no logger is provided.

---

## Compatibility / Versioning

- The `create_datafn_server()` API MUST remain backward-compatible.
- New config keys (`plugins`, `logger`, `limits`) MUST be optional with defaults.
- Existing tests MUST continue to pass without modification.

---

## Undefined / Explicitly Deferred

- **WebSocket support**: Not in scope for this spec (complex transport layer).
- **REST endpoint generation**: Not in scope (optional TS feature).
- **Redis integration**: Not in scope (adapter-level concern).
- **Rate limiting**: Not in scope (requires external store).
- **Search plugin execution**: Hook points MUST be added but actual search implementation is adapter-specific.
- **Query pushdown/classification**: Python will evaluate all queries in-memory for now; adapter-level pushdown is deferred.
- **Capabilities system**: Explicitly excluded — handled by `2026-03-06-new-k4m7x9r3-spec`.

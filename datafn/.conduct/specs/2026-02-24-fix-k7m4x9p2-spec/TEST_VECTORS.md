# TEST VECTORS: Consolidate Duplicated Code Into @datafn/core

## System Fields

### TV-SYS-001: SYSTEM_FIELDS and READONLY_SYSTEM_FIELDS membership

- **Vector ID**: TV-SYS-001
- **Description**: Verify the system field sets contain the correct members and exclude non-system fields.
- **Input**:
  ```typescript
  import { SYSTEM_FIELDS, READONLY_SYSTEM_FIELDS } from "@datafn/core";
  ```
- **Expected output**:
  - `SYSTEM_FIELDS.has("id")` === `true`
  - `SYSTEM_FIELDS.has("createdAt")` === `true`
  - `SYSTEM_FIELDS.has("updatedAt")` === `true`
  - `SYSTEM_FIELDS.has("createdBy")` === `true`
  - `SYSTEM_FIELDS.has("updatedBy")` === `true`
  - `SYSTEM_FIELDS.has("isArchived")` === `true`
  - `SYSTEM_FIELDS.has("title")` === `false`
  - `SYSTEM_FIELDS.has("name")` === `false`
  - `SYSTEM_FIELDS.size` === `6`
  - `READONLY_SYSTEM_FIELDS.has("createdAt")` === `true`
  - `READONLY_SYSTEM_FIELDS.has("updatedAt")` === `true`
  - `READONLY_SYSTEM_FIELDS.has("createdBy")` === `true`
  - `READONLY_SYSTEM_FIELDS.has("updatedBy")` === `true`
  - `READONLY_SYSTEM_FIELDS.has("id")` === `false`
  - `READONLY_SYSTEM_FIELDS.has("isArchived")` === `false`
  - `READONLY_SYSTEM_FIELDS.size` === `4`
- **Negative variant**: Attempting `SYSTEM_FIELDS.add("foo")` throws a TypeError (ReadonlySet).

### TV-SYS-002: Server imports from core instead of local definition

- **Vector ID**: TV-SYS-002
- **Description**: Verify that `server/src/validation/schema.ts` no longer defines SYSTEM_FIELDS locally.
- **Input**: Static analysis / grep.
- **Expected output**:
  - `grep -r "new Set.*createdAt.*updatedAt" datafn/server/src/` returns zero results.
  - `server/src/validation/schema.ts` contains `import { SYSTEM_FIELDS, READONLY_SYSTEM_FIELDS } from "@datafn/core"`.
- **Negative variant**: N/A.

---

## Schema Index

### TV-IDX-001: buildSchemaIndex basic lookups

- **Vector ID**: TV-IDX-001
- **Description**: Build an index and verify all lookup functions return correct results.
- **Input**:
  ```typescript
  import { buildSchemaIndex, getResource, getField, getRelationsFrom, getRelation, getRelationTarget } from "@datafn/core";

  const schema = {
    resources: [
      { name: "todos", version: 1, fields: [
        { name: "title", type: "string", required: true },
        { name: "done", type: "boolean", required: true },
      ]},
      { name: "tags", version: 1, fields: [
        { name: "label", type: "string", required: true },
      ]},
    ],
    relations: [
      { from: "todos", to: "tags", type: "many-many", relation: "tags" },
    ],
  };

  const index = buildSchemaIndex(schema);
  ```
- **Expected output**:
  - `getResource(index, "todos")?.name` === `"todos"`
  - `getResource(index, "tags")?.name` === `"tags"`
  - `getResource(index, "nonexistent")` === `undefined`
  - `getField(index, "todos", "title")?.type` === `"string"`
  - `getField(index, "todos", "nonexistent")` === `undefined`
  - `getRelationsFrom(index, "todos")` has length `1`
  - `getRelationsFrom(index, "todos")[0].relation` === `"tags"`
  - `getRelationsFrom(index, "tags")` has length `0`
  - `getRelation(index, "todos", "tags")?.to` === `"tags"`
  - `getRelation(index, "todos", "nonexistent")` === `undefined`
  - `getRelationTarget(schema.relations[0])` === `"tags"`
- **Negative variant**: `buildSchemaIndex({ resources: [] })` returns an index with empty maps.

### TV-IDX-002: buildSchemaIndex with array from/to relations

- **Vector ID**: TV-IDX-002
- **Description**: Verify that relations with array `from` and `to` fields are indexed correctly.
- **Input**:
  ```typescript
  const schema = {
    resources: [
      { name: "a", version: 1, fields: [] },
      { name: "b", version: 1, fields: [] },
      { name: "c", version: 1, fields: [] },
    ],
    relations: [
      { from: ["a", "b"], to: ["c"], type: "many-many", relation: "linked" },
    ],
  };
  const index = buildSchemaIndex(schema);
  ```
- **Expected output**:
  - `getRelationsFrom(index, "a")` has length `1`
  - `getRelationsFrom(index, "b")` has length `1`
  - `getRelationTarget(schema.relations[0])` === `"c"` (first element of array)
- **Negative variant**: N/A.

### TV-IDX-003: Server extends core SchemaIndex

- **Vector ID**: TV-IDX-003
- **Description**: Verify server's buildSchemaIndex calls core's and adds writableFieldsByResource.
- **Input**: Server's `buildSchemaIndex(schema)`.
- **Expected output**:
  - Server index has all core maps (resourcesByName, fieldsByResource, etc.).
  - Server index additionally has `writableFieldsByResource`.
  - `writableFieldsByResource.get("todos")` excludes readonly system fields.
- **Negative variant**: N/A.

### TV-IDX-004: Client uses SchemaIndex for offline lookups

- **Vector ID**: TV-IDX-004
- **Description**: Verify client's offline query path uses indexed lookups.
- **Input**: Static analysis.
- **Expected output**:
  - No `schema.resources.find()` calls in `client/src/offline/query.ts`.
  - `getResource()` or `getField()` used instead.
- **Negative variant**: N/A.

---

## Filter Evaluation

### TV-FLT-001: Basic operators ($eq, $ne, $gt, $gte, $lt, $lte)

- **Vector ID**: TV-FLT-001
- **Description**: Test basic comparison operators.
- **Input**:
  ```typescript
  import { evaluateFilter } from "@datafn/core";

  const record = { name: "Alice", age: 30, score: 85.5 };
  ```
- **Expected output**:
  - `evaluateFilter(record, { name: { $eq: "Alice" } })` === `true`
  - `evaluateFilter(record, { name: { $eq: "Bob" } })` === `false`
  - `evaluateFilter(record, { name: { $ne: "Bob" } })` === `true`
  - `evaluateFilter(record, { age: { $gt: 25 } })` === `true`
  - `evaluateFilter(record, { age: { $gt: 30 } })` === `false`
  - `evaluateFilter(record, { age: { $gte: 30 } })` === `true`
  - `evaluateFilter(record, { age: { $lt: 35 } })` === `true`
  - `evaluateFilter(record, { age: { $lte: 30 } })` === `true`
  - `evaluateFilter(record, { age: { $lte: 29 } })` === `false`
- **Negative variant**: `evaluateFilter(record, { age: { $foobar: 10 } })` throws `DatafnError` with code `DFQL_UNSUPPORTED`.

### TV-FLT-002: Set operators ($in, $nin)

- **Vector ID**: TV-FLT-002
- **Description**: Test set membership operators.
- **Input**:
  ```typescript
  const record = { status: "active", role: "admin" };
  ```
- **Expected output**:
  - `evaluateFilter(record, { status: { $in: ["active", "pending"] } })` === `true`
  - `evaluateFilter(record, { status: { $in: ["deleted", "pending"] } })` === `false`
  - `evaluateFilter(record, { role: { $nin: ["user", "guest"] } })` === `true`
  - `evaluateFilter(record, { role: { $nin: ["admin", "user"] } })` === `false`
- **Negative variant**: `evaluateFilter(record, { status: { $in: "not-an-array" } })` throws `DatafnError`.

### TV-FLT-003: String operators ($contains, $startsWith, $endsWith, $like, $ilike)

- **Vector ID**: TV-FLT-003
- **Description**: Test string matching operators.
- **Input**:
  ```typescript
  const record = { name: "Alice Johnson", email: "alice@example.com" };
  ```
- **Expected output**:
  - `evaluateFilter(record, { name: { $contains: "Johnson" } })` === `true`
  - `evaluateFilter(record, { name: { $contains: "Bob" } })` === `false`
  - `evaluateFilter(record, { name: { $startsWith: "Alice" } })` === `true`
  - `evaluateFilter(record, { name: { $endsWith: "Johnson" } })` === `true`
  - `evaluateFilter(record, { name: { $like: "Alice%" } })` === `true`
  - `evaluateFilter(record, { name: { $ilike: "alice%" } })` === `true`
  - `evaluateFilter(record, { name: { $like: "alice%" } })` === `false` (case-sensitive)
- **Negative variant**: N/A.

### TV-FLT-004: Null/empty/range operators

- **Vector ID**: TV-FLT-004
- **Description**: Test null, empty, and range operators.
- **Input**:
  ```typescript
  const record1 = { name: null, tags: [], age: 25 };
  const record2 = { name: "Alice", tags: ["urgent"], age: 25 };
  ```
- **Expected output**:
  - `evaluateFilter(record1, { name: { $is_null: true } })` === `true`
  - `evaluateFilter(record2, { name: { $is_null: true } })` === `false`
  - `evaluateFilter(record2, { name: { $is_not_null: true } })` === `true`
  - `evaluateFilter(record1, { tags: { $is_empty: true } })` === `true`
  - `evaluateFilter(record2, { tags: { $is_not_empty: true } })` === `true`
  - `evaluateFilter(record1, { age: { $between: [20, 30] } })` === `true`
  - `evaluateFilter(record1, { age: { $between: [30, 40] } })` === `false`
  - `evaluateFilter(record1, { age: { $not_between: [30, 40] } })` === `true`
- **Negative variant**: N/A.

### TV-FLT-005: Logical operators ($and, $or)

- **Vector ID**: TV-FLT-005
- **Description**: Test logical combination operators.
- **Input**:
  ```typescript
  const record = { age: 30, status: "active" };
  ```
- **Expected output**:
  - `evaluateFilter(record, { $and: [{ age: { $gt: 20 } }, { status: { $eq: "active" } }] })` === `true`
  - `evaluateFilter(record, { $and: [{ age: { $gt: 40 } }, { status: { $eq: "active" } }] })` === `false`
  - `evaluateFilter(record, { $or: [{ age: { $gt: 40 } }, { status: { $eq: "active" } }] })` === `true`
  - `evaluateFilter(record, { $or: [{ age: { $gt: 40 } }, { status: { $eq: "deleted" } }] })` === `false`
- **Negative variant**: N/A.

### TV-FLT-006: Nested object dot-path filtering (no relation resolver)

- **Vector ID**: TV-FLT-006
- **Description**: Dot-path filters on nested objects work without a relation resolver.
- **Input**:
  ```typescript
  const record = { id: "1", meta: { color: "red", priority: 5 } };
  ```
- **Expected output**:
  - `evaluateFilter(record, { "meta.color": { $eq: "red" } })` === `true`
  - `evaluateFilter(record, { "meta.priority": { $gt: 3 } })` === `true`
  - `evaluateFilter(record, { "meta.nonexistent": { $eq: "x" } })` === `false`
- **Negative variant**: N/A.

### TV-FLT-007: Client offline filter uses shared evaluateFilter

- **Vector ID**: TV-FLT-007
- **Description**: Verify client's offline query correctly delegates to shared filter.
- **Input**: Run existing client offline query tests.
- **Expected output**: All existing `local-dfql.test.ts` tests pass.
- **Negative variant**: N/A.

### TV-FLT-008: Server filter uses shared evaluateFilter with relation resolver

- **Vector ID**: TV-FLT-008
- **Description**: Verify server's filter execution correctly delegates to shared filter with relation resolver.
- **Input**: Run existing server filter/query tests.
- **Expected output**: All existing `dfql-select.test.ts` and `query-validation.test.ts` tests pass.
- **Negative variant**: N/A.

---

## Sort

### TV-SRT-001: parseSortTerms parsing

- **Vector ID**: TV-SRT-001
- **Description**: Test all sort term formats.
- **Input**:
  ```typescript
  import { parseSortTerms } from "@datafn/core";
  ```
- **Expected output**:
  - `parseSortTerms(["name"])` → `[{ field: "name", direction: "asc" }]`
  - `parseSortTerms(["name:asc"])` → `[{ field: "name", direction: "asc" }]`
  - `parseSortTerms(["name:desc"])` → `[{ field: "name", direction: "desc" }]`
  - `parseSortTerms(["-createdAt"])` → `[{ field: "createdAt", direction: "desc" }]`
  - `parseSortTerms(["-createdAt", "name"])` → `[{ field: "createdAt", direction: "desc" }, { field: "name", direction: "asc" }]`
  - `parseSortTerms(undefined)` → `[]`
  - `parseSortTerms([])` → `[]`
- **Negative variant**: N/A.

### TV-SRT-002: sortRecords with tie-breaker

- **Vector ID**: TV-SRT-002
- **Description**: Test sort with id tie-breaker.
- **Input**:
  ```typescript
  import { sortRecords, parseSortTerms } from "@datafn/core";

  const records = [
    { id: "3", name: "Charlie", age: 30 },
    { id: "1", name: "Alice", age: 30 },
    { id: "2", name: "Bob", age: 25 },
  ];
  const terms = parseSortTerms(["age:asc"]);
  const sorted = sortRecords(records, terms);
  ```
- **Expected output**:
  - `sorted[0].id` === `"2"` (Bob, age 25)
  - `sorted[1].id` === `"1"` (Alice, age 30 — id tie-breaker)
  - `sorted[2].id` === `"3"` (Charlie, age 30)
- **Negative variant**: N/A.

### TV-SRT-003: Client and server use shared sort

- **Vector ID**: TV-SRT-003
- **Description**: Verify both packages import from core.
- **Input**: Run existing sort-related tests in both client and server.
- **Expected output**: All existing sort tests pass.
- **Negative variant**: N/A.

---

## Date Codecs

### TV-DTE-001: toEpochMs and fromEpochMs conversions

- **Vector ID**: TV-DTE-001
- **Description**: Test date conversion functions.
- **Input**:
  ```typescript
  import { toEpochMs, fromEpochMs } from "@datafn/core";
  ```
- **Expected output**:
  - `toEpochMs(new Date("2024-01-01T00:00:00Z"))` === `1704067200000`
  - `toEpochMs("2024-01-01T00:00:00Z")` === `1704067200000`
  - `toEpochMs(1704067200000)` === `1704067200000` (idempotent)
  - `fromEpochMs(1704067200000).toISOString()` === `"2024-01-01T00:00:00.000Z"`
  - `fromEpochMs("2024-01-01T00:00:00Z").toISOString()` === `"2024-01-01T00:00:00.000Z"`
  - `fromEpochMs(new Date("2024-01-01T00:00:00Z")).toISOString()` === `"2024-01-01T00:00:00.000Z"` (idempotent)
- **Negative variant**: `toEpochMs("not-a-date")` throws `DatafnError` with code `DFQL_INVALID`.

### TV-DTE-002: coerceDateFieldsToEpoch schema-driven

- **Vector ID**: TV-DTE-002
- **Description**: Test schema-driven date coercion.
- **Input**:
  ```typescript
  import { coerceDateFieldsToEpoch, parseDateFieldsToDate } from "@datafn/core";

  const fields = [
    { name: "title", type: "string", required: true },
    { name: "createdAt", type: "date", required: false },
    { name: "count", type: "number", required: true },
  ];
  const record = { title: "Test", createdAt: new Date("2024-01-01T00:00:00Z"), count: 5 };
  coerceDateFieldsToEpoch(record, fields);
  ```
- **Expected output**:
  - `record.createdAt` === `1704067200000`
  - `record.title` === `"Test"` (unchanged)
  - `record.count` === `5` (unchanged)
  - After `parseDateFieldsToDate(record, fields)`: `record.createdAt` instanceof `Date` === `true`
- **Negative variant**: `coerceDateFieldsToEpoch({ createdAt: "not-a-date" }, fields)` throws `DatafnError`.

### TV-DTE-003: Client date codec delegates to core

- **Vector ID**: TV-DTE-003
- **Description**: Verify client date tests still pass after delegation.
- **Input**: Run existing client date codec tests.
- **Expected output**: All existing date codec tests pass.
- **Negative variant**: N/A.

### TV-DTE-004: Server push coercion delegates to core

- **Vector ID**: TV-DTE-004
- **Description**: Verify server push tests still pass after delegation.
- **Input**: Run existing server sync/push tests.
- **Expected output**: All existing push tests pass.
- **Negative variant**: N/A.

---

## Plugin Hook Runner

### TV-HKS-001: runBeforeHook fail-closed semantics

- **Vector ID**: TV-HKS-001
- **Description**: Before hooks stop on first error.
- **Input**:
  ```typescript
  import { runBeforeHook } from "@datafn/core";

  const callOrder: string[] = [];
  const plugins = [
    { name: "p1", runsOn: ["server"], beforeQuery: async (ctx, q) => { callOrder.push("p1"); return q; } },
    { name: "p2", runsOn: ["server"], beforeQuery: async () => { callOrder.push("p2"); throw new Error("fail"); } },
    { name: "p3", runsOn: ["server"], beforeQuery: async (ctx, q) => { callOrder.push("p3"); return q; } },
  ];

  const result = await runBeforeHook(plugins, "server", "beforeQuery", ctx, query);
  ```
- **Expected output**:
  - `result.ok` === `false`
  - `result.error.code` === `"INTERNAL"`
  - `callOrder` === `["p1", "p2"]` (p3 never called)
- **Negative variant**: N/A.

### TV-HKS-002: runAfterHook fail-open semantics

- **Vector ID**: TV-HKS-002
- **Description**: After hooks continue despite errors.
- **Input**:
  ```typescript
  import { runAfterHook } from "@datafn/core";

  const callOrder: string[] = [];
  const plugins = [
    { name: "p1", runsOn: ["client"], afterQuery: async () => { callOrder.push("p1"); } },
    { name: "p2", runsOn: ["client"], afterQuery: async () => { callOrder.push("p2"); throw new Error("fail"); } },
    { name: "p3", runsOn: ["client"], afterQuery: async () => { callOrder.push("p3"); } },
  ];

  await runAfterHook(plugins, "client", "afterQuery", ctx, query, result);
  ```
- **Expected output**:
  - `callOrder` === `["p1", "p2", "p3"]` (all called despite p2 error)
- **Negative variant**: N/A.

### TV-HKS-003: Client delegates to core hook runner

- **Vector ID**: TV-HKS-003
- **Description**: Verify client plugin tests still pass.
- **Input**: Run existing client plugin tests.
- **Expected output**: All existing client plugin tests pass.
- **Negative variant**: N/A.

### TV-HKS-004: Server delegates to core hook runner

- **Vector ID**: TV-HKS-004
- **Description**: Verify server plugin tests still pass.
- **Input**: Run existing server plugin tests.
- **Expected output**: All existing server plugin tests pass.
- **Negative variant**: N/A.

---

## Select Token Parsing

### TV-SEL-001: parseSelectToken all token formats

- **Vector ID**: TV-SEL-001
- **Description**: Test all select token formats.
- **Input**:
  ```typescript
  import { parseSelectToken } from "@datafn/core";
  ```
- **Expected output**:
  - `parseSelectToken("*")` → `{ path: ["*"], baseName: "*", directive: undefined }`
  - `parseSelectToken("title")` → `{ path: ["title"], baseName: "title", directive: undefined }`
  - `parseSelectToken("tags.*")` → `{ path: ["tags", "*"], baseName: "tags", directive: "*" }`
  - `parseSelectToken("tags.#")` → `{ path: ["tags", "#"], baseName: "tags", directive: "#" }`
  - `parseSelectToken("children.**")` → `{ path: ["children", "**"], baseName: "children", directive: "**" }`
  - `parseSelectToken("tags.*#")` → `{ path: ["tags", "*#"], baseName: "tags", directive: "*#" }`
  - `parseSelectToken("parent.*")` → `{ path: ["parent", "*"], baseName: "parent", directive: "*" }`
  - `parseSelectToken("tasks.tags.*")` → `{ path: ["tasks", "tags", "*"], baseName: "tasks", directive: "tags.*" }`
- **Negative variant**: N/A (all strings are parseable; validation is caller's responsibility).

### TV-SEL-002: Server uses shared parseSelectToken

- **Vector ID**: TV-SEL-002
- **Description**: Verify server select tests still pass.
- **Input**: Run existing server select/query tests.
- **Expected output**: All existing server select and query tests pass.
- **Negative variant**: N/A.

---

## Validation Result Alignment

### TV-VLD-001: ValidationResult uses result property

- **Vector ID**: TV-VLD-001
- **Description**: Verify server validation functions use `result` property name.
- **Input**: Run existing server validation tests.
- **Expected output**: All tests pass. `vOk(value)` returns `{ ok: true, result: value }`.
- **Negative variant**: N/A.

---

## Client Storage Adapter Dedup

### TV-STR-001: Shared adapter validation

- **Vector ID**: TV-STR-001
- **Description**: Verify both storage adapters import from shared module.
- **Input**: Run existing storage tests for both IndexedDB and memory adapters.
- **Expected output**: All existing storage tests pass.
- **Negative variant**: N/A.

---

## Client Event Emission

### TV-EVT-001: buildEvent factory

- **Vector ID**: TV-EVT-001
- **Description**: Verify event factory produces correct events.
- **Input**:
  ```typescript
  const event = buildEvent("mutation_applied", { resource: "todos", ids: ["t1"], action: "insert" });
  ```
- **Expected output**:
  - `event.type` === `"mutation_applied"`
  - `event.resource` === `"todos"`
  - `event.ids` deep equals `["t1"]`
  - `event.action` === `"insert"`
  - `typeof event.timestampMs` === `"number"`
  - `event.timestampMs` is close to `Date.now()`
- **Negative variant**: N/A.

---

## Core Exports

### TV-REG-001: All new modules importable from @datafn/core

- **Vector ID**: TV-REG-001
- **Description**: Verify all new exports are accessible from the main entry point.
- **Input**:
  ```typescript
  import {
    SYSTEM_FIELDS,
    READONLY_SYSTEM_FIELDS,
    buildSchemaIndex,
    getResource,
    getField,
    getRelationsFrom,
    getRelation,
    getRelationTarget,
    evaluateFilter,
    parseSortTerms,
    sortRecords,
    toEpochMs,
    fromEpochMs,
    coerceDateFieldsToEpoch,
    parseDateFieldsToDate,
    runBeforeHook,
    runAfterHook,
    parseSelectToken,
  } from "@datafn/core";
  ```
- **Expected output**: All imports resolve without errors. Each is a function or constant.
- **Negative variant**: N/A.

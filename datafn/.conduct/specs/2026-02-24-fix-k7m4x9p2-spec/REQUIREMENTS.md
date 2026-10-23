# REQUIREMENTS: Consolidate Duplicated Code Into @datafn/core

## Table of Contents

| ID | Priority | Summary |
|---|---|---|
| SYS-001 | P0 | SYSTEM_FIELDS and READONLY_SYSTEM_FIELDS exported from core |
| SYS-002 | P0 | All system field checks import from core |
| IDX-001 | P0 | buildSchemaIndex() in core with full lookup API |
| IDX-002 | P0 | Server validation uses core SchemaIndex |
| IDX-003 | P1 | Client uses SchemaIndex for offline query resource lookups |
| FLT-001 | P0 | Shared evaluateFilter() in core with full operator set |
| FLT-002 | P0 | Relation resolver injection via callback |
| FLT-003 | P0 | Client offline query uses shared evaluateFilter |
| FLT-004 | P0 | Server query executor uses shared evaluateFilter |
| SRT-001 | P0 | Shared parseSortTerms() in core |
| SRT-002 | P0 | Shared sortRecords() in core |
| SRT-003 | P0 | Client and server use shared sort utilities |
| DTE-001 | P0 | Shared toEpochMs() and fromEpochMs() in core |
| DTE-002 | P0 | Shared coerceDateFieldsToEpoch() and parseDateFieldsToDate() in core |
| DTE-003 | P0 | Client date codec delegates to core |
| DTE-004 | P0 | Server push coercion delegates to core |
| HKS-001 | P0 | Shared runBeforeHook() and runAfterHook() in core |
| HKS-002 | P0 | Client plugin runner delegates to core |
| HKS-003 | P0 | Server plugin runner delegates to core |
| SEL-001 | P0 | Shared parseSelectToken() in core |
| SEL-002 | P0 | Server validation and execution use shared parser |
| VLD-001 | P1 | Server ValidationResult aligned with DatafnEnvelope naming |
| STR-001 | P1 | Client storage adapter validation deduplicated |
| EVT-001 | P1 | Client event emission factory |
| REG-001 | P0 | All new core modules re-exported from core index |
| TST-001 | P0 | All existing tests pass after consolidation |
| TST-002 | P0 | New unit tests for each core module |

---

## Requirements

### SYS-001: SYSTEM_FIELDS and READONLY_SYSTEM_FIELDS exported from core

- **ID**: SYS-001
- **Priority**: P0
- **Statement**: `@datafn/core` MUST export `SYSTEM_FIELDS` as a `ReadonlySet<string>` containing `["id", "createdAt", "updatedAt", "createdBy", "updatedBy", "isArchived"]` and `READONLY_SYSTEM_FIELDS` as a `ReadonlySet<string>` containing `["createdAt", "updatedAt", "createdBy", "updatedBy"]`.
- **Rationale**: System fields are currently defined locally in `server/src/validation/schema.ts` and hardcoded in multiple server files. A single source of truth prevents omission when adding new system fields.
- **Acceptance criteria**:
  - `SYSTEM_FIELDS` is importable from `@datafn/core`.
  - `SYSTEM_FIELDS.has("id")` returns `true`.
  - `SYSTEM_FIELDS.has("title")` returns `false`.
  - `READONLY_SYSTEM_FIELDS.has("createdAt")` returns `true`.
  - `READONLY_SYSTEM_FIELDS.has("id")` returns `false`.
- **Test vectors**: TV-SYS-001
- **Notes**: These are `ReadonlySet` to prevent accidental mutation.

### SYS-002: All system field checks import from core

- **ID**: SYS-002
- **Priority**: P0
- **Statement**: Every location in `@datafn/server` that checks whether a field is a system field or readonly system field MUST import `SYSTEM_FIELDS` or `READONLY_SYSTEM_FIELDS` from `@datafn/core` instead of using a local definition or hardcoded field names.
- **Rationale**: Eliminates the risk of one location missing a system field after a future addition.
- **Acceptance criteria**:
  - `server/src/validation/schema.ts` imports from `@datafn/core` instead of defining locally.
  - No remaining `new Set(["id", "createdAt"...])` definitions in server source.
  - `grep -r "createdAt.*updatedAt.*createdBy" datafn/server/src/` returns zero hardcoded set literals.
- **Test vectors**: TV-SYS-002
- **Notes**: Server may re-export from its own validation module for convenience.

### IDX-001: buildSchemaIndex() in core with full lookup API

- **ID**: IDX-001
- **Priority**: P0
- **Statement**: `@datafn/core` MUST export `buildSchemaIndex()` that accepts a `DatafnSchema` and returns a `SchemaIndex` with `Map`-based lookups for resources, fields, and relations. MUST also export `getResource()`, `getField()`, `getRelationsFrom()`, `getRelation()`, and `getRelationTarget()` helper functions.
- **Rationale**: The server already has this (in `validation/schema.ts`). Making it shared enables O(1) lookups in client and CLI, replacing 11+ ad-hoc `.find()` calls.
- **Acceptance criteria**:
  - `buildSchemaIndex(schema)` returns a `SchemaIndex` object.
  - `getResource(index, "todos")` returns the resource schema for "todos".
  - `getResource(index, "nonexistent")` returns `undefined`.
  - `getField(index, "todos", "title")` returns the field schema.
  - `getRelationsFrom(index, "todos")` returns an array of relations where `from === "todos"`.
  - `getRelation(index, "todos", "tags")` returns the specific relation.
  - `getRelationTarget(relation)` returns the `to` resource name (first element if array).
- **Test vectors**: TV-IDX-001, TV-IDX-002
- **Notes**: The core version does NOT include server-specific validation logic (authz, writable fields). Server extends the index with additional maps if needed.

### IDX-002: Server validation uses core SchemaIndex

- **ID**: IDX-002
- **Priority**: P0
- **Statement**: `@datafn/server/src/validation/schema.ts` MUST import `buildSchemaIndex` from `@datafn/core` and extend it with server-specific maps (`writableFieldsByResource`, etc.) rather than reimplementing the base index.
- **Rationale**: Eliminates the dual implementation. Server adds its own extensions on top of the shared base.
- **Acceptance criteria**:
  - Server's `buildSchemaIndex()` calls core's `buildSchemaIndex()` internally.
  - Server's `SchemaIndex` interface extends core's `SchemaIndex` with additional server-specific maps.
  - All existing server tests pass.
- **Test vectors**: TV-IDX-003
- **Notes**: Server's extended index may include `writableFieldsByResource` which is not relevant for client.

### IDX-003: Client uses SchemaIndex for offline query resource lookups

- **ID**: IDX-003
- **Priority**: P1
- **Statement**: `@datafn/client` SHOULD build a `SchemaIndex` once during client creation and use it for resource/field lookups in offline query execution instead of repeated `schema.resources.find()` calls.
- **Rationale**: Performance improvement for large schemas. Replaces O(n) lookups with O(1).
- **Acceptance criteria**:
  - Client creates a `SchemaIndex` during initialization.
  - `offline/query.ts` uses `getResource()` / `getField()` from the index.
  - No remaining `schema.resources.find()` in the client's offline query path.
- **Test vectors**: TV-IDX-004
- **Notes**: Low priority — client schemas are typically small. Can be deferred if Phase 1 grows too large.

### FLT-001: Shared evaluateFilter() in core with full operator set

- **ID**: FLT-001
- **Priority**: P0
- **Statement**: `@datafn/core` MUST export an `evaluateFilter()` function that supports all DFQL filter operators: `$eq`, `$ne`, `$gt`, `$gte`, `$lt`, `$lte`, `$in`, `$nin`, `$contains`, `$startsWith`, `$endsWith`, `$like`, `$ilike`, `$not_like`, `$not_ilike`, `$is_null`, `$is_not_null`, `$is_empty`, `$is_not_empty`, `$before`, `$after`, `$between`, `$not_between`, `$and`, `$or`.
- **Rationale**: Client offline evaluation currently supports ~10 operators. Server supports ~22. The shared function MUST support all 22+ to ensure semantic parity.
- **Acceptance criteria**:
  - `evaluateFilter({ age: 25 }, { age: { $gt: 20 } })` returns `true`.
  - `evaluateFilter({ name: "Alice" }, { name: { $like: "Ali%" } })` returns `true`.
  - `evaluateFilter({ name: null }, { name: { $is_null: true } })` returns `true`.
  - `evaluateFilter({ age: 15 }, { age: { $between: [10, 20] } })` returns `true`.
  - `evaluateFilter({}, { $and: [{ a: { $eq: 1 } }] })` returns `false`.
  - Unsupported operator (e.g., `$foobar`) throws `DatafnError` with code `DFQL_UNSUPPORTED`.
- **Test vectors**: TV-FLT-001, TV-FLT-002, TV-FLT-003, TV-FLT-004
- **Notes**: The shared function uses the `$`-prefixed operator names (client convention). Server adapter maps its non-prefixed names (`eq`, `gt`) to `$`-prefixed before calling.

### FLT-002: Relation resolver injection via callback

- **ID**: FLT-002
- **Priority**: P0
- **Statement**: The shared `evaluateFilter()` MUST accept an optional `resolveRelation` callback for relation-aware filtering. When a filter path contains a dot (e.g., `tags.name`) and the path segment matches a relation, `evaluateFilter` MUST call `resolveRelation(resource, record.id, relationName)` to get related records and evaluate the filter against them. When `resolveRelation` is not provided, dot-paths that match relations MUST throw `DFQL_UNSUPPORTED`.
- **Rationale**: Decouples the filter evaluator from any specific data store. Server injects its `DataStore` lookup; client can inject its storage adapter lookup or omit the callback for simple field filtering.
- **Acceptance criteria**:
  - With `resolveRelation` provided: `evaluateFilter(record, { "tags.name": { $eq: "urgent" } }, { resolveRelation })` calls `resolveRelation` and evaluates against returned records.
  - Without `resolveRelation`: `evaluateFilter(record, { "tags.name": { $eq: "urgent" } })` throws `DFQL_UNSUPPORTED` if "tags" is recognized as a relation path.
  - Nested object paths (non-relation) work without a resolver: `evaluateFilter({ meta: { color: "red" } }, { "meta.color": { $eq: "red" } })` returns `true`.
- **Test vectors**: TV-FLT-005, TV-FLT-006
- **Notes**: Distinguishing relation paths from nested object paths requires schema awareness. The function MUST accept an optional `schemaIndex` or the caller pre-resolves dot paths.

### FLT-003: Client offline query uses shared evaluateFilter

- **ID**: FLT-003
- **Priority**: P0
- **Statement**: `@datafn/client/src/offline/query.ts` MUST replace its local `evaluateFilter()` implementation with the shared function from `@datafn/core`. The client MAY provide a limited `resolveRelation` callback or omit it.
- **Rationale**: Eliminates the ~100-line duplicated filter evaluator in the client.
- **Acceptance criteria**:
  - `client/src/offline/query.ts` imports `evaluateFilter` from `@datafn/core`.
  - Local `evaluateFilter` function is deleted.
  - All existing client offline query tests pass.
- **Test vectors**: TV-FLT-007
- **Notes**: None.

### FLT-004: Server query executor uses shared evaluateFilter

- **ID**: FLT-004
- **Priority**: P0
- **Statement**: `@datafn/server/src/execution/query/filters.ts` MUST delegate core operator evaluation to the shared `evaluateFilter()` from `@datafn/core`, passing its `DataStore`-backed relation resolver.
- **Rationale**: Eliminates the ~150-line duplicated operator logic in the server.
- **Acceptance criteria**:
  - `server/src/execution/query/filters.ts` imports `evaluateFilter` from `@datafn/core`.
  - Server provides a `resolveRelation` callback that uses its `DataStore` to fetch related records.
  - All existing server filter tests pass.
- **Test vectors**: TV-FLT-008
- **Notes**: The server's `evaluateFilter` wrapper may add additional logic (relation quantifiers `$any`, `$all`, `$none`) on top of the shared core.

### SRT-001: Shared parseSortTerms() in core

- **ID**: SRT-001
- **Priority**: P0
- **Statement**: `@datafn/core` MUST export a `parseSortTerms()` function that parses DFQL sort strings (`"field"`, `"field:asc"`, `"field:desc"`, `"-field"`) into `SortTerm[]` with `field` and `direction` properties.
- **Rationale**: Sort parsing is duplicated in server (`execution/query/sort.ts`) and client (`offline/query.ts` inline).
- **Acceptance criteria**:
  - `parseSortTerms(["name"])` returns `[{ field: "name", direction: "asc" }]`.
  - `parseSortTerms(["name:desc"])` returns `[{ field: "name", direction: "desc" }]`.
  - `parseSortTerms(["-createdAt"])` returns `[{ field: "createdAt", direction: "desc" }]`.
  - `parseSortTerms(undefined)` returns `[]`.
- **Test vectors**: TV-SRT-001
- **Notes**: None.

### SRT-002: Shared sortRecords() in core

- **ID**: SRT-002
- **Priority**: P0
- **Statement**: `@datafn/core` MUST export a `sortRecords()` function that sorts an array of records by the given `SortTerm[]` with a stable `id` tie-breaker.
- **Rationale**: Sort execution is duplicated in server and client with the same algorithm.
- **Acceptance criteria**:
  - Records are sorted by specified field and direction.
  - When sort values are equal, records are sorted by `id` ascending as tie-breaker.
  - Null values sort after non-null values in ascending order.
- **Test vectors**: TV-SRT-002
- **Notes**: None.

### SRT-003: Client and server use shared sort utilities

- **ID**: SRT-003
- **Priority**: P0
- **Statement**: Both `@datafn/client/src/offline/query.ts` and `@datafn/server/src/execution/query/sort.ts` MUST import `parseSortTerms` and `sortRecords` from `@datafn/core` and delete their local implementations.
- **Rationale**: Eliminates the duplicated sort logic.
- **Acceptance criteria**:
  - Client's inline sort parsing in `offline/query.ts` is replaced with `parseSortTerms()` import.
  - Server's `sort.ts` re-exports from core or imports and wraps.
  - All existing sort tests pass.
- **Test vectors**: TV-SRT-003
- **Notes**: Server's `sort.ts` may still export additional functions (e.g., `validateSortForCursor`) that are server-specific.

### DTE-001: Shared toEpochMs() and fromEpochMs() in core

- **ID**: DTE-001
- **Priority**: P0
- **Statement**: `@datafn/core` MUST export `toEpochMs(value)` that converts a `Date`, ISO string, or epoch number to epoch milliseconds, and `fromEpochMs(value)` that converts an epoch number or ISO string to a `Date` object. Both MUST be idempotent.
- **Rationale**: Date conversion is the atomic operation underlying both client codecs and server coercion.
- **Acceptance criteria**:
  - `toEpochMs(new Date("2024-01-01T00:00:00Z"))` returns `1704067200000`.
  - `toEpochMs("2024-01-01T00:00:00Z")` returns `1704067200000`.
  - `toEpochMs(1704067200000)` returns `1704067200000` (idempotent).
  - `fromEpochMs(1704067200000)` returns `new Date("2024-01-01T00:00:00Z")`.
  - `toEpochMs("not-a-date")` throws `DatafnError` with code `DFQL_INVALID`.
- **Test vectors**: TV-DTE-001
- **Notes**: None.

### DTE-002: Shared coerceDateFieldsToEpoch() and parseDateFieldsToDate() in core

- **ID**: DTE-002
- **Priority**: P0
- **Statement**: `@datafn/core` MUST export `coerceDateFieldsToEpoch(record, fields)` that converts all date-typed fields in a record to epoch milliseconds, and `parseDateFieldsToDate(record, fields)` that converts all date-typed fields to `Date` objects.
- **Rationale**: Schema-driven date coercion is duplicated between client (`codecs/date.ts`) and server (`sync/push.ts`).
- **Acceptance criteria**:
  - Given `fields = [{ name: "createdAt", type: "date", required: false }]` and `record = { createdAt: new Date("2024-01-01T00:00:00Z") }`, `coerceDateFieldsToEpoch(record, fields)` sets `record.createdAt` to `1704067200000`.
  - Non-date fields are left unchanged.
  - `null` and `undefined` values for optional date fields are left unchanged.
- **Test vectors**: TV-DTE-002
- **Notes**: These mutate the record in place for performance (matching existing behavior).

### DTE-003: Client date codec delegates to core

- **ID**: DTE-003
- **Priority**: P0
- **Statement**: `@datafn/client/src/codecs/date.ts` MUST delegate to `coerceDateFieldsToEpoch()` and `parseDateFieldsToDate()` from `@datafn/core`, removing duplicated conversion logic.
- **Rationale**: Eliminates ~80 lines of duplicated date conversion code in the client.
- **Acceptance criteria**:
  - Client's `serializeDateFields()` internally calls `coerceDateFieldsToEpoch()`.
  - Client's `parseDateFields()` internally calls `parseDateFieldsToDate()`.
  - All existing client date codec tests pass.
- **Test vectors**: TV-DTE-003
- **Notes**: The client retains its `serializeDateFields()` and `parseDateFields()` function signatures as thin wrappers, since they may handle additional client-specific concerns (error messages, path tracking).

### DTE-004: Server push coercion delegates to core

- **ID**: DTE-004
- **Priority**: P0
- **Statement**: `@datafn/server/src/execution/sync/push.ts` MUST delegate date coercion to `coerceDateFieldsToEpoch()` from `@datafn/core`, removing the local `coerceDateFields()` function.
- **Rationale**: Eliminates the duplicated server-side date coercion.
- **Acceptance criteria**:
  - Server's `push.ts` imports `coerceDateFieldsToEpoch` from `@datafn/core`.
  - Local `coerceDateFields()` function is deleted.
  - All existing server push tests pass.
- **Test vectors**: TV-DTE-004
- **Notes**: None.

### HKS-001: Shared runBeforeHook() and runAfterHook() in core

- **ID**: HKS-001
- **Priority**: P0
- **Statement**: `@datafn/core` MUST export generic `runBeforeHook()` and `runAfterHook()` functions that iterate plugins filtered by environment (`"client"` or `"server"`), invoke the named hook method, and implement fail-closed (before) or fail-open (after) semantics.
- **Rationale**: Client and server each implement 6 nearly-identical hook functions. A single generic runner eliminates this duplication.
- **Acceptance criteria**:
  - `runBeforeHook(plugins, "client", "beforeQuery", ctx, query)` invokes `beforeQuery` on each plugin where `runsOn.includes("client")`.
  - If a `before*` hook throws, the function returns `{ ok: false, error }` and stops iteration.
  - `runAfterHook(plugins, "server", "afterMutation", ctx, mutation, result)` invokes `afterMutation` on each plugin where `runsOn.includes("server")`.
  - If an `after*` hook throws, the error is logged and iteration continues.
- **Test vectors**: TV-HKS-001, TV-HKS-002
- **Notes**: The before hooks may return a transformed payload. The generic runner MUST thread the transformed payload through the chain.

### HKS-002: Client plugin runner delegates to core

- **ID**: HKS-002
- **Priority**: P0
- **Statement**: `@datafn/client/src/plugins/run-hooks.ts` MUST delegate to the shared hook runner from `@datafn/core`, removing duplicated hook iteration logic.
- **Rationale**: Eliminates ~100 lines of duplicated hook execution code in the client.
- **Acceptance criteria**:
  - Client's `runBeforeQuery()` calls `runBeforeHook(plugins, "client", "beforeQuery", ...)`.
  - Client's `runAfterQuery()` calls `runAfterHook(plugins, "client", "afterQuery", ...)`.
  - Same for mutation and sync hooks.
  - All existing client plugin tests pass.
- **Test vectors**: TV-HKS-003
- **Notes**: Client may retain thin wrapper functions for backward compat of its internal API.

### HKS-003: Server plugin runner delegates to core

- **ID**: HKS-003
- **Priority**: P0
- **Statement**: `@datafn/server/src/plugins/run-hooks.ts` MUST delegate to the shared hook runner from `@datafn/core`, removing duplicated hook iteration logic. Server-specific functions like `hasSearchPlugin()` remain in the server.
- **Rationale**: Eliminates ~100 lines of duplicated hook execution code in the server.
- **Acceptance criteria**:
  - Server's `runBeforeQuery()` calls `runBeforeHook(plugins, "server", "beforeQuery", ...)`.
  - `hasSearchPlugin()` remains in server (not moved to core).
  - All existing server plugin tests pass.
- **Test vectors**: TV-HKS-004
- **Notes**: None.

### SEL-001: Shared parseSelectToken() in core

- **ID**: SEL-001
- **Priority**: P0
- **Statement**: `@datafn/core` MUST export `parseSelectToken(token)` that splits a DFQL select token into `{ path, baseName, directive }`.
- **Rationale**: Select tokens are parsed in two separate server files. A shared parser prevents divergence.
- **Acceptance criteria**:
  - `parseSelectToken("*")` returns `{ path: ["*"], baseName: "*", directive: undefined }`.
  - `parseSelectToken("tags.*")` returns `{ path: ["tags", "*"], baseName: "tags", directive: "*" }`.
  - `parseSelectToken("children.**")` returns `{ path: ["children", "**"], baseName: "children", directive: "**" }`.
  - `parseSelectToken("tags.#")` returns `{ path: ["tags", "#"], baseName: "tags", directive: "#" }`.
  - `parseSelectToken("title")` returns `{ path: ["title"], baseName: "title", directive: undefined }`.
- **Test vectors**: TV-SEL-001
- **Notes**: None.

### SEL-002: Server validation and execution use shared parser

- **ID**: SEL-002
- **Priority**: P0
- **Statement**: Both `server/src/validation/query.ts` and `server/src/execution/query/select.ts` MUST import `parseSelectToken` from `@datafn/core` and delete their local implementations.
- **Rationale**: Ensures validation and execution parse tokens identically.
- **Acceptance criteria**:
  - `select.ts` imports `parseSelectToken` from `@datafn/core`.
  - `validation/query.ts` uses `parseSelectToken` from `@datafn/core` for its token validation.
  - All existing server select/query tests pass.
- **Test vectors**: TV-SEL-002
- **Notes**: Validation may add additional checks on top of the parsed token (e.g., relation existence).

### VLD-001: Server ValidationResult aligned with DatafnEnvelope naming

- **ID**: VLD-001
- **Priority**: P1
- **Statement**: The server's `ValidationResult<T>` type SHOULD align its success property from `value` to `result` to match `DatafnEnvelope<T>`. A compatibility type alias or adapter function MAY be used during transition.
- **Rationale**: Two parallel result types with different property names (`value` vs `result`) creates confusion.
- **Acceptance criteria**:
  - Server validation functions use `result` as the success property name.
  - Or: A `toEnvelope()` adapter is provided for translation at boundaries.
  - All existing server validation tests pass.
- **Test vectors**: TV-VLD-001
- **Notes**: Low priority. Can be a simple property rename or a gradual migration.

### STR-001: Client storage adapter validation deduplicated

- **ID**: STR-001
- **Priority**: P1
- **Statement**: The shared validation functions (`validateHydrationState`, `validateTransition`, `validateCursor`) that are duplicated between `indexedDbStorage.ts` and `memoryStorage.ts` SHOULD be extracted to `client/src/adapters/shared.ts`.
- **Rationale**: ~50 lines of identical validation code duplicated between two adapters.
- **Acceptance criteria**:
  - `adapters/shared.ts` exports `validateHydrationState()`, `validateTransition()`, `validateCursor()`.
  - Both adapters import from `shared.ts`.
  - Duplicate definitions are removed.
  - All existing storage tests pass.
- **Test vectors**: TV-STR-001
- **Notes**: This is a client-internal refactor, not moved to core.

### EVT-001: Client event emission factory

- **ID**: EVT-001
- **Priority**: P1
- **Statement**: A `buildEvent()` factory function SHOULD be created within `@datafn/client` to construct `DatafnEvent` objects with consistent defaults (timestampMs, base properties). Event construction in `client.ts`, `sync/engine.ts`, and `mutate.ts` SHOULD use this factory.
- **Rationale**: Event construction is repeated with the same base pattern in 3+ locations.
- **Acceptance criteria**:
  - `buildEvent(type, overrides)` returns a complete `DatafnEvent`.
  - `timestampMs` defaults to `Date.now()`.
  - All existing event emission call sites use `buildEvent()`.
  - All existing client event tests pass.
- **Test vectors**: TV-EVT-001
- **Notes**: Client-internal only. Not moved to core since events are client-specific.

### REG-001: All new core modules re-exported from core index

- **ID**: REG-001
- **Priority**: P0
- **Statement**: `@datafn/core/src/index.ts` MUST re-export all new modules: `system-fields`, `schema-index`, `filters`, `sort`, `date`, `hooks`, `select`.
- **Rationale**: Consumers import from `@datafn/core`, not from subpaths.
- **Acceptance criteria**:
  - `import { SYSTEM_FIELDS, buildSchemaIndex, evaluateFilter, parseSortTerms, toEpochMs, runBeforeHook, parseSelectToken } from "@datafn/core"` works.
- **Test vectors**: TV-REG-001
- **Notes**: None.

### TST-001: All existing tests pass after consolidation

- **ID**: TST-001
- **Priority**: P0
- **Statement**: All existing tests across `@datafn/core`, `@datafn/client`, `@datafn/server`, `@datafn/cli`, and `@datafn/svelte` MUST pass after all consolidation changes.
- **Rationale**: Zero-regression guarantee.
- **Acceptance criteria**:
  - `npm test` in each package exits with code 0.
  - No new test failures.
  - No skipped tests that were previously passing.
- **Test vectors**: N/A (meta-requirement)
- **Notes**: Run tests after each phase, not only at the end.

### TST-002: New unit tests for each core module

- **ID**: TST-002
- **Priority**: P0
- **Statement**: Each new module in `@datafn/core` MUST have dedicated unit tests covering the public API surface, edge cases, and error paths.
- **Rationale**: Shared code needs its own tests independent of consumer tests.
- **Acceptance criteria**:
  - `core/__tests__/system-fields.test.ts` exists with basic membership tests.
  - `core/__tests__/schema-index.test.ts` exists with build, lookup, and edge case tests.
  - `core/__tests__/filters.test.ts` exists with tests for every operator and logical combinator.
  - `core/__tests__/sort.test.ts` exists with parse and sort tests.
  - `core/__tests__/date.test.ts` exists with conversion and idempotency tests.
  - `core/__tests__/hooks.test.ts` exists with fail-closed and fail-open tests.
  - `core/__tests__/select.test.ts` exists with token parsing tests.
- **Test vectors**: All TV-* vectors serve as basis for these tests.
- **Notes**: None.

# SPEC: Consolidate Duplicated Code Into @datafn/core

## Metadata

| Field | Value |
|---|---|
| **Timestamp** | 2026-02-24T12:00:00Z |
| **Agent Name** | factory-droid |
| **Model** | claude-opus-4-6 |
| **Launcher** | CLI |
| **Workspace Path** | /Users/serro/Documents/dev/n/superfunctions |
| **OS** | darwin 25.3.0 |
| **Shell** | zsh |
| **Git Branch** | next |
| **Git Commit** | 2d1a0bf |
| **Git Dirty** | Yes |
| **Spec Folder** | 2026-02-24-fix-k7m4x9p2-spec |
| **Spec Type** | fix |
| **Spec ID** | k7m4x9p2 |
| **Input Paths** | datafn/.conduct/audits/2026-02-24-code-duplication-reusability-audit.md, datafn/.conduct/issues/2026-02-24-k4x7m9p3-issue.md, datafn/core/src/, datafn/client/src/, datafn/server/src/, datafn/cli/src/, datafn/svelte/src/ |
| **Related Issues** | 2026-02-24-k4x7m9p3-issue (join table name — already resolved; DUP-006 excluded from this spec) |

---

## Overview

The datafn codebase has accumulated independently-written implementations of the same logic across `@datafn/client` and `@datafn/server`. As features grew (offline queries, sync, plugin hooks), both packages evolved identical utilities — filter evaluation, sort parsing, date codecs, schema lookups, system field constants, and plugin hook runners — without sharing through `@datafn/core`.

This spec consolidates **13 duplication findings** (DUP-001 through DUP-005, DUP-007 through DUP-013, DUP-014, DUP-015) from the 2026-02-24 code duplication audit into `@datafn/core` or into intra-package shared modules. DUP-006 (join table name resolution) is **excluded** — it was resolved by issue `2026-02-24-k4x7m9p3-issue` which introduced `getJoinStoreKey()`, `getJoinTableName()`, and `enumerateJoinStoreKeys()` in `@datafn/core/joins.ts`.

### Before (current state)

```
@datafn/client/src/offline/query.ts     → evaluateFilter() with $eq, $ne, $gt, $in ...
@datafn/server/src/execution/query/filters.ts → evaluateFilter() with eq, ne, gt, in ...
                                                 (different operator names, different error handling)

@datafn/client/src/offline/query.ts     → inline sort term parsing
@datafn/server/src/execution/query/sort.ts → parseSortTerms()

@datafn/client/src/codecs/date.ts       → serializeDateFields(), parseDateFields()
@datafn/server/src/execution/sync/push.ts → coerceDateFields()

@datafn/server/src/validation/schema.ts → SYSTEM_FIELDS, READONLY_SYSTEM_FIELDS (local to server)
@datafn/server/src/execution/mutation/dfql.ts → hardcoded system field preservation
@datafn/server/src/execution/query/select.ts → hardcoded system field checks

@datafn/server/src/validation/schema.ts → buildSchemaIndex() (server-only, 11+ ad-hoc .find() elsewhere)

@datafn/client/src/plugins/run-hooks.ts → 6 hook functions, filter by "client"
@datafn/server/src/plugins/run-hooks.ts → 6 hook functions, filter by "server"
```

### After (target state)

```
@datafn/core/src/
├── filters.ts         → evaluateFilter(record, filters, opts?) — shared core operators
├── sort.ts            → parseSortTerms(sort) — shared sort term parsing
├── date.ts            → toEpochMs(), fromEpochMs(), coerceDateFields() — shared date utilities
├── system-fields.ts   → SYSTEM_FIELDS, READONLY_SYSTEM_FIELDS — shared constants
├── schema-index.ts    → buildSchemaIndex(), getResource(), getField(), getRelation() — shared lookups
├── hooks.ts           → runBeforeHook(), runAfterHook() — generic plugin hook runner
├── select.ts          → parseSelectToken() — shared select token parsing
└── (existing files unchanged)

@datafn/client → imports shared utilities from @datafn/core, deletes local copies
@datafn/server → imports shared utilities from @datafn/core, deletes local copies
```

---

## Glossary

| Term | Definition |
|---|---|
| **Filter evaluation** | The process of testing a record against a set of DFQL filter conditions (operators like `$eq`, `$gt`, `$in`, etc.) and returning a boolean match result. |
| **Schema index** | A pre-computed `Map`-based lookup structure built from a `DatafnSchema`, enabling O(1) resource/field/relation lookups by name instead of O(n) `Array.find()` calls. |
| **System fields** | Fields automatically managed by the datafn runtime: `id`, `createdAt`, `updatedAt`, `createdBy`, `updatedBy`, `isArchived`. These MUST NOT be user-writable through mutations. |
| **Sort term** | A string like `"field"`, `"field:asc"`, `"field:desc"`, or `"-field"` that specifies a sort direction for query results. |
| **Select token** | A string like `"*"`, `"title"`, `"tags.*"`, `"tags.#"`, or `"children.**"` that specifies which fields and relations to include in query results. |
| **Date codec** | Serialization/deserialization logic that converts between JavaScript `Date` objects, ISO 8601 strings, and epoch milliseconds for wire transport and storage. |
| **Plugin hook runner** | The execution engine that iterates registered plugins and invokes their lifecycle hooks (`beforeQuery`, `afterMutation`, etc.) with fail-closed or fail-open semantics. |
| **Fail-closed** | Hook execution mode where an error from any plugin stops the chain and rejects the operation. Used for `before*` hooks. |
| **Fail-open** | Hook execution mode where an error from a plugin is logged but does not stop the chain. Used for `after*` hooks. |
| **ValidationResult** | Server's local result type `{ ok: true; value: T } | { ok: false; error: ValidationError }`. Similar to `DatafnEnvelope` but uses `value` instead of `result`. |
| **DatafnEnvelope** | Core's result type `{ ok: true; result: T } | { ok: false; error: DatafnError }`. The canonical error-handling envelope. |
| **Relation resolver** | A callback `(resource: string, id: string, relation: string) => Record<string, unknown>[]` injected into filter evaluation to enable relation-aware filtering without coupling to a specific data store. |

---

## Goals

1. **Eliminate semantic drift**: Filter evaluation, date coercion, sort parsing, and select token parsing MUST have a single source of truth in `@datafn/core` so client and server cannot diverge.
2. **Reduce code volume**: Remove duplicated implementations from `@datafn/client` and `@datafn/server`, replacing with imports from `@datafn/core`.
3. **Enable consistent operator support**: The shared filter evaluator MUST support the union of operators used by both client (offline) and server, so offline queries can evaluate the same filters the server supports.
4. **Centralize system field definitions**: `SYSTEM_FIELDS` and `READONLY_SYSTEM_FIELDS` MUST be exported from `@datafn/core` and imported everywhere they are referenced.
5. **Provide reusable schema index**: `buildSchemaIndex()` MUST be available from `@datafn/core` so both client and server can use O(1) lookups.
6. **Unify plugin hook execution**: A single generic hook runner in `@datafn/core` MUST replace the parallel client/server implementations.
7. **Consolidate date utilities**: Shared date conversion functions MUST be available from `@datafn/core` for both client codec and server push coercion.
8. **No breaking changes**: All consolidation MUST be internal refactoring. No public API signatures, wire formats, or observable behavior changes.
9. **Maintain test coverage**: All existing tests MUST continue to pass after consolidation.

## Non-Goals

- **New filter operators**: This spec consolidates existing operators; adding new operators is out of scope.
- **Client-side relation filtering**: The client's offline filter evaluator currently does not support relation traversal. Adding relation support to the client is out of scope — the shared function accepts an optional relation resolver that the client can leave `undefined`.
- **Replacing `ValidationResult` with `DatafnEnvelope`**: While DUP-008 identifies the type mismatch, fully replacing the server's `ValidationResult` would be a large refactor touching every validation function. This spec aligns the property name (`value` -> `result`) in a backward-compatible wrapper but does not mandate a full replacement.
- **Restructuring client or server package layouts**: This spec adds new modules to `@datafn/core` and updates imports. It does not reorganize the client or server package directory structures.
- **DUP-006 (join table name)**: Already resolved by issue `2026-02-24-k4x7m9p3-issue.md`.

---

## Public API

### New Exports from `@datafn/core`

#### `core/src/system-fields.ts`

```typescript
/** Fields automatically managed by the datafn runtime. */
export const SYSTEM_FIELDS: ReadonlySet<string>;

/** System fields that MUST NOT be written by user mutations. */
export const READONLY_SYSTEM_FIELDS: ReadonlySet<string>;
```

#### `core/src/schema-index.ts`

```typescript
export interface SchemaIndex {
  resourcesByName: Map<string, DatafnResourceSchema>;
  fieldsByResource: Map<string, Map<string, DatafnFieldSchema>>;
  relationsByResource: Map<string, DatafnRelationSchema[]>;
  relationsFromResource: Map<string, DatafnRelationSchema[]>;
}

/** Build a pre-computed lookup index from a validated schema. */
export function buildSchemaIndex(schema: DatafnSchema): SchemaIndex;

/** Get a resource by name, or undefined. */
export function getResource(index: SchemaIndex, name: string): DatafnResourceSchema | undefined;

/** Get a field by resource name and field name, or undefined. */
export function getField(index: SchemaIndex, resource: string, field: string): DatafnFieldSchema | undefined;

/** Get all relations where the given resource is `from`. */
export function getRelationsFrom(index: SchemaIndex, resource: string): DatafnRelationSchema[];

/** Find a specific relation by from-resource and relation name. */
export function getRelation(index: SchemaIndex, fromResource: string, relationName: string): DatafnRelationSchema | undefined;

/** Get the target resource name for a relation. */
export function getRelationTarget(relation: DatafnRelationSchema): string;
```

#### `core/src/filters.ts`

```typescript
export interface FilterEvalOptions {
  /** Callback to resolve related records for relation-aware filtering. If omitted, relation filters throw DFQL_UNSUPPORTED. */
  resolveRelation?: (resource: string, recordId: string, relationName: string) => Record<string, unknown>[];
  /** The resource name (for error messages). */
  resource?: string;
}

/**
 * Evaluate a DFQL filter against a single record.
 * Supports: $eq, $ne, $gt, $gte, $lt, $lte, $in, $nin, $contains, $startsWith, $endsWith,
 *           $like, $ilike, $not_like, $not_ilike, $is_null, $is_not_null, $is_empty, $is_not_empty,
 *           $before, $after, $between, $not_between, $and, $or.
 * Returns true if the record matches all filter conditions.
 */
export function evaluateFilter(
  record: Record<string, unknown>,
  filters: Record<string, unknown>,
  opts?: FilterEvalOptions,
): boolean;
```

#### `core/src/sort.ts`

```typescript
export interface SortTerm {
  field: string;
  direction: "asc" | "desc";
}

/** Parse DFQL sort strings into structured sort terms. Handles "field", "field:asc", "field:desc", "-field". */
export function parseSortTerms(sort: string[] | undefined): SortTerm[];

/** Sort records by the given terms with stable id tie-breaker. */
export function sortRecords(records: Record<string, unknown>[], terms: SortTerm[]): Record<string, unknown>[];
```

#### `core/src/date.ts`

```typescript
/**
 * Convert a Date, ISO string, or epoch number to epoch milliseconds.
 * Returns the value unchanged if already a number.
 * Throws DFQL_INVALID on unparseable values.
 */
export function toEpochMs(value: unknown): number;

/**
 * Convert an epoch millisecond number or ISO string to a Date object.
 * Returns the value unchanged if already a Date.
 */
export function fromEpochMs(value: unknown): Date;

/**
 * Schema-driven coercion: for each date field in the resource, convert the record value to epoch milliseconds.
 * Mutates the record in place and returns it.
 */
export function coerceDateFieldsToEpoch(
  record: Record<string, unknown>,
  fields: DatafnFieldSchema[],
): Record<string, unknown>;

/**
 * Schema-driven parsing: for each date field in the resource, convert the record value to a Date object.
 * Mutates the record in place and returns it.
 */
export function parseDateFieldsToDate(
  record: Record<string, unknown>,
  fields: DatafnFieldSchema[],
): Record<string, unknown>;
```

#### `core/src/hooks.ts`

```typescript
export type HookEnv = "client" | "server";

export interface HookResult<T> {
  ok: boolean;
  value?: T;
  error?: DatafnError;
}

/**
 * Run a fail-closed before-hook across all plugins matching the given environment.
 * Stops and returns error on first failure.
 */
export function runBeforeHook<T>(
  plugins: DatafnPlugin[],
  env: HookEnv,
  hookName: "beforeQuery" | "beforeMutation" | "beforeSync",
  ctx: DatafnHookContext,
  payload: T,
  ...extra: unknown[]
): Promise<HookResult<T>>;

/**
 * Run a fail-open after-hook across all plugins matching the given environment.
 * Logs errors but continues through all plugins.
 */
export function runAfterHook<T>(
  plugins: DatafnPlugin[],
  env: HookEnv,
  hookName: "afterQuery" | "afterMutation" | "afterSync",
  ctx: DatafnHookContext,
  payload: T,
  result: unknown,
  ...extra: unknown[]
): Promise<void>;
```

#### `core/src/select.ts`

```typescript
export interface SelectToken {
  /** The full path segments (e.g., ["tags", "*"] for "tags.*"). */
  path: string[];
  /** The first segment — resource or field name. */
  baseName: string;
  /** The directive after the first segment: "*", "#", "**", "*#", or undefined. */
  directive: string | undefined;
}

/** Parse a DFQL select token string into its structured components. */
export function parseSelectToken(token: string): SelectToken;
```

### Changed Exports

None. All existing `@datafn/core` exports remain unchanged.

### Deprecated Exports

None.

---

## Architecture

### Module Dependency After Consolidation

```
@datafn/core
├── system-fields.ts  ← NEW (no dependencies)
├── schema-index.ts   ← NEW (depends on types.ts)
├── filters.ts        ← NEW (depends on errors.ts, types.ts)
├── sort.ts           ← NEW (no dependencies)
├── date.ts           ← NEW (depends on errors.ts, types.ts)
├── hooks.ts          ← NEW (depends on types.ts, errors.ts)
├── select.ts         ← NEW (no dependencies)
├── joins.ts          ← EXISTING (from issue k4x7m9p3)
├── types.ts          ← EXISTING
├── dfql.ts           ← EXISTING
├── errors.ts         ← EXISTING
├── envelope.ts       ← EXISTING
├── normalize.ts      ← EXISTING
├── schema.ts         ← EXISTING
├── kv.ts             ← EXISTING
└── index.ts          ← UPDATED (re-exports new modules)

@datafn/client
├── src/offline/query.ts        ← MODIFIED: imports evaluateFilter, parseSortTerms from core
├── src/codecs/date.ts          ← MODIFIED: delegates to core date utilities
├── src/plugins/run-hooks.ts    ← MODIFIED: delegates to core hook runner
├── src/adapters/shared.ts      ← NEW: shared storage adapter validation (DUP-012)
├── src/adapters/indexedDbStorage.ts ← MODIFIED: imports from adapters/shared.ts
├── src/adapters/memoryStorage.ts   ← MODIFIED: imports from adapters/shared.ts
└── src/client.ts               ← MODIFIED: can use buildSchemaIndex for internal lookups

@datafn/server
├── src/validation/schema.ts    ← MODIFIED: imports SYSTEM_FIELDS, buildSchemaIndex from core
├── src/execution/query/filters.ts ← MODIFIED: delegates core operators to shared evaluateFilter
├── src/execution/query/sort.ts    ← MODIFIED: re-exports parseSortTerms from core
├── src/execution/query/select.ts  ← MODIFIED: imports parseSelectToken from core
├── src/execution/sync/push.ts     ← MODIFIED: imports coerceDateFieldsToEpoch from core
├── src/plugins/run-hooks.ts       ← MODIFIED: delegates to core hook runner
└── (ad-hoc .find() calls)        ← MODIFIED: use SchemaIndex where beneficial
```

---

## Semantics

### Invariants

1. **INV-001 — Filter operator parity**: The shared `evaluateFilter()` MUST support every operator used by both client and server. If the server currently supports an operator the client does not, the shared function MUST support it and the client MAY choose to use it.

2. **INV-002 — Relation resolver injection**: The shared `evaluateFilter()` MUST NOT directly access any data store. Relation resolution MUST be injected via the `resolveRelation` callback. When the callback is omitted, relation dot-paths MUST throw `DFQL_UNSUPPORTED`.

3. **INV-003 — System field immutability**: Any module that checks whether a field is a system field or readonly system field MUST use the constants from `@datafn/core/system-fields.ts`.

4. **INV-004 — Schema index correctness**: `buildSchemaIndex()` MUST produce identical lookup results to the existing server implementation. The set of resources, fields, and relations MUST match.

5. **INV-005 — Date codec determinism**: `toEpochMs(toEpochMs(value))` MUST be idempotent — passing an already-converted epoch number MUST return the same number. `fromEpochMs(fromEpochMs(value))` MUST also be idempotent.

6. **INV-006 — Hook execution order**: Plugin hooks MUST execute in registration order (array index order). `before*` hooks MUST be fail-closed. `after*` hooks MUST be fail-open.

7. **INV-007 — Sort term determinism**: `parseSortTerms()` MUST produce identical results for the same input across client and server.

8. **INV-008 — Zero behavioral change**: Consolidation MUST NOT change any observable behavior. Query results, mutation outcomes, sync cursors, and error messages MUST remain identical.

### Error Handling

- **Filter evaluation errors**: MUST produce `DatafnError` with code `DFQL_INVALID` for malformed filters or `DFQL_UNSUPPORTED` for unsupported operators/features.
- **Date codec errors**: MUST produce `DatafnError` with code `DFQL_INVALID` for unparseable date values, including the field path in `details`.
- **Schema index errors**: `getResource()`, `getField()`, `getRelation()` return `undefined` for missing entries — they do NOT throw.
- **Hook errors**: `before*` hooks wrap plugin exceptions in `DatafnError` with code `INTERNAL`. `after*` hooks log and continue.

---

## Security Considerations

- No new security surface. All changes are internal refactoring of existing logic.
- `SYSTEM_FIELDS` and `READONLY_SYSTEM_FIELDS` being centrally defined reduces the risk of accidentally omitting a system field check in a new code path.

---

## Limits / Caps

No new limits introduced. Existing limits (filter depth, relation depth, etc.) remain unchanged and are enforced at the same points.

---

## Observability

- The shared hook runner MUST use the same logging pattern as existing implementations (console.error for fail-open `after*` hook failures).
- No new logging or metrics are introduced.

---

## Compatibility / Versioning

- All changes are internal to the datafn monorepo. No public API changes.
- `@datafn/core` gains new exports but does not change existing exports.
- `@datafn/client` and `@datafn/server` import from `@datafn/core` instead of local implementations. Their public APIs are unchanged.
- Semver: This is a **patch-level** change (internal refactor, no behavioral change).

---

## Undefined / Explicitly Deferred

| Item | Status | Rationale |
|---|---|---|
| Full `ValidationResult` → `DatafnEnvelope` migration | Deferred | Touching every server validation function is high-effort for low immediate value. DUP-008 is addressed by aligning the shared `SchemaIndex` to use `DatafnEnvelope` for its own API, but existing server validation functions keep `ValidationResult`. |
| Client-side relation filtering in offline mode | Deferred | The shared `evaluateFilter()` supports relation resolvers, but wiring up a relation resolver in the client's offline query executor is a separate feature. |
| Server ad-hoc `.find()` migration | Partial | This spec migrates the most frequently hit `.find()` calls to use `SchemaIndex`. Remaining low-frequency calls MAY be migrated later. |

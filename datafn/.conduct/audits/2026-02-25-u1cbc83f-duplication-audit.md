# Full Audit Report: DataFn Code Duplication & Reuse Improvements

## Metadata

- **Timestamp**: 2026-02-25T18:00:00Z
- **Agent Name**: amp
- **Model**: Claude Sonnet 4
- **Launcher**: Amp CLI
- **Workspace Path**: /Users/serro/Documents/dev/n/superfunctions
- **Project Root**: /Users/serro/Documents/dev/n/superfunctions/datafn
- **OS**: darwin 25.3.0
- **Shell**: zsh
- **Repo**:
  - **Git repo**: Yes (parent superfunctions repo)
  - **Branch**: next
  - **Commit**: 2d1a0bf
  - **Dirty**: Yes
- **Audit ID**: u1cbc83f
- **Audit Type**: Full (code duplication & reuse focus)

---

## Audit Scope

### Inputs Audited

**Codebase scope audited:**
- Root: `/Users/serro/Documents/dev/n/superfunctions/datafn`
- `core/src/` — Shared types, schema index, filters, sort, date, hooks
- `server/src/` — HTTP routes, execution layer, validation, plugins, sync
- `client/src/` — Client factory, offline engine, storage adapters, plugins, sync
- `svelte/src/` — Svelte store adapter
- `cli/src/` — Schema codegen and Drizzle generation
- `python/datafn/` — Python server SDK
- Excluded: `node_modules/`, `dist/`, `venv/`, `bruno-datafn-server-test/`, `.conduct/`, test files

### Commands Executed During Audit

None (read-only static audit).

---

## Executive Summary

DataFn has a well-structured `core/` package that centralizes many shared concerns (types, filters, sort, dates, hooks). However, significant duplication remains between `server/` and `client/` — particularly in relation resolution, operator normalization, select materialization, and relation mutation payload handling. The Python SDK re-implements several concepts from scratch rather than sharing a spec-driven contract. Within `server/` itself, the same relation-lookup pattern is copy-pasted across 6+ files.

**Overall Duplication Level: 🟡 Moderate — Good foundations, but several consolidation opportunities**

| Area | Severity | Summary |
|---|---|---|
| Relation lookup (`findRelation`) | 🔴 High | 5 independent implementations across server + client |
| Operator normalization (`OP_REMAP`) | 🔴 High | Identical map duplicated in server/filters.ts and client/offline/query.ts |
| Relation payload normalization | 🔴 High | Nearly identical `normalizeRelationPayload` in server and client |
| Error type definitions | 🟡 Medium | 3 separate `DatafnError` interfaces (core, server/execution, client) |
| Schema index / resource lookup | 🟡 Medium | Core `SchemaIndex` vs server's extended `SchemaIndex` vs Python's `SchemaIndex` |
| Select materialization | 🟡 Medium | Server and client each have independent `materializeSelect` |
| Plugin hook runners | 🟢 Low | Server/client properly delegate to core; thin env-specific wrappers |
| Sort logic | 🟢 Low | Server and client properly import from core |
| Date conversion | 🟢 Low | Client imports core `toEpochMs`/`fromEpochMs`; well centralized |

---

## 1. Relation Lookup — `findRelation` (🔴 High Duplication)

### D-1: Five independent `findRelation` implementations

The pattern `schema.relations?.find(r => (r.from === resource && r.relation === name) || (r.to === resource && r.inverse === name))` is independently implemented in **5 locations** with subtle variations:

| Location | Variant |
|---|---|
| `client/src/offline/relations.ts:59-70` | Returns `DatafnRelationSchema \| null`. Matches forward + inverse. Exported, used by client offline engine. |
| `server/src/execution/mutation/relations.ts:52-60` | Returns `DatafnRelation \| undefined`. **Only matches forward** (`r.from === resource`). Private to mutations. |
| `server/src/execution/query/select.ts:342-380` | Returns `DatafnRelationSchema \| null`. Creates **inverted copy** (swaps from/to, flips type) for inverse matches. Most complex variant. |
| `server/src/execution/query/filters.ts:91-98` | Returns `any`. Matches forward + inverse + **also checks** `r.from === resourceName && r.inverse === relationName`. Uses `any` types throughout. |
| `server/src/execution/query/aggregate.ts:194-203` | Inline `schema.relations?.find(...)` with forward + inverse match. Not extracted to a function. |

Additionally, `server/src/execution/db-store.ts` contains **6 inline occurrences** of the same `schema.relations?.find(...)` pattern (lines 528, 565, 614, 675, 695, 735) — spread across filter traversal, groupBy traversal, and having traversal blocks.

**Total occurrences**: 13+ places performing relation lookup by name.

**Impact**: Bug risk from inconsistent matching logic (e.g., mutation `findRelation` only matches forward relations), maintenance burden when relation schema changes.

**Fix**: Move to `core/src/schema-index.ts` — the `SchemaIndex` already has `relationsFromResource` but lacks a name-based lookup across both forward and inverse. Add:
```ts
export function findRelation(schema: DatafnSchema, resource: string, name: string): DatafnRelationSchema | null
```

---

## 2. Operator Normalization — `OP_REMAP` (🔴 High Duplication)

### D-2: Identical operator remap map in server and client

Both files define the exact same `OP_REMAP` constant that maps non-`$`-prefixed operators to core's `$`-prefixed equivalents:

- **`server/src/execution/query/filters.ts:10-17`**
- **`client/src/offline/query.ts:146-152`**

```ts
const OP_REMAP: Record<string, string> = {
  eq: "$eq", ne: "$ne", gt: "$gt", gte: "$gte", lt: "$lt", lte: "$lte",
  like: "$like", ilike: "$ilike", not_like: "$not_like", not_ilike: "$not_ilike",
  in: "$in", not_in: "$nin",
  is_null: "$is_null", is_not_null: "$is_not_null", is_empty: "$is_empty", is_not_empty: "$is_not_empty",
  before: "$before", after: "$after", between: "$between", not_between: "$not_between",
};
```

Both also have a `normalizeOps`/`normalizeFilterOps` function that applies the remap — with slightly different signatures but identical logic.

**Fix**: Move `OP_REMAP` and a `normalizeFilterOperators()` function to `core/src/filters.ts`. Both server and client import from core.

---

## 3. Relation Payload Normalization (🔴 High Duplication)

### D-3: `normalizeRelationPayload` duplicated between server and client

Two near-identical implementations:

- **`server/src/execution/mutation/relations.ts:24-47`** — Returns `NormalizedRelation[]`, handles string, array, and `{ $ref, ...meta }` objects.
- **`client/src/offline/relations.ts:25-53`** — Named `normalizeRelationPayload`, same logic with minor structural differences (returns array of `{ toId, metadata }` objects).

Both normalize the same DFQL relation payload format. Both are called 5+ times each within their respective packages.

**Fix**: Move `normalizeRelationPayload` and its `NormalizedRelation` type to `core/src/joins.ts` (which already contains `getJoinStoreKey`). Both server and client import from core.

---

## 4. Error Type Fragmentation (🟡 Medium Duplication)

### D-4: Three separate `DatafnError` type definitions

| Location | Definition |
|---|---|
| `core/src/errors.ts:19-23` | `{ code: DatafnErrorCode; message: string; details?: unknown }` — canonical type |
| `server/src/execution/errors.ts:6-10` | `{ code: string; message: string; details: { path: string; [key: string]: unknown } }` — widened `code` to `string`, required `details.path` |
| `client/src/errors.ts:7-11` | `DatafnClientError = { code: DatafnErrorCode \| "TRANSPORT_ERROR"; message: string; details: { path: string } }` — extends code union |

The server's `execution/errors.ts` also defines `DatafnExecutionError` class, `classifyExecutionError`, and `createDfqlError` — **none of which reference the core type**. The `errorToEnvelope` function in `server/src/http/errors.ts` manually constructs the same `{ ok: false, error: { code, message, details } }` envelope that `core/src/errors.ts`'s `err()` helper already provides.

**Impact**: Type drift between core and server error shapes. The server's `DatafnError` is structurally compatible but not the same type, preventing type-safe interop.

**Fix**: 
- Server `execution/errors.ts` should import and extend `DatafnError` from core, not re-declare it.
- `errorToEnvelope` in `http/errors.ts` should use `core.err()` instead of manual construction.
- Client should extend core's `DatafnErrorCode` union rather than ad-hoc union with `"TRANSPORT_ERROR"`.

---

## 5. Schema Index Duplication (🟡 Medium Duplication)

### D-5: Three independent `SchemaIndex` implementations

| Location | Type |
|---|---|
| `core/src/schema-index.ts` | `SchemaIndex` with Maps for resources, fields, relations |
| `server/src/validation/schema.ts:69-78` | Extends core's `SchemaIndex` with Set-based lookups, writable fields |
| `python/datafn/validation.py:4-66` | Python `SchemaIndex` class — re-implements the entire index from scratch |

The server properly extends core (good), but the Python SDK is a full re-implementation with different data structures (`Dict[str, Set[str]]` vs `Map<string, Map<string, DatafnFieldSchema>>`). The Python version also hardcodes system fields (lines 28-36) instead of importing from a shared constant.

**Impact**: Python schema validation can diverge from TypeScript behavior as features are added.

**Fix**: Define system fields and schema index structure in a language-agnostic spec (e.g., `core/SPEC.md` or a JSON schema), and generate/validate Python against it.

---

## 6. Select Materialization (🟡 Medium Duplication)

### D-6: Two independent `materializeSelect` implementations

- **`server/src/execution/query/select.ts:62-218`** — Server-side. Uses `DataStore` interface (synchronous `getRecords`/`getJoinRows`). Handles wildcard, dot-path, nested relations, FK auto-omit, omit parameter.
- **`client/src/offline/relations.ts:231-311`** — Client-side. Uses `DatafnStorageAdapter` (async). Handles wildcard, dot-path, relation expansion with metadata.

Both parse the same DFQL select token format, both import `parseSelectToken` from core, both handle `*`, `#`, dot-paths, and relation expansion. However, they use completely different interfaces for data access (sync vs async) and have diverged in feature support (server has omit, client has metadata markers).

**Impact**: Feature additions to select must be implemented twice. Behavioral divergence possible.

**Fix**: Extract the select token parsing/grouping logic (which is identical) into core. The actual data fetching/expansion can remain env-specific, but the token classification (`isRelation`, `isNestedPath`, `isWildcard`) should be shared.

---

## 7. `traverseFilter`/`traverseHaving` Copy-Paste in `db-store.ts` (🟡 Medium — Internal Duplication)

### D-7: Filter/having/groupBy relation discovery logic duplicated within single file

`server/src/execution/db-store.ts` contains three nearly identical blocks of relation path traversal logic:

1. **Filter traversal** (lines 264-361) — `traverseFilter()` function
2. **GroupBy traversal** (lines 364-397) — inline loop
3. **Having traversal** (lines 416-477) — `traverseHaving()` function that is explicitly acknowledged as a copy of `traverseFilter()`

The code comments themselves document this:
```ts
// I will COPY the logic for `having`. It's cleaner than refactoring the whole function.
```

All three do the same thing: walk dot-paths and relation names to discover which resources and join tables need pre-loading.

**Fix**: Extract a `discoverRelatedResources(schema, resource, expression)` helper that walks any filter/groupBy/having expression and returns `{ resources: Set<string>, joinTables: Set<string> }`.

---

## 8. Change Tracking — TS vs Python Divergence (🟡 Medium)

### D-8: Python change tracking re-implements TS logic with different table schema

| Aspect | TypeScript (`server/src/execution/sync/change-tracking.ts`) | Python (`python/datafn/change_tracking.py`) |
|---|---|---|
| Sequence table | `__datafn_meta` (field: `next_server_seq`) | `__datafn_server_seq` (field: `seq`) |
| Changes table | `__datafn_changes` | `__datafn_changes` (same name) |
| Change record fields | `namespace, server_seq, resource, record_id, op, record, created_at` | `namespace, table, operation, recordId, serverSeq, timestamp` |
| Sequence strategy | CAS retry loop (10 retries) | Transaction-based increment |
| ID format | `change:{ns}:{seq}:{resource}:{id}` | `uuid.uuid4()` |

The column names are completely different (`server_seq` vs `serverSeq`, `resource` vs `table`, `record_id` vs `recordId`). This means the Python SDK and TypeScript SDK cannot share the same database tables.

**Impact**: A deployment mixing Python and TypeScript servers cannot share the same database without schema translation.

**Fix**: Standardize table schemas in a shared spec. Python should match TypeScript's column naming convention.

---

## 9. Idempotency Store — TS vs Python Divergence (🟡 Medium)

### D-9: Different column names and lookup patterns

| Aspect | TypeScript (`server/src/execution/idempotency-db.ts`) | Python (`python/datafn/idempotency.py`) |
|---|---|---|
| Lookup fields | `namespace, client_id, mutation_id` | `clientId, mutationId` (no namespace) |
| ID format | `{namespace}:{clientId}:{mutationId}` | No explicit ID |
| Result storage | `JSON.stringify(result)` in `result` column | Direct object in `result` field |
| Table init | `ensureInternalTable()` | Assumes table exists |

**Impact**: Same database incompatibility as D-8. Python idempotency checks may miss TypeScript-stored entries and vice versa.

**Fix**: Align column names, add namespace support to Python, share table schema spec.

---

## 10. Plugin Hook Runners — Thin Wrappers (🟢 Low — Acceptable)

### D-10: Server and client hook runners are thin env-specific wrappers

- `server/src/plugins/run-hooks.ts` — 6 functions, each 3-5 lines, delegates to core with `env: "server"`
- `client/src/plugins/run-hooks.ts` — 6 functions, each 3-5 lines, delegates to core with `env: "client"`

These are structurally similar but serve different API contracts (server returns `{ ok, error }` objects; client throws on error). The duplication is minimal and justified by the different error handling semantics.

**Status**: Acceptable. No action needed.

---

## 11. `getRelatedRecords` Logic (🟡 Medium Duplication)

### D-11: Related record resolution duplicated between server filters and client offline

- **`server/src/execution/query/filters.ts:100-151`** — `getRelatedRecords()` resolves FK, inverse FK, and many-many join rows for filter evaluation.
- **`client/src/offline/relations.ts:76-229`** — `expandRelation()` resolves the same relation types for select expansion with very similar FK/join logic.

Both determine direction (`isForward`), resolve FK field names (`rel.fkField || rel.foreignKey`), and handle many-many join table lookups. The server version is synchronous (uses `DataStore`), the client version is async (uses `DatafnStorageAdapter`).

**Fix**: Extract the relation resolution _algorithm_ (FK field derivation, direction detection, target resource identification) into a shared helper in core. Leave the data access (sync vs async) to each environment.

---

## Summary of Recommendations

### Priority 1 — High-Impact Consolidation

| ID | Issue | Effort | LOC Saved (est.) |
|---|---|---|---|
| D-1 | Centralize `findRelation` in core/schema-index.ts | Low | ~80 |
| D-2 | Move `OP_REMAP` + `normalizeFilterOperators` to core/filters.ts | Low | ~30 |
| D-3 | Move `normalizeRelationPayload` to core/joins.ts | Low | ~40 |

### Priority 2 — Type & Schema Alignment

| ID | Issue | Effort | LOC Saved (est.) |
|---|---|---|---|
| D-4 | Unify error types — server/execution/errors.ts imports from core | Low | ~20 |
| D-7 | Extract `discoverRelatedResources` helper in db-store.ts | Medium | ~120 |
| D-8 | Standardize Python change tracking table schema | Medium | N/A (compatibility) |
| D-9 | Standardize Python idempotency table schema | Low | N/A (compatibility) |

### Priority 3 — Structural Improvements

| ID | Issue | Effort | LOC Saved (est.) |
|---|---|---|---|
| D-5 | Shared schema index spec for Python parity | Medium | N/A (correctness) |
| D-6 | Extract select token classification to core | Medium | ~50 |
| D-11 | Extract relation resolution algorithm to core | Medium | ~60 |

### Estimated Total LOC Reduction: ~400 lines

---

## Architecture Strengths Worth Preserving

1. **Core package as single source of truth** — `core/src/filters.ts`, `core/src/sort.ts`, `core/src/date.ts` are correctly centralized and imported by both server and client.
2. **Server validation extends core** — `server/src/validation/schema.ts` properly extends `CoreSchemaIndex` rather than reimplementing.
3. **Plugin hooks delegation** — Both server and client correctly delegate to `core/src/hooks.ts` with env-specific thin wrappers.
4. **Shared type exports** — `@datafn/core` exports canonical types consumed by all packages.

---

*Audited by: AI Agent | Scope: Full codebase scan of datafn/* (duplication & reuse focus)

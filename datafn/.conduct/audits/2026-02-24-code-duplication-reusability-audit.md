# Code Duplication & Reusability Audit: datafn Packages

## Metadata

| Field | Value |
|---|---|
| **Timestamp** | 2026-02-24 |
| **Agent Name** | factory-droid |
| **Model** | Claude Opus 4.6 |
| **Launcher** | CLI |
| **Workspace** | /Users/serro/Documents/dev/n/superfunctions |
| **Git Branch** | heads/next |
| **Audit Type** | Cross-package code duplication and reusability analysis |

---

## Audit Scope

This audit examines all five datafn packages for duplicated code, repeated patterns, and opportunities to consolidate shared logic into `@datafn/core`:

| Package | Source Location | Approx. LOC |
|---|---|---|
| **core** | `datafn/core/src/` | ~400 |
| **client** | `datafn/client/src/` | ~3500 |
| **server** | `datafn/server/src/` | ~4500 |
| **cli** | `datafn/cli/src/` | ~730 |
| **svelte** | `datafn/svelte/src/` | ~170 |

---

## Executive Summary

**15 duplication findings** identified across 3 severity tiers. The most impactful consolidation opportunities are:

1. **Filter evaluation logic** — duplicated between client offline and server query execution (~200 lines combined)
2. **Schema index / lookup utilities** — server builds a `SchemaIndex`; client and CLI do ad-hoc `schema.resources.find()` calls
3. **Date codec / coercion** — client serializes dates outbound and parses inbound; server coerces dates in push; no shared implementation
4. **System fields constant** — hardcoded in 4+ locations across server, never exported
5. **Join table name resolution** — duplicated across CLI codegen and client/server relation handling
6. **Plugin hook runner** — nearly identical implementations in client and server

Estimated effort to consolidate: **medium** (2-3 focused sessions). No breaking API changes required — all consolidation targets are internal utilities.

---

## Findings

### CRITICAL — High duplication, high reuse value

#### DUP-001: Filter Evaluation Logic

| | |
|---|---|
| **Severity** | Critical |
| **Locations** | `client/src/offline/query.ts` (evaluateFilter ~100 lines), `server/src/execution/query/filters.ts` (evaluateFilter ~150 lines) |
| **Description** | Both client (offline mode) and server implement DFQL filter evaluation with operators `$eq`, `$ne`, `$gt`, `$gte`, `$lt`, `$lte`, `$in`, `$nin`, `$contains`, `$startsWith`, `$endsWith`, `$and`, `$or`. The implementations are structurally identical with minor differences in relation traversal (server has full relation support, client has simplified local-only version). |
| **Risk** | Semantic drift between client-side and server-side filtering — a bug fix in one may not be applied to the other. New operators must be added in two places. |
| **Recommendation** | Extract a shared `evaluateFilter(record, filters, opts?)` into `@datafn/core`. The relation traversal can be injected via an options callback `resolveRelation?: (resource, id, relation) => Record[]` so both client and server can plug in their own store access. |

#### DUP-002: Schema Index / Lookup Utilities

| | |
|---|---|
| **Severity** | Critical |
| **Locations** | `server/src/validation/schema.ts` (`buildSchemaIndex()`, `getResource()`, `validateFieldName()`, etc.), `client/src/client.ts` (ad-hoc `schema.resources.find()`), `client/src/offline/query.ts` (inline field lookups), `cli/src/codegen.ts` (inline resource iteration) |
| **Description** | The server pre-computes a `SchemaIndex` with `Map<string, Resource>`, `Map<string, Map<string, Field>>`, and relation lookups for O(1) access. The client and CLI perform repeated `schema.resources.find(r => r.name === name)` calls scattered across many files — O(n) per lookup, no caching. |
| **Risk** | Inconsistent field/resource resolution. Performance cost in client for large schemas. |
| **Recommendation** | Move `buildSchemaIndex()` and its core lookup functions (`getResource`, `getField`, `getRelation`, `getRelationTarget`) to `@datafn/core`. Server-specific validation (authz, depth) stays in server. |

#### DUP-003: Date Codec / Coercion

| | |
|---|---|
| **Severity** | Critical |
| **Locations** | `client/src/codecs/date.ts` (`serializeDateFields()`, `parseDateFields()`), `server/src/execution/sync/push.ts` (`coerceDateFields()` — ISO string to epoch ms), `client/src/offline/query.ts` (inline date comparison handling) |
| **Description** | The client has a full date codec that converts `Date` objects to epoch milliseconds on outbound mutations and parses epoch/ISO back to `Date` on inbound query results. The server has a separate `coerceDateFields()` in push.ts that converts ISO strings to epoch for storage consistency. Both are schema-driven (check `field.type === "date"`) but implemented independently. |
| **Risk** | Date handling inconsistency between client and server. If a new date format is supported, both must be updated. |
| **Recommendation** | Extract shared date utilities to `@datafn/core`: `toEpochMs(value)`, `fromEpochMs(value)`, and schema-driven `coerceDateFields(record, fields)`. Client and server import and use for their respective directions. |

---

### HIGH — Significant duplication, clear extraction path

#### DUP-004: System Fields Constant

| | |
|---|---|
| **Severity** | High |
| **Locations** | `server/src/validation/schema.ts` (`SYSTEM_FIELDS`, `READONLY_SYSTEM_FIELDS`), `server/src/execution/query/select.ts` (hardcoded system field checks), `server/src/execution/mutation/dfql.ts` (hardcoded system field preservation), `client/src/offline/query.ts` (implicit system field awareness) |
| **Description** | System fields (`id`, `createdAt`, `updatedAt`, `createdBy`, `updatedBy`, `isArchived`) and their readonly subset are defined as a constant in server validation but hardcoded inline in at least 3 other server files and implicitly expected in client offline logic. |
| **Risk** | Adding a new system field requires updating multiple files. |
| **Recommendation** | Export `SYSTEM_FIELDS` and `READONLY_SYSTEM_FIELDS` from `@datafn/core`. All packages import from there. |

#### DUP-005: Plugin Hook Runner

| | |
|---|---|
| **Severity** | High |
| **Locations** | `client/src/plugins/run-hooks.ts`, `server/src/plugins/run-hooks.ts` |
| **Description** | Both packages implement the same plugin hook runner pattern: iterate plugins filtered by `runsOn`, call hook method, use fail-closed semantics for `beforeX` hooks and fail-open for `afterX` hooks. The server filters by `runsOn === "server"`, the client by `runsOn === "client"`. The structure is identical — 6 functions per file (beforeQuery, afterQuery, beforeMutation, afterMutation, beforeSync, afterSync). |
| **Risk** | Hook execution semantics may diverge. A fix to hook error handling must be applied to both. |
| **Recommendation** | Extract a generic `runHook(plugins, env, hookName, args)` to `@datafn/core` parameterized by environment. Each package calls `runHook(plugins, "client", ...)` or `runHook(plugins, "server", ...)`. |

#### DUP-006: Join Table Name Resolution

| | |
|---|---|
| **Severity** | High |
| **Locations** | `cli/src/codegen.ts:65` (inline), `cli/src/drizzle-codegen.ts:298-304` (`getJoinTableName()`), `server/src/execution/mutation/relations.ts` (inline join table naming) |
| **Description** | The pattern `__datafn_join_${from}_${relation}` is computed in at least 3 places with slightly different implementations (some handle `rel.joinTable` override, some don't). |
| **Risk** | Join table naming mismatch between codegen output and runtime execution would cause silent data loss. |
| **Recommendation** | Add `resolveJoinTableName(relation: DatafnRelationSchema): string` to `@datafn/core`. All packages import this single source of truth. |

#### DUP-007: Select Token Parsing

| | |
|---|---|
| **Severity** | High |
| **Locations** | `server/src/validation/query.ts` (`validateSelectTokens` — parses tokens for validation), `server/src/execution/query/select.ts` (`parseSelectToken` — parses tokens for materialization) |
| **Description** | Select tokens (e.g., `goal.*`, `tags.#`, `children.**`) are parsed in two separate server modules with overlapping logic. The validation parser checks validity; the execution parser extracts structure. Both split on `.` and interpret `*`, `#`, `**` directives. |
| **Risk** | Validation may accept tokens that execution can't handle, or vice versa. |
| **Recommendation** | Consolidate into a single `parseSelectToken()` in a shared server utility or `@datafn/core` if client also needs it for offline select materialization. |

---

### MODERATE — Repeated patterns, lower urgency

#### DUP-008: Validation Result Pattern

| | |
|---|---|
| **Severity** | Moderate |
| **Locations** | `core/src/errors.ts` (`DatafnEnvelope<T>` with `ok`/`err`), `server/src/validation/schema.ts` (`ValidationResult<T>` with `vOk`/`vErr`) |
| **Description** | The server defines its own `ValidationResult<T>` type that is structurally similar to `DatafnEnvelope<T>` but uses `{ ok: true; value: T }` vs `{ ok: true; result: T }` (different property name: `value` vs `result`). |
| **Risk** | Two parallel result types require translation at boundaries. |
| **Recommendation** | Align server's `ValidationResult` to use `DatafnEnvelope` from core, or rename the property to match. Low effort, high clarity. |

#### DUP-009: Sort Term Parsing

| | |
|---|---|
| **Severity** | Moderate |
| **Locations** | `server/src/execution/query/sort.ts` (`parseSortTerms()`), `client/src/offline/query.ts` (inline sort parsing for offline queries) |
| **Description** | Sort terms (`"field"`, `"field:asc"`, `"field:desc"`, `"-field"`) are parsed in the server with a dedicated function and in the client inline within the offline query executor. |
| **Recommendation** | Extract `parseSortTerms()` to `@datafn/core` since both client and server need it. |

#### DUP-010: String Case Conversion Utilities

| | |
|---|---|
| **Severity** | Moderate |
| **Locations** | `cli/src/codegen.ts:113-116` (`toPascalCase()`), `cli/src/drizzle-codegen.ts:174-176` (`camelToSnake()`), `cli/src/drizzle-codegen.ts:178-180` (`sanitizeVarName()`) |
| **Description** | String conversion utilities are defined locally in the CLI package. Currently only used by CLI, but `camelToSnake` is already exported from the CLI index. |
| **Recommendation** | If other packages need these (e.g., server for SQL column naming), move to `@datafn/core/strings`. Otherwise, leave in CLI — not a pressing concern. |

#### DUP-011: Deterministic Resource/Field Sorting

| | |
|---|---|
| **Severity** | Moderate |
| **Locations** | `cli/src/codegen.ts:32-44`, `cli/src/drizzle-codegen.ts:31-43` |
| **Description** | Both codegen files sort resources and fields by `name.localeCompare()` for deterministic output. Identical 4-line pattern duplicated. |
| **Recommendation** | Extract `sortedResources(schema)` and `sortedFields(resource)` helpers within CLI. Not worth moving to core unless other packages need it. |

#### DUP-012: Storage Adapter Validation

| | |
|---|---|
| **Severity** | Moderate |
| **Locations** | `client/src/adapters/indexedDbStorage.ts`, `client/src/adapters/memoryStorage.ts` |
| **Description** | Both storage adapters implement nearly identical `validateHydrationState()`, `validateTransition()`, and `validateCursor()` functions. |
| **Recommendation** | Extract shared validation into `client/src/adapters/shared.ts` or a base class. This is internal to the client package — no need to move to core. |

#### DUP-013: Event Emission Helpers

| | |
|---|---|
| **Severity** | Moderate |
| **Locations** | `client/src/client.ts` (`emitMutationEvents`, `emitRejectionForError`), `client/src/sync/engine.ts` (`createSyncEventContext`) |
| **Description** | Event construction follows a repeated pattern: create base event object with timestamp, conditionally add resource/ids/action/fields/context. Similar factory code in 3+ locations within client. |
| **Recommendation** | Create a `buildEvent(type, overrides)` factory within the client package. Internal refactor only. |

---

### LOW — Minor or speculative

#### DUP-014: Error Classification

| | |
|---|---|
| **Severity** | Low |
| **Locations** | `client/src/errors.ts` (`isTransportError()`), `server/src/execution/errors.ts` (`classifyExecutionError()`, `isValidationError()`) |
| **Description** | Both packages have error classification utilities, but they serve different purposes (client: retriable vs non-retriable; server: validation vs execution). Minimal actual overlap. |
| **Recommendation** | No immediate action. Monitor for convergence if error handling evolves. |

#### DUP-015: Relation Handling Logic

| | |
|---|---|
| **Severity** | Low |
| **Locations** | `client/src/offline/mutate.ts` (~400 lines of relation operations), `server/src/execution/mutation/relations.ts` (~300 lines) |
| **Description** | Both implement `relate`, `modifyRelation`, `unrelate` operations for many-one, one-many, and many-many relations. However, client operates on in-memory storage adapters while server operates on database adapters — the data access patterns are fundamentally different. |
| **Recommendation** | The relation *logic* (normalization, delta computation) could partially be shared, but the tight coupling to storage APIs makes full extraction difficult. Consider extracting `normalizeRelationPayload()` to core as a first step. |

---

## Consolidation Priority Matrix

| Finding | Impact | Effort | Priority |
|---|---|---|---|
| DUP-001: Filter evaluation | High | Medium | **P1** |
| DUP-002: Schema index/lookup | High | Medium | **P1** |
| DUP-003: Date codec | High | Low | **P1** |
| DUP-004: System fields | High | Low | **P1** |
| DUP-005: Plugin hook runner | Medium | Low | **P2** |
| DUP-006: Join table name | High | Low | **P2** |
| DUP-007: Select token parsing | Medium | Low | **P2** |
| DUP-008: Validation result | Low | Low | **P3** |
| DUP-009: Sort term parsing | Medium | Low | **P3** |
| DUP-010: String utilities | Low | Low | **P3** |
| DUP-011: Deterministic sorting | Low | Low | **P3** |
| DUP-012: Storage validation | Medium | Low | **P3** (client-internal) |
| DUP-013: Event emission | Low | Low | **P3** (client-internal) |
| DUP-014: Error classification | Low | N/A | **Monitor** |
| DUP-015: Relation handling | Low | High | **Monitor** |

---

## Recommended @datafn/core Additions

Based on this audit, the following modules should be added to `@datafn/core`:

### Phase 1 — High-value, low-risk

```
core/src/
├── schema-index.ts      # buildSchemaIndex(), getResource(), getField(), getRelation()
├── system-fields.ts     # SYSTEM_FIELDS, READONLY_SYSTEM_FIELDS constants
├── date.ts              # toEpochMs(), fromEpochMs(), coerceDateFields()
├── join.ts              # resolveJoinTableName()
└── (existing files unchanged)
```

### Phase 2 — Moderate effort

```
core/src/
├── filters.ts           # evaluateFilter() with pluggable relation resolver
├── hooks.ts             # runHook() generic plugin hook runner
├── select.ts            # parseSelectToken()
├── sort.ts              # parseSortTerms()
└── (existing files unchanged)
```

### Not moved to core (package-internal refactors)

| Refactor | Package |
|---|---|
| Storage adapter validation dedup | client |
| Event emission factory | client |
| Deterministic sorting helpers | cli |

---

## Current @datafn/core Exports (Baseline)

For reference, core currently exports:

| Module | Exports |
|---|---|
| `types.ts` | `DatafnSchema`, `DatafnResourceSchema`, `DatafnFieldSchema`, `DatafnRelationSchema`, `DatafnEvent`, `DatafnEventFilter`, `DatafnSignal`, `DatafnPlugin`, `DatafnHookContext`, `DatafnPermissionsPolicy`, `defineSchema()` |
| `dfql.ts` | `DfqlQuery`, `DfqlQueryFragment`, `DfqlMutation`, `DfqlMutationFragment`, `DfqlTransact`, `DfqlSort`, `DfqlCursor` |
| `errors.ts` | `DatafnError`, `DatafnErrorCode`, `DatafnEnvelope`, `ok()`, `err()` |
| `envelope.ts` | `unwrapEnvelope()` |
| `normalize.ts` | `normalizeDfql()`, `dfqlKey()` |
| `schema.ts` | `validateSchema()` |
| `kv.ts` | `kvId()`, `ensureBuiltinKv()` |

---

## Conclusion

The datafn codebase has a solid foundation with `@datafn/core` providing shared types and the envelope pattern. However, as the client and server packages have grown, several utility functions have been independently implemented in both packages. The most impactful consolidation targets are **filter evaluation** (DUP-001), **schema indexing** (DUP-002), **date codecs** (DUP-003), and **system fields** (DUP-004) — these four alone would eliminate the highest-risk duplication and prevent future semantic drift between client and server.

The svelte package is clean — it has no meaningful duplication and correctly imports all types from core.

The CLI package has minor internal duplication (DUP-010, DUP-011) but critically shares the join table naming logic (DUP-006) which must stay in sync with server runtime behavior.

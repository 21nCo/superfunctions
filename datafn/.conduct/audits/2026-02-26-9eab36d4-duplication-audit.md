# Code Duplication & Core Library Reuse Audit: DataFn

## Metadata

- **Timestamp**: 2026-02-26T18:00:00Z
- **Agent**: Claude Code (Claude Opus 4.6)
- **Workspace**: /Users/serro/Documents/dev/n/superfunctions/datafn
- **Branch**: next
- **Commit**: ea87d7e
- **Dirty**: Yes
- **Audit ID**: 9eab36d4
- **Audit Type**: Code duplication analysis & core library consolidation assessment
- **Prior Audits Referenced**:
  - `2026-02-26-289dbdab-full-audit.md` (Agent: Claude Code / Claude Opus 4.6)
  - `2026-02-24-code-duplication-reusability-audit.md` (prior duplication audit)
  - `2026-02-24-fix-k7m4x9p2-spec/SPEC.md` (consolidation spec — partially executed)

---

## Executive Summary

This audit cross-references the **actual implemented code** against prior duplication findings and the consolidation spec from `2026-02-24`. Significant consolidation work has already been completed — `@datafn/core` now exports `getJoinTableName()`, `SchemaIndex`/`buildSchemaIndex()`, `getRelation()`, `SYSTEM_FIELDS`, `evaluateFilter()`, `HookError`, and more. However, **not all consumers have been migrated to use these core utilities**, and several extraction targets from the spec remain unimplemented.

The primary issue is **incomplete adoption**: core utilities exist but callers still hardcode or re-implement locally.

**Duplication Status: 🟡 Moderate — Core library is well-stocked; consumer migration is incomplete**

### What Was Already Fixed (Core Extraction Complete)

| Utility | Core Location | Status |
|---|---|---|
| `getJoinTableName()` | `core/src/joins.ts:27-33` | Extracted, exported, **partially adopted** |
| `getJoinStoreKey()` | `core/src/joins.ts:14-20` | Extracted, exported, adopted |
| `enumerateJoinStoreKeys()` | `core/src/joins.ts:44-62` | Extracted, exported, adopted |
| `SchemaIndex` + `buildSchemaIndex()` | `core/src/schema-index.ts:8-62` | Extracted, exported |
| `getResource()`, `getField()`, `getRelation()`, `getRelationsFrom()` | `core/src/schema-index.ts:64-98` | Extracted, exported |
| `SYSTEM_FIELDS`, `READONLY_SYSTEM_FIELDS` | `core/src/system-fields.ts:1-15` | Extracted, exported |
| `evaluateFilter()` | `core/src/filters.ts` | Extracted, exported |
| `HookError`, `runBeforeHook()`, `runAfterHook()` | `core/src/hooks.ts` | Extracted, exported |
| `parseSortTerms()`, `sortRecords()` | `core/src/sort.ts` | Extracted, exported |
| `toEpochMs()`, `fromEpochMs()`, `coerceDateFieldsToEpoch()` | `core/src/date.ts` | Extracted, exported |

### What Remains (Genuine Duplication)

| Category | Issue Count | Estimated Duplicated Lines |
|---|---|---|
| Core utilities exist but not used by consumers | 3 issues | ~60 lines of inline reimplementation |
| Code not yet extracted to core | 7 issues | ~350 lines across packages |
| Python cross-language parity gaps | 2 issues | ~215 lines |
| Type/error inconsistencies | 3 issues | ~15 lines |

---

## Issue Catalog

### Category A: Core Utility Exists But Consumers Don't Use It

These are **adoption failures** — the fix exists in core but callers still hardcode locally.

---

#### DUP-1: `getJoinTableName()` Exists in Core But Server Mutation Layer Hardcodes It (HIGH)

| Field | Value |
|---|---|
| **Severity** | 🟠 High |
| **Core Location** | `core/src/joins.ts:27-33` — `getJoinTableName(from, relation, joinTable?)` |
| **Already Using It** | `server/src/execution/sync/clone.ts:6`, `server/src/execution/sync/reconcile.ts:9` |
| **NOT Using It** | `server/src/execution/mutation/relations.ts:146,210,450`, `server/src/execution/db-store.ts` (4+ sites) |
| **Inline Pattern** | ``relation.joinTable \|\| `__datafn_join_${resource}_${relationName}` `` |

The sync layer correctly imports `getJoinTableName` from `@datafn/core`. The mutation layer and db-store still hardcode the exact same pattern at 7+ call sites. This is an incomplete migration — the fix shipped for sync but was never applied to mutations/db-store.

**Fix**: Replace inline patterns in `relations.ts` and `db-store.ts` with `import { getJoinTableName } from "@datafn/core"`. Mechanical, low-risk.

---

#### DUP-2: `getRelation()` Exists in Core But `findRelation()` Reimplemented Locally (HIGH)

| Field | Value |
|---|---|
| **Severity** | 🟠 High |
| **Core Location** | `core/src/schema-index.ts:86-93` — `getRelation(index, fromResource, relationName)` |
| **Local Reimplementations** | 4 locations |

Local `findRelation()` implementations exist in:
1. `server/src/execution/mutation/relations.ts:52-60` — forward-only search (9 lines)
2. `server/src/execution/query/filters.ts:91-98` — forward + inverse search (8 lines)
3. `server/src/execution/query/select.ts:342-376` — most comprehensive, includes inverse transformation (35 lines)
4. `client/src/offline/relations.ts:59-71` — bidirectional with inverse (13 lines)

Core's `getRelation()` only does forward lookup via `SchemaIndex`. The local implementations add inverse/bidirectional logic that core lacks. This is a **partial extraction** — the simple case is in core, but the bidirectional case is not.

**Fix**: Extend core with `findRelationBidirectional(index, resource, relationName)` that handles inverse relations. Migrate all 4 callers. The client's implementation at `relations.ts:59-71` is the most complete and should be the reference.

---

#### DUP-3: `SchemaIndex` Exists in Core But Server Validation Builds Its Own (MEDIUM)

| Field | Value |
|---|---|
| **Severity** | 🟡 Medium |
| **Core Location** | `core/src/schema-index.ts:8-62` |
| **Server Location** | `server/src/validation/schema.ts:85-154` |

Core's `SchemaIndex` provides `resourcesByName`, `fieldsByResource`, `relationsByResource`, `relationsFromResource`. Server validation builds a parallel index adding `writableFieldsByResource`. The server index should extend core's rather than rebuild from scratch.

**Fix**: Add `writableFieldsByResource` to core's `SchemaIndex` or have server call `buildSchemaIndex()` and augment the result. Server validation's `buildSchemaIndex()` (~70 lines) can be reduced to ~15 lines.

---

### Category B: Code Not Yet Extracted to Core

These utilities are duplicated across packages and have no core equivalent yet.

---

#### DUP-4: `NormalizedRelation` Interface Duplicated (HIGH)

| Field | Value |
|---|---|
| **Severity** | 🟠 High |
| **Locations** | `server/src/execution/mutation/relations.ts:13-16`, `client/src/offline/relations.ts:13-16` |
| **Similarity** | 100% identical |

```typescript
export interface NormalizedRelation {
  toId: string;
  metadata: Record<string, unknown>;
}
```

Both packages define and export the same interface. Not in core.

**Fix**: Add to `@datafn/core` (e.g. `core/src/relations.ts`), re-export from index.ts. Both packages import.

---

#### DUP-5: `normalizeRelationPayload()` Duplicated (HIGH)

| Field | Value |
|---|---|
| **Severity** | 🟠 High |
| **Locations** | `server/src/execution/mutation/relations.ts:24-47` (24 lines), `client/src/offline/relations.ts:25-54` (30 lines) |
| **Similarity** | 95% |

Both convert `string | string[] | { $ref, ...metadata }` to `NormalizedRelation[]`. Client is slightly stricter on `$ref` validation. Neither is in core.

**Fix**: Extract to `@datafn/core/relations.ts` using client's stricter validation. ~30 lines to core, delete from both packages.

---

#### DUP-6: `OP_REMAP` Constant Duplicated (HIGH)

| Field | Value |
|---|---|
| **Severity** | 🟠 High |
| **Locations** | `server/src/execution/query/filters.ts:10-17`, `client/src/offline/query.ts:146-152` |
| **Similarity** | 100% exact duplicate |

Operator remapping table (`eq` → `$eq`, `ne` → `$ne`, etc.) identically defined in both. Not exported from core's `filters.ts`.

**Fix**: Export from `@datafn/core/filters.ts`. Both packages import.

---

#### DUP-7: `normalizeFilterOps()` Duplicated (MEDIUM)

| Field | Value |
|---|---|
| **Severity** | 🟡 Medium |
| **Locations** | `server/src/execution/query/filters.ts:19-29` (`normalizeOps`, 11 lines), `client/src/offline/query.ts:155-172` (`normalizeFilterOps`, 18 lines) |
| **Similarity** | 90% |

Both remap shorthand operators to `$`-prefixed form using `OP_REMAP`. Client adds recursive `$and/$or` traversal.

**Fix**: Export unified `normalizeFilterOps()` from core alongside `OP_REMAP`. Use client's recursive version as canonical.

---

#### DUP-8: Aggregation Calculation Duplicated (MEDIUM)

| Field | Value |
|---|---|
| **Severity** | 🟡 Medium |
| **Locations** | `server/src/execution/query/aggregate.ts:218-260` (~40 lines), `client/src/offline/aggregate.ts:102-117` (~15 lines) |
| **Similarity** | 80% |

Both implement `count`, `sum`, `avg`, `min`, `max`. Server is more robust (null filtering, returns null for empty sets). Client uses `Math.min(...values)` which returns `Infinity` on empty arrays.

**Fix**: Extract `calculateAggregation(op, field, records)` to `@datafn/core` using server's null-safe semantics. ~25 lines to core.

---

#### DUP-9: `$and/$or` Evaluation Re-implemented Over Core (MEDIUM)

| Field | Value |
|---|---|
| **Severity** | 🟡 Medium |
| **Locations** | `core/src/filters.ts:169-185` (canonical), `server/src/execution/query/filters.ts:56-69`, `client/src/offline/query.ts:113-134` |
| **Similarity** | 85% |

Core's `evaluateFilter()` already handles `$and/$or`. Both server and client re-implement it in their wrapper functions instead of delegating to core.

**Fix**: Refactor server and client filter wrappers to delegate `$and/$or` to core. Only keep package-specific logic (server: relation quantifiers `$any/$all/$none`; client: error context wrapping).

---

#### DUP-10: Group-By Key Generation Inconsistent (LOW)

| Field | Value |
|---|---|
| **Severity** | 🟢 Low |
| **Locations** | `server/src/execution/query/aggregate.ts:30-51`, `client/src/offline/aggregate.ts:64-78` |
| **Similarity** | 75% |

Server uses `JSON.stringify(keyParts)` (collision-safe). Client uses `"::"` delimiter (collision-prone). Note: server's aggregate group key collision was fixed in the 2026-02-26 completion (NEW-4 replaced `join("||")` with `JSON.stringify()`), but client was not updated.

**Fix**: Extract `groupRecordsByFields()` to core or at minimum update client to use `JSON.stringify()`.

---

### Category C: Type & Error Inconsistencies

---

#### DUP-11: `PluginError` vs `HookError` Type Duplication (MEDIUM)

| Field | Value |
|---|---|
| **Severity** | 🟡 Medium |
| **Locations** | `core/src/hooks.ts` (`HookError`), `server/src/plugins/run-hooks.ts:9-13` (`PluginError`) |
| **Similarity** | 95% |

Server defines `PluginError` which is functionally identical to core's exported `HookError`.

**Fix**: Import `HookError` from core. Remove `PluginError`. 1 file changed.

---

#### DUP-12: Hook Wrapper Functions Duplicated (MEDIUM)

| Field | Value |
|---|---|
| **Severity** | 🟡 Medium |
| **Locations** | `client/src/plugins/run-hooks.ts` (78 lines), `server/src/plugins/run-hooks.ts` (87 lines) |
| **Similarity** | 75% |

Both implement 6 parallel wrappers (`runBeforeQuery`, `runAfterQuery`, `runBeforeMutation`, `runAfterMutation`, `runBeforeSync`, `runAfterSync`). Logic is nearly identical; differences are `env: "client"` vs `env: "server"` and return type shapes.

**Fix**: Create hook wrapper factory in `@datafn/core/hooks.ts` parameterized by environment. ~80 lines saved.

---

#### DUP-13: `DatafnError` Interface Redefined in Server Execution (LOW)

| Field | Value |
|---|---|
| **Severity** | 🟢 Low |
| **Locations** | `core/src/errors.ts` (canonical), `server/src/execution/errors.ts:6-10` |
| **Similarity** | 90% |

Server execution defines its own `DatafnError` interface instead of importing from core. This causes `as any` casts in routes (`server/src/routes/transact.ts:153`, `server/src/routes/sync.ts:78,453`).

**Fix**: Import `DatafnError` from `@datafn/core` in execution/errors.ts. Remove `as any` casts.

---

### Category D: Python Cross-Language Parity

---

#### DUP-14: Python System Fields Hardcoded (MEDIUM)

| Field | Value |
|---|---|
| **Severity** | 🟡 Medium |
| **Locations** | `core/src/system-fields.ts` (source of truth), `python/datafn/validation.py:27-34` (hardcoded) |

Python hardcodes 6 `.add()` calls for system fields instead of using a shared constant. Core exports `SYSTEM_FIELDS` but Python can't import TypeScript.

**Fix**: Create `python/datafn/constants.py` with `SYSTEM_FIELDS` set matching core. Add a comment referencing core as source of truth. Or generate from core at build time.

---

#### DUP-15: Python Schema Validation Parallel Implementation (LOW)

| Field | Value |
|---|---|
| **Severity** | 🟢 Low |
| **Locations** | `core/src/schema-index.ts` (canonical), `python/datafn/validation.py:4-161` (~177 lines) |

Python's `SchemaIndex` class reimplements the same index-building logic as core. This is inherent to cross-language — Python can't import TypeScript. The duplication is structural, not avoidable without code generation.

**Fix**: Accept as cross-language cost. Add comments in Python referencing core as canonical. Consider generating Python constants/types from core schema at build time for long-term parity.

---

## Well-Structured Areas (No Duplication Found)

| Area | Assessment |
|---|---|
| **Date handling** | Core provides primitives; client codec wraps. Clean layering. |
| **Sort logic** | Core provides `parseSortTerms()`/`sortRecords()`; server adds cursor defaults. Proper delegation. |
| **Select/expansion** | Core provides `parseSelectToken()`; server materializes. Server-specific, appropriate. |
| **KV abstraction** | Core provides `ensureBuiltinKv()`/`kvId()`; client implements API. Clean separation. |
| **DFQL normalization** | Core provides `normalizeDfql()`/`dfqlKey()`. Single source of truth. |
| **Join store keys** | Core provides `getJoinStoreKey()`/`enumerateJoinStoreKeys()`. Fully adopted. |
| **Type exports** | Core is single source for domain types. |
| **Svelte adapter** | Thin wrapper. No duplication. |
| **CLI** | Unique codegen functionality. No overlap. |

---

## Consolidation Roadmap

### Phase 1: Adopt Existing Core Utilities (Low Risk, Immediate)

These are mechanical replacements — the core utilities already exist.

| Task | Lines Saved | Files Changed | Risk |
|---|---|---|---|
| Replace inline join table name with `getJoinTableName()` in mutation/relations.ts and db-store.ts | ~21 (7 sites) | 2 | Trivial |
| Replace `PluginError` with core `HookError` | ~5 | 1 | Trivial |
| Import `DatafnError` from core in execution/errors.ts, remove `as any` casts | ~8 | 3 | Low |

### Phase 2: Extract New Utilities to Core (Medium Risk)

| Task | Lines to Core | Lines Saved | Files Changed |
|---|---|---|---|
| Extract `NormalizedRelation` + `normalizeRelationPayload()` to `core/src/relations.ts` | ~35 | ~55 | 3 (core, server, client) |
| Add `findRelationBidirectional()` to core, migrate 4 callers | ~15 | ~50 | 5 (core + 4 callers) |
| Export `OP_REMAP` + `normalizeFilterOps()` from `core/src/filters.ts` | ~20 | ~30 | 3 (core, server, client) |
| Extract `calculateAggregation()` to core | ~25 | ~40 | 3 (core, server, client) |
| Refactor server/client to delegate `$and/$or` to core | ~0 | ~34 | 2 (server, client) |
| Hook wrapper factory | ~40 | ~80 | 3 (core, server, client) |

### Phase 3: Cross-Language & Consistency (Long-Term)

| Task | Description |
|---|---|
| Extend core `SchemaIndex` with `writableFieldsByResource` | Server validation can import instead of rebuild |
| Python constants from core | Shared constant file or build-time generation |
| Client aggregate group key fix | Use `JSON.stringify()` like server |
| Complete Python filter operators | Match core's 21+ operators |

---

## Quantitative Summary

| Metric | Value |
|---|---|
| Total issues identified | 15 |
| Already fixed in core (but not adopted) | 3 (DUP-1, DUP-2, DUP-3) |
| Needs extraction to core | 7 (DUP-4 through DUP-10) |
| Type/error inconsistencies | 3 (DUP-11, DUP-12, DUP-13) |
| Python cross-language parity | 2 (DUP-14, DUP-15) |
| Estimated duplicated lines (total) | ~550 |
| Lines saveable via Phase 1 (adopt existing) | ~34 |
| Lines saveable via Phase 2 (extract + migrate) | ~289 |
| Net reduction after Phase 1+2 | ~323 lines |
| Packages affected | 4 of 6 (core, server, client, python) |
| Packages clean | 2 of 6 (cli, svelte) |

### Comparison to Prior Audit (2026-02-24)

| Metric | Prior Audit Claimed | Actual (This Audit) | Delta |
|---|---|---|---|
| `getJoinTableName` in core | Not mentioned | Already extracted, partially adopted | Prior audit missed existing core utility |
| `SchemaIndex` in core | "Extract to core" | Already in core since `core/src/schema-index.ts` | Prior audit missed existing extraction |
| `SYSTEM_FIELDS` in core | "Extract to core" | Already exported from `core/src/system-fields.ts` | Prior audit missed it |
| `getRelation()` in core | Not mentioned | Already in core, but bidirectional version missing | Partial — needs extension |
| Total duplication estimate | ~1,200 lines | ~550 lines | Prior audit overstated by ~2x by counting already-extracted utilities |

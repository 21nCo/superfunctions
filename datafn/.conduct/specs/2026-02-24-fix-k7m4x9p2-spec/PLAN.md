# PLAN: Consolidate Duplicated Code Into @datafn/core — Execution Strategy

## Architecture Sketch

### Modules and Responsibilities

```
@datafn/core (datafn/core/)
├── src/
│   ├── system-fields.ts ......... NEW: SYSTEM_FIELDS, READONLY_SYSTEM_FIELDS constants
│   ├── schema-index.ts .......... NEW: buildSchemaIndex(), getResource(), getField(), getRelation(), etc.
│   ├── filters.ts ............... NEW: evaluateFilter() with full operator set + relation resolver injection
│   ├── sort.ts .................. NEW: parseSortTerms(), sortRecords()
│   ├── date.ts .................. NEW: toEpochMs(), fromEpochMs(), coerceDateFieldsToEpoch(), parseDateFieldsToDate()
│   ├── hooks.ts ................. NEW: runBeforeHook(), runAfterHook()
│   ├── select.ts ................ NEW: parseSelectToken()
│   ├── index.ts ................. MODIFIED: re-export all new modules
│   ├── joins.ts ................. EXISTING (from issue k4x7m9p3)
│   ├── types.ts ................. EXISTING (unchanged)
│   ├── dfql.ts .................. EXISTING (unchanged)
│   ├── errors.ts ................ EXISTING (unchanged)
│   ├── envelope.ts .............. EXISTING (unchanged)
│   ├── normalize.ts ............. EXISTING (unchanged)
│   ├── schema.ts ................ EXISTING (unchanged)
│   └── kv.ts .................... EXISTING (unchanged)
│
@datafn/client (datafn/client/)
├── src/
│   ├── offline/query.ts ......... MODIFIED: import evaluateFilter, parseSortTerms from core
│   ├── codecs/date.ts ........... MODIFIED: delegate to core date utilities
│   ├── plugins/run-hooks.ts ..... MODIFIED: delegate to core hook runner
│   ├── adapters/shared.ts ....... NEW: shared storage adapter validation
│   ├── adapters/indexedDbStorage.ts  MODIFIED: import from adapters/shared.ts
│   ├── adapters/memoryStorage.ts    MODIFIED: import from adapters/shared.ts
│   ├── events/build.ts ......... NEW: buildEvent() factory
│   └── client.ts ............... MODIFIED: use SchemaIndex, buildEvent
│
@datafn/server (datafn/server/)
├── src/
│   ├── validation/schema.ts ..... MODIFIED: import from core, extend SchemaIndex
│   ├── execution/query/filters.ts  MODIFIED: delegate to core evaluateFilter
│   ├── execution/query/sort.ts ... MODIFIED: re-export from core
│   ├── execution/query/select.ts . MODIFIED: import parseSelectToken from core
│   ├── execution/sync/push.ts .... MODIFIED: import coerceDateFieldsToEpoch from core
│   └── plugins/run-hooks.ts ...... MODIFIED: delegate to core hook runner
```

### Dependency Graph

```
Phase 0: System fields + Schema index (core foundations)
    │     (SYS-001, SYS-002, IDX-001, IDX-002, REG-001 partial)
    │     No dependencies. These are constants and pure utility functions.
    │
    ▼
Phase 1: Filter evaluation + Sort + Select token (query utilities)
    │     (FLT-001..004, SRT-001..003, SEL-001, SEL-002)
    │     Depends on Phase 0 (filters may use SchemaIndex for relation detection).
    │
    ▼
Phase 2: Date codecs + Plugin hooks (mutation/sync utilities)
    │     (DTE-001..004, HKS-001..003)
    │     No hard dependency on Phase 1, but logically follows.
    │
    ▼
Phase 3: Client-internal dedup + alignment + final verification
          (IDX-003, VLD-001, STR-001, EVT-001, REG-001 complete, TST-001, TST-002)
          Depends on Phases 0-2 (all core modules must be ready).
```

### Phases Overview

| Phase | Goal | Delivered Capability | Verification |
|---|---|---|---|
| 0 | Core foundations | SYSTEM_FIELDS, READONLY_SYSTEM_FIELDS constants; buildSchemaIndex() with full lookup API; server extends core index | Core unit tests pass; server validation tests pass; no hardcoded system field sets remain in server |
| 1 | Query utilities | Shared evaluateFilter() with all operators; parseSortTerms() + sortRecords(); parseSelectToken() | Core filter/sort/select tests pass; client offline tests pass; server query tests pass |
| 2 | Mutation/sync utilities | Shared date codecs (toEpochMs, fromEpochMs, coerceFields, parseFields); generic hook runner | Core date/hook tests pass; client date codec tests pass; server push tests pass; client/server plugin tests pass |
| 3 | Cleanup + final verification | Client SchemaIndex adoption; ValidationResult alignment; storage adapter dedup; event factory; full re-export | All tests across all 5 packages pass; zero duplicated definitions remain for consolidated items |

### Definition of Done (global)

No phase is complete unless:
1. All listed verification steps pass.
2. All requirement IDs for that phase are satisfied.
3. Existing tests continue to pass (`npm test` in the affected packages).
4. No new TypeScript compilation errors are introduced.
5. New core modules have dedicated unit tests.
6. Deleted local implementations are confirmed removed (grep verification).

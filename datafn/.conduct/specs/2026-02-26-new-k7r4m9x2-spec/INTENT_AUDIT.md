# INTENT_AUDIT: Row-Level Namespace Isolation

## Purpose
Maps every intent raised during the design discussion to the spec sections and requirements that address it. Ensures no discussed intent is left unspecified.

---

## Intent Inventory

### INT-01: Server-side data tables have no row-level filtering
**Source**: Investigation of `clone.ts`, `query.ts`, memory/drizzle adapters — `params.namespace` is passed but ignored by all adapters.
**Spec Coverage**: SPEC.md §Problem Statement, §Overview
**Requirements**: RLN-001 (inject WHERE), RLN-003 (reads filtered)
**Phase**: 0, 1
**Status**: ✅ Fully covered

### INT-02: Discriminator column pattern (`__ns`)
**Source**: Discussion of adapter-agnostic approach — add a column to data tables, inject filters at the adapter wrapper layer.
**Spec Coverage**: SPEC.md §Overview, §Data Formats (column spec), §Public API (`wrapWithRowLevelNamespace`)
**Requirements**: RLN-001, RLN-002, SCH-001, SCH-002
**Phase**: 0, 4
**Status**: ✅ Fully covered

### INT-03: Wrapper should be adapter-agnostic
**Source**: Requirement that the solution work with any SQL database and any adapter (Drizzle, Prisma, Kysely, memory).
**Spec Coverage**: SPEC.md §Goals (G-1), §Public API
**Requirements**: RLN-001 through RLN-012 (all use wrapper, not adapter-specific code)
**Phase**: 0
**Status**: ✅ Fully covered

### INT-04: Automatic stamping on creates
**Source**: Discussion that `__ns` must be injected into write data automatically.
**Spec Coverage**: SPEC.md §Semantics (write path)
**Requirements**: RLN-002
**Phase**: 0
**Test Vectors**: TV-RLN-002-*
**Status**: ✅ Fully covered

### INT-05: Stripping `__ns` from outputs
**Source**: Callers should never see the discriminator column in returned data.
**Spec Coverage**: SPEC.md §Semantics (output stripping)
**Requirements**: RLN-005
**Phase**: 0
**Test Vectors**: TV-RLN-005-*
**Status**: ✅ Fully covered

### INT-06: Mandatory namespace enforcement
**Source**: If `mandatory: true`, calls without a namespace must throw.
**Spec Coverage**: SPEC.md §Invariants (INV-2)
**Requirements**: RLN-006
**Phase**: 0
**Test Vectors**: TV-RLN-006-*
**Status**: ✅ Fully covered

### INT-07: `db.internal` passthrough
**Source**: Internal tables (`__datafn_meta`, `__datafn_changes`) already have their own isolation and must NOT be double-filtered.
**Spec Coverage**: SPEC.md §Semantics (internal bypass)
**Requirements**: RLN-007
**Phase**: 0
**Test Vectors**: TV-RLN-007-*
**Status**: ✅ Fully covered

### INT-08: Opt-in at `@superfunctions/db` level
**Source**: `rowLevelNamespace` is opt-in configuration, not forced on all users.
**Spec Coverage**: SPEC.md §Public API (`RowLevelNamespaceConfig.enabled`)
**Requirements**: RLN-008
**Phase**: 0
**Status**: ✅ Fully covered

### INT-09: datafn auto-enables when `authContextProvider` is configured
**Source**: Discussion that datafn should auto-wrap when auth context is present.
**Spec Coverage**: SPEC.md §Goals (G-3)
**Requirements**: DFN-001, DFN-002
**Phase**: 2
**Status**: ✅ Fully covered

### INT-10: Opt-out escape hatch for datafn
**Source**: Explicit `rowLevelNamespace: false` should disable auto-wrapping.
**Spec Coverage**: SPEC.md §Public API (DatafnServerConfig extension)
**Requirements**: DFN-003
**Phase**: 2
**Status**: ✅ Fully covered

### INT-11: `multiTenant` schema flag
**Source**: Schema-level boolean that controls codegen and runtime behavior.
**Spec Coverage**: SPEC.md §Public API, §Data Formats
**Requirements**: SCH-001, SCH-002, SCH-003
**Phase**: 4
**Status**: ✅ Fully covered

### INT-12: Drizzle codegen `__ns` column + index
**Source**: CLI codegen must emit the discriminator column and index.
**Spec Coverage**: SPEC.md §Data Formats (generated schema)
**Requirements**: SCH-004, SCH-005, SCH-006
**Phase**: 4
**Status**: ✅ Fully covered

### INT-13: Existing `authorize` callback and `authz.ts` are request-level gates, not row-level
**Source**: Investigation found `authorize` is a boolean gate and `authz.ts` is field-level permissions — neither provides data filtering.
**Spec Coverage**: SPEC.md §Problem Statement (explicitly noted as non-goal to replace these)
**Requirements**: N/A (existing functionality, not modified)
**Phase**: N/A
**Status**: ✅ Acknowledged in spec, no action needed

### INT-14: `extractNamespace` already resolves correct namespace strings
**Source**: `extractNamespace(ctx)` in `server.ts` already produces `"user:{userId}"` / `"tenant:{tenantId}:user:{userId}"` / `"datafn"`.
**Spec Coverage**: SPEC.md §Semantics (namespace resolution)
**Requirements**: DFN-004
**Phase**: 2 (verification only, no code changes expected)
**Status**: ✅ Fully covered

### INT-15: Transaction isolation
**Source**: Wrapper must work correctly inside transactions.
**Spec Coverage**: SPEC.md §Invariants (INV-3)
**Requirements**: RLN-009
**Phase**: 0, 1
**Test Vectors**: TV-RLN-009-*
**Status**: ✅ Fully covered

### INT-16: Cross-namespace injection prevention
**Source**: User-supplied `__ns` in WHERE must not override the wrapper's injected value.
**Spec Coverage**: SPEC.md §Security (SEC-1)
**Requirements**: RLN-010
**Phase**: 0, 3
**Test Vectors**: TV-RLN-010-*
**Status**: ✅ Fully covered

### INT-17: Migration path for existing databases
**Source**: Existing deployments need a way to add `__ns` column and backfill.
**Spec Coverage**: SPEC.md §Compatibility
**Requirements**: MIG-001
**Phase**: 5
**Status**: ✅ Fully covered

### INT-18: Contract test suite reusable across adapters
**Source**: Every adapter should be able to prove namespace isolation with a shared test suite.
**Spec Coverage**: SPEC.md §Goals (G-5)
**Requirements**: TST-001
**Phase**: 1, 5
**Status**: ✅ Fully covered

---

## Coverage Summary

- **Total intents identified**: 18
- **Fully covered by spec**: 18
- **Partially covered**: 0
- **Not covered**: 0
- **Coverage**: 100%

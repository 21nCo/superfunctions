# INTENT AUDIT: Consolidate Duplicated Code Into @datafn/core

## Intent Inventory

The following intent items were extracted from:
- The audit report `datafn/.conduct/audits/2026-02-24-code-duplication-reusability-audit.md` (15 findings: DUP-001 through DUP-015).
- The user's request: "scan datafn packages and create an audit report about duplication of code and potential reusability by moving shared code into core package".
- The user's follow-up: "create a detailed and thorough specification for fixing all issues" in the audit.
- The resolved issue `datafn/.conduct/issues/2026-02-24-k4x7m9p3-issue.md` (DUP-006 already fixed).

### Inventory

| # | Intent Item | Source |
|---|---|---|
| 1 | Eliminate duplicated filter evaluation between client offline and server query execution | Audit DUP-001 (Critical) |
| 2 | Create shared schema index with O(1) lookups to replace 11+ ad-hoc .find() calls | Audit DUP-002 (Critical) |
| 3 | Consolidate date codecs between client (serialize/parse) and server (coerce) | Audit DUP-003 (Critical) |
| 4 | Export SYSTEM_FIELDS and READONLY_SYSTEM_FIELDS from core instead of hardcoding | Audit DUP-004 (High) |
| 5 | Unify plugin hook runner between client and server | Audit DUP-005 (High) |
| 6 | Consolidate join table name resolution (already resolved) | Audit DUP-006 (High) — EXCLUDED |
| 7 | Create shared select token parser to eliminate dual parsing in server | Audit DUP-007 (High) |
| 8 | Align server ValidationResult property naming with DatafnEnvelope | Audit DUP-008 (Moderate) |
| 9 | Create shared sort term parsing used by both client and server | Audit DUP-009 (Moderate) |
| 10 | String case conversion utilities in CLI (toPascalCase, camelToSnake) | Audit DUP-010 (Moderate) |
| 11 | Deterministic resource/field sorting in CLI codegen | Audit DUP-011 (Moderate) |
| 12 | Deduplicate storage adapter validation between indexedDB and memory adapters | Audit DUP-012 (Moderate) |
| 13 | Extract event emission factory in client | Audit DUP-013 (Moderate) |
| 14 | Monitor error classification patterns across client and server | Audit DUP-014 (Low) |
| 15 | Monitor relation handling logic for future partial extraction | Audit DUP-015 (Low) |
| 16 | No breaking changes — all consolidation must be internal refactoring | Implicit from user request (fix, not rewrite) |
| 17 | All existing tests must pass after consolidation | Implicit from fix-type spec |
| 18 | New core modules must have dedicated unit tests | Implicit from spec framework requirements |

## Coverage Mapping

| # | Intent Item | SPEC.md Section | Requirements | Test Vectors |
|---|---|---|---|---|
| 1 | Filter evaluation consolidation | Public API → evaluateFilter; Architecture → filters.ts; Semantics → INV-001, INV-002 | FLT-001, FLT-002, FLT-003, FLT-004 | TV-FLT-001 through TV-FLT-008 |
| 2 | Schema index with O(1) lookups | Public API → SchemaIndex, buildSchemaIndex, lookup helpers; Architecture → schema-index.ts | IDX-001, IDX-002, IDX-003 | TV-IDX-001 through TV-IDX-004 |
| 3 | Date codecs consolidation | Public API → toEpochMs, fromEpochMs, coerceDateFieldsToEpoch, parseDateFieldsToDate; Semantics → INV-005 | DTE-001, DTE-002, DTE-003, DTE-004 | TV-DTE-001 through TV-DTE-004 |
| 4 | System fields from core | Public API → SYSTEM_FIELDS, READONLY_SYSTEM_FIELDS; Semantics → INV-003 | SYS-001, SYS-002 | TV-SYS-001, TV-SYS-002 |
| 5 | Plugin hook runner | Public API → runBeforeHook, runAfterHook; Semantics → INV-006 | HKS-001, HKS-002, HKS-003 | TV-HKS-001 through TV-HKS-004 |
| 6 | Join table name (EXCLUDED) | N/A — resolved by issue k4x7m9p3 | N/A | N/A |
| 7 | Select token parser | Public API → parseSelectToken, SelectToken; Architecture → select.ts | SEL-001, SEL-002 | TV-SEL-001, TV-SEL-002 |
| 8 | ValidationResult alignment | Non-Goals (partial); Phase 3 | VLD-001 | TV-VLD-001 |
| 9 | Sort term parsing | Public API → parseSortTerms, sortRecords; Semantics → INV-007 | SRT-001, SRT-002, SRT-003 | TV-SRT-001 through TV-SRT-003 |
| 10 | CLI string utilities | Non-Goals — CLI-only, low duplication risk | N/A | N/A |
| 11 | CLI deterministic sorting | Non-Goals — CLI-only, low duplication risk | N/A | N/A |
| 12 | Storage adapter validation | Architecture → adapters/shared.ts | STR-001 | TV-STR-001 |
| 13 | Event emission factory | Architecture → events/build.ts | EVT-001 | TV-EVT-001 |
| 14 | Error classification (Monitor) | Non-Goals — marked "Monitor" in audit | N/A | N/A |
| 15 | Relation handling (Monitor) | Non-Goals — marked "Monitor" in audit | N/A | N/A |
| 16 | No breaking changes | Goals #8; Semantics → INV-008; Compatibility | TST-001 | All TV-*-003/-004 regression vectors |
| 17 | All tests pass | Goals #9 | TST-001 | N/A (meta-requirement) |
| 18 | New core unit tests | TST-002 | TST-002 | All TV-* vectors |

## Missing Intent Items

**No missing intent items for in-scope work.** All 15 audit findings are addressed:

- **DUP-001 through DUP-005**: Full consolidation into core (Phases 0-2).
- **DUP-006**: Excluded — already resolved by issue `2026-02-24-k4x7m9p3-issue.md`. Verified: `getJoinStoreKey()`, `getJoinTableName()`, and `enumerateJoinStoreKeys()` are exported from `@datafn/core/joins.ts` and used across all client/server locations. Zero remaining inline derivations.
- **DUP-007**: Consolidated into core select parser (Phase 1).
- **DUP-008**: Addressed via property rename in Phase 3 (VLD-001).
- **DUP-009**: Consolidated into core sort parser (Phase 1).
- **DUP-010, DUP-011**: Intentionally excluded — CLI-only, low duplication risk, no cross-package sharing needed.
- **DUP-012, DUP-013**: Client-internal dedup in Phase 3.
- **DUP-014, DUP-015**: Intentionally excluded — marked "Monitor" in audit, low urgency.

## DUP-006 Resolution Verification

Issue `2026-02-24-k4x7m9p3-issue.md` resolved join table name duplication with the following changes:

| File | Change |
|---|---|
| `datafn/core/src/joins.ts` | Created with `getJoinStoreKey()`, `getJoinTableName()`, `enumerateJoinStoreKeys()` |
| `datafn/core/src/index.ts` | Re-exports all three functions |
| `datafn/client/src/sync/engine.ts` | Imports from core; added join cursor loops |
| `datafn/client/src/export.ts` | Fixed bug: `relation.field` → uses `getJoinStoreKey` from core |
| `datafn/client/src/offline/relations.ts` | Removed local `getJoinStoreName`, imports from core |
| `datafn/client/src/adapters/indexedDbStorage.ts` | Removed duplicate, imports from core |
| `datafn/client/src/offline/mutate.ts` | Uses `getJoinStoreKey` from core |
| `datafn/client/src/sync/cloneUp.ts` | Uses `getJoinStoreKey` from core |
| `datafn/server/src/execution/mutation/relations.ts` | Uses `getJoinStoreKey` from core |
| `datafn/server/src/execution/sync/clone.ts` | Uses both `getJoinStoreKey` and `getJoinTableName` from core |
| `datafn/server/src/execution/sync/reconcile.ts` | Uses both utilities from core |

**Grep verification**: Zero remaining inline `` `join_${ `` derivations in client/server src. All 469 client tests pass, all server relation tests pass.

**Conclusion**: DUP-006 is fully resolved and correctly excluded from this spec.

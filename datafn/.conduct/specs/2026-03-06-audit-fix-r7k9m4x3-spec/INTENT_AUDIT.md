# INTENT AUDIT: Python Package Parity with TypeScript (Non-Capabilities)

## Intent Source
The intent is derived from the audit report `datafn/.conduct/audits/2026-03-06-py7k4m9x-full-audit.md` combined with a comprehensive line-by-line comparison of the TypeScript server (`datafn/server/src/`) against the Python package (`datafn/python/datafn/`), **excluding all capabilities-related items** (timestamps, audit, trash, archivable, shareable).

---

## Intent Inventory

### From Audit Report (Non-Capabilities Items)

| # | Intent Item | Source |
|---|---|---|
| 1 | Full filter operator support (22 operators) | TS `core/src/filters.ts` vs Python `filters.py` |
| 2 | Filter operator remapping (normalizeFilterOps) | TS `core/src/filters.ts` OP_REMAP |
| 3 | Logical filter operators ($and, $or) | TS `core/src/filters.ts` |
| 4 | Dot-path filter traversal | TS `core/src/filters.ts` |
| 5 | Filter depth limiting | TS `core/src/filters.ts` MAX_FILTER_DEPTH |
| 6 | Sort term parsing | TS `core/src/sort.ts` parseSortTerms |
| 7 | In-memory record sorting with null handling | TS `core/src/sort.ts` sortRecords |
| 8 | Default sort enforcement (id:asc) | TS `server/src/execution/query/sort.ts` |
| 9 | Select token parsing | TS `core/src/select.ts` parseSelectToken |
| 10 | Select/omit application on results | TS `server/src/execution/query/select.ts` |
| 11 | Date coercion utilities | TS `core/src/date.ts` |
| 12 | Aggregation operations (count/sum/min/max/avg) | TS `core/src/aggregate.ts` |
| 13 | DFQL normalization | TS `core/src/normalize.ts` |
| 14 | Join table utilities | TS `core/src/joins.ts` |
| 15 | Namespace helper (ns()) | TS `core/src/ns.ts` |
| 16 | Schema validation on server init | TS `server/src/server.ts` validateSchema call |
| 17 | FK field injection in SchemaIndex | TS `server/src/validation/schema.ts` |
| 18 | Read-only field tracking | TS READONLY_SYSTEM_FIELDS + field.readonly |
| 19 | Field type validation on mutations | TS `core/src/validate.ts` validateFieldValue |
| 20 | Required field validation for inserts | TS `server/src/execution/mutation/records.ts` |
| 21 | Default value application | TS schema field.default |
| 22 | Prototype pollution check | TS `core/src/validate.ts` checkPrototypePollution |
| 23 | Limit enforcement (maxSelectTokens, maxSortFields, etc.) | TS `server/src/server.ts` limits config |
| 24 | ID length validation | TS maxIdLength |
| 25 | Cursor pagination (forward) | TS `server/src/execution/query/execute.ts` |
| 26 | Cursor pagination (backward) | TS `server/src/execution/query/execute.ts` |
| 27 | nextCursor computation | TS `server/src/execution/query/pagination.ts` |
| 28 | Offset pagination | TS `server/src/execution/query/pagination.ts` |
| 29 | Limit enforcement (maxLimit clamping) | TS `server/src/execution/query/execute.ts` |
| 30 | Count queries | TS `server/src/execution/query/execute.ts` |
| 31 | Aggregation queries (groupBy, having) | TS `server/src/execution/query/aggregate.ts` |
| 32 | Merge decision logic (create vs update) | TS `server/src/execution/mutation/merge-decision.ts` |
| 33 | Replace record logic (preserve system fields) | TS `server/src/execution/mutation/dfql.ts` |
| 34 | Batch insert via records[] | TS `server/src/execution/mutation/execute.ts` |
| 35 | Error classification (DB errors → codes) | TS `server/src/execution/errors.ts` |
| 36 | Change tracking in mutation path | TS `server/src/execution/mutation/execute.ts` |
| 37 | Idempotent delete (no change tracking) | TS `server/src/execution/mutation/execute.ts` |
| 38 | Guard transaction wrapping | TS `server/src/execution/mutation/execute.ts` |
| 39 | Mutation result structure normalization | TS MutationResult type |
| 40 | Atomic transaction wrapping | TS `server/src/execution/transact.ts` |
| 41 | Rollback annotation | TS `server/src/execution/transact.ts` |
| 42 | Push date coercion | TS `server/src/execution/sync/push.ts` |
| 43 | Pull cursor validation | TS `server/src/execution/sync/pull.ts` |
| 44 | Pull limit enforcement with hasMore | TS `server/src/execution/sync/pull.ts` |
| 45 | Join table sync in pull | TS `server/src/execution/sync/pull.ts` |
| 46 | Namespace consistency in sync | TS all sync handlers |
| 47 | Logger interface | TS `server/src/logging.ts` |
| 48 | Plugin/hook system | TS `server/src/plugins/run-hooks.ts` |
| 49 | Payload size limit | TS `server/src/http/middleware.ts` |
| 50 | Config validation on init | TS `server/src/server.ts` |
| 51 | Field-level authorization | TS `server/src/validation/authz.ts` |
| 52 | Sort validation for cursor (id required) | TS `server/src/execution/query/sort.ts` |

---

## Intent → Spec Coverage Matrix

| # | Intent Item | SPEC.md Section | Requirement IDs | Test Vectors |
|---|---|---|---|---|
| 1 | Full filter operator support | Semantics > Filter Evaluation | FILT-001 | TV-FILT-001 to TV-FILT-010 |
| 2 | Filter operator remapping | Semantics > Filter Evaluation | FILT-002 | TV-FILT-011 |
| 3 | Logical filter operators | Semantics > Filter Evaluation | FILT-003 | TV-FILT-012, TV-FILT-013 |
| 4 | Dot-path filter traversal | Semantics > Filter Evaluation | FILT-004 | TV-FILT-014 |
| 5 | Filter depth limiting | Limits/Caps | FILT-005 | TV-FILT-015 |
| 6 | Sort term parsing | Semantics > Sort Parsing | SORT-001 | TV-SORT-001 |
| 7 | In-memory record sorting | Semantics > Sort Parsing | SORT-002 | TV-SORT-002, TV-SORT-003 |
| 8 | Default sort enforcement | Semantics > Sort Parsing | SORT-003 | TV-SORT-004 |
| 9 | Select token parsing | Semantics > Select/Omit | SEL-001 | TV-SEL-001 |
| 10 | Select/omit application | Semantics > Select/Omit | SEL-002 | TV-SEL-002, TV-SEL-003 |
| 11 | Date coercion utilities | Public API (implicit) | DATE-001 | TV-DATE-001 |
| 12 | Aggregation operations | Semantics > Aggregation | AGG-001 | TV-AGG-001 |
| 13 | DFQL normalization | (Utility) | NORM-001 | TV-NORM-001 |
| 14 | Join table utilities | (Utility) | JOIN-001 | TV-JOIN-001 |
| 15 | Namespace helper | (Utility) | NS-001 | TV-NS-001 |
| 16 | Schema validation on init | Invariants #6 | VAL-001 | TV-VAL-001, TV-VAL-002 |
| 17 | FK field injection | Semantics (implicit) | VAL-002 | TV-VAL-003 |
| 18 | Read-only field tracking | Security | VAL-003 | TV-VAL-004 |
| 19 | Field type validation | Semantics (implicit) | VAL-004 | TV-VAL-005 |
| 20 | Required field validation | Semantics (implicit) | VAL-005 | TV-VAL-006 |
| 21 | Default value application | Semantics (implicit) | VAL-006 | TV-VAL-007 |
| 22 | Prototype pollution check | Security | VAL-007 | TV-VAL-008 |
| 23 | Limit enforcement | Limits/Caps | VAL-008 | TV-VAL-009 |
| 24 | ID length validation | Limits/Caps | VAL-009 | TV-VAL-010 |
| 25 | Cursor pagination (forward) | Semantics > Cursor Pagination | QRY-001 | TV-QRY-001 |
| 26 | Cursor pagination (backward) | Semantics > Cursor Pagination | QRY-002 | TV-QRY-002 |
| 27 | nextCursor computation | Semantics > Cursor Pagination | QRY-003 | TV-QRY-003 |
| 28 | Offset pagination | Semantics > Cursor Pagination | QRY-004 | TV-QRY-004 |
| 29 | Limit enforcement (query) | Limits/Caps | QRY-005 | TV-QRY-005 |
| 30 | Count queries | Semantics (implicit) | QRY-006 | TV-QRY-006 |
| 31 | Aggregation queries | Semantics > Aggregation | QRY-007 | TV-QRY-007 |
| 32 | Merge decision logic | Semantics > Merge Decision | MUT-001 | TV-MUT-001 |
| 33 | Replace record logic | Semantics (implicit) | MUT-002 | TV-MUT-002 |
| 34 | Batch insert via records[] | (Implicit) | MUT-003 | TV-MUT-003 |
| 35 | Error classification | Semantics > Error Classification | MUT-004 | TV-MUT-004 |
| 36 | Change tracking in mutations | (Implicit) | MUT-005 | TV-MUT-005 |
| 37 | Idempotent delete | Invariants #2 | MUT-006 | TV-MUT-006 |
| 38 | Guard transaction wrapping | (Implicit) | MUT-007 | TV-MUT-007 |
| 39 | Mutation result structure | Data Formats > Mutation Result | MUT-008 | TV-MUT-008 |
| 40 | Atomic transaction wrapping | Invariants #7 | TXN-001 | TV-TXN-001 |
| 41 | Rollback annotation | (Implicit) | TXN-002 | TV-TXN-002 |
| 42 | Push date coercion | (Implicit) | SYN-001 | TV-SYN-001 |
| 43 | Pull cursor validation | (Implicit) | SYN-002 | TV-SYN-002 |
| 44 | Pull limit enforcement | Limits/Caps | SYN-003 | TV-SYN-003 |
| 45 | Join table sync in pull | (Implicit) | SYN-004 | TV-SYN-004 |
| 46 | Namespace consistency | (Implicit) | SYN-005 | TV-SYN-005 |
| 47 | Logger interface | Observability | SRV-001 | TV-SRV-001 |
| 48 | Plugin/hook system | Public API > Plugin Interface | SRV-002 | TV-SRV-002 |
| 49 | Payload size limit | Limits/Caps | SRV-003 | TV-SRV-003 |
| 50 | Config validation | (Implicit) | SRV-004 | TV-SRV-004 |
| 51 | Field-level authorization | Security | AUTH-001 | TV-AUTH-001 |
| 52 | Sort validation for cursor | Semantics > Cursor Pagination | QRY-009 | TV-QRY-008 |

---

## Missing Intent Items

**No missing intent items.** All 52 identified parity gaps are covered by:
- SPEC.md sections
- Requirement IDs in REQUIREMENTS.md
- Test vectors in TEST_VECTORS.md
- Phase assignments in PLAN.md

---

## Explicitly Excluded (Per User Request)

The following items from the original audit are explicitly excluded from this spec:

| # | Item | Reason |
|---|---|---|
| E1 | Capability type definitions (CAP-001) | In-progress capabilities spec |
| E2 | Capability resolution algorithm (CAP-002) | In-progress capabilities spec |
| E3 | Capability field injection (CAP-003) | In-progress capabilities spec |
| E4 | Capability field collision detection (CAP-004) | In-progress capabilities spec |
| E5 | SYSTEM_FIELDS removal (CAP-005) | In-progress capabilities spec |
| E6 | Global + resource-level merging (CAP-006) | In-progress capabilities spec |
| E7 | Readonly field stripping (CAP-007) | In-progress capabilities spec |
| E8 | Timestamps auto-set (TS-001 to TS-004) | In-progress capabilities spec |
| E9 | Audit auto-set (AUD-001 to AUD-005) | In-progress capabilities spec |
| E10 | Trash operations (TR-001 to TR-008) | In-progress capabilities spec |
| E11 | Archivable operations (AR-001 to AR-007) | In-progress capabilities spec |
| E12 | Shareable operations (SH-001 to SH-011) | In-progress capabilities spec |
| E13 | Codegen (CG-001 to CG-003) | Python has no codegen (N/A) |
| E14 | Client API (CL-001 to CL-009) | Python is server-only (N/A) |
| E15 | WebSocket support | Deferred (complex transport layer) |
| E16 | REST endpoint generation | Deferred (optional TS feature) |
| E17 | Redis integration | Deferred (adapter-level concern) |
| E18 | Rate limiting | Deferred (requires external store) |
| E19 | Query pushdown/classification | Deferred (optimization; Python evaluates in-memory) |
| E20 | Search plugin execution | Deferred (hook points added but no search impl) |

---

## Final Statement

**No missing intent items.** The spec fully covers all 52 non-capabilities parity gaps identified between the TypeScript server and Python package. The 20 explicitly excluded items are either handled by the capabilities spec, not applicable to Python, or explicitly deferred per the user's request.

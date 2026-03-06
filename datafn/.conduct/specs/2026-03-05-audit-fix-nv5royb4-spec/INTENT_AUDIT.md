# INTENT AUDIT

## Intent Inventory
1. Enforce configurable max batch size on both push and mutation endpoints (remaining SEC-006 gaps).
2. Apply prototype-pollution rejection to full query payload, aggregations, and having (remaining SEC-008 gap).
3. Make change-tracking retry behavior consistent between push and execute paths (remaining REL-002 parity gap).
4. Ensure push mutation write and change-tracking write are atomic together when transactions are available (remaining REL-011/EXE-020 gap).
5. Remove dynamic imports from route hot paths (remaining PER-002 gap in mutation route).
6. Remove synthetic REST request bridge and call internal execution directly (remaining SRV-001 partial gap).
7. Implement bounded queue-based query batch concurrency instead of reject/Promise.all behavior (remaining SRV-003 gap).
8. Split monolithic query route into modular files for maintainability without behavior change (remaining SRV-005).
9. Cache FK omit-set computation outside per-record loops (remaining EXE-014 gap).
10. Replace search candidate truncation with paged processing of all candidates (remaining EXE-017 partial gap).
11. Introduce batch write capability for change-tracking entries with deterministic fallback (remaining EXE-018 gap).
12. Remove full-table fallback loads for unhandled relation paths/types in secondary loading (remaining EXE-022 partial gap).
13. Remove direct console fallback in request logging helper and require logger path (remaining LOG-002 partial gap).

## Intent Item Coverage Matrix

| Intent # | Covered in SPEC.md | Requirement IDs | Test Vectors |
|---|---|---|---|
| 1 | Semantics -> Batch limits | FIX-SEC-006 | TV-SEC-006-P1, TV-SEC-006-N1, TV-SEC-006-P2, TV-SEC-006-N2 |
| 2 | Semantics -> Prototype-pollution validation scope; Security | FIX-SEC-008 | TV-SEC-008-P1, TV-SEC-008-N1, TV-SEC-008-N2 |
| 3 | Semantics -> Change-tracking retry parity | FIX-REL-002 | TV-REL-002-P1, TV-REL-002-N1 |
| 4 | Semantics -> Push atomicity; Invariants | FIX-REL-011 | TV-REL-011-P1, TV-REL-011-N1 |
| 5 | Public API/Internal APIs; Semantics | FIX-PER-002 | TV-PER-002-P1, TV-PER-002-N1 |
| 6 | Semantics -> Route behavior contract | FIX-SRV-001 | TV-SRV-001-P1, TV-SRV-001-N1 |
| 7 | Semantics -> Batch query concurrency; Limits/caps | FIX-SRV-003 | TV-SRV-003-P1, TV-SRV-003-N1 |
| 8 | Semantics -> Query route modularity | FIX-SRV-005 | TV-SRV-005-P1, TV-SRV-005-N1 |
| 9 | Semantics -> Execution perf/safety | FIX-EXE-014 | TV-EXE-014-P1, TV-EXE-014-N1 |
| 10 | Semantics -> Search candidate handling | FIX-EXE-017 | TV-EXE-017-P1, TV-EXE-017-N1 |
| 11 | Internal APIs; Semantics -> change-tracking bulk write path | FIX-EXE-018 | TV-EXE-018-P1, TV-EXE-018-N1 |
| 12 | Invariants -> no hidden full-scan fallback | FIX-EXE-022 | TV-EXE-022-P1, TV-EXE-022-N1 |
| 13 | Observability; Security | FIX-LOG-002 | TV-LOG-002-P1, TV-LOG-002-N1 |

## Completeness Statement
No missing intent items.

All identified remaining issues from the authoritative audit source and current-code verification are covered by SPEC.md, REQUIREMENTS.md, TEST_VECTORS.md, PLAN.md, and phase files.

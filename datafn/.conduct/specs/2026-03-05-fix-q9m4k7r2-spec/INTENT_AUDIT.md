# INTENT AUDIT

## Intent Inventory

1. Theme switch mutation currently reports success but KV row is absent in DB for namespace.
2. Normal todo mutations must continue working.
3. Regression likely introduced by recent merge fix for regular todos.
4. Earlier implementation used findOne/replace behavior that appeared to work for both paths.
5. Root cause tracing must be grounded in `datafn/.conduct` timeline.
6. `kv.set` uses merge (upsert intent) and server/client semantics must be reconciled.
7. Server merge update-only must not silently succeed on missing rows.
8. Drizzle adapter zero-row update behavior mismatch must be corrected.
9. Fix must apply to both `/datafn/mutation` and `/datafn/push`.
10. Success/applied reporting must reflect actual persistence.
11. Change-tracking must not emit ghost entries for non-persisted merges.
12. Namespace isolation/multi-tenant behavior must remain intact.
13. Deterministic error behavior is required for client handling.
14. Memory-only tests were insufficient; SQL-backed regression coverage is required.
15. Deliverable requested now is a full spec for fixes, not immediate code edits.

## Coverage Mapping

| Intent Item | SPEC.md Coverage | Requirement IDs | Test Vectors |
|---|---|---|---|
| 1 | Overview, Semantics, Invariants | KV-001, OBS-001 | TV-KV-001, TV-KV-002, TV-OBS-001 |
| 2 | Goals, Semantics | MRG-001, MRG-002 | TV-MRG-001, TV-MRG-002 |
| 3 | Overview, Compatibility | MRG-001, MRG-002 | TV-MRG-002, TV-MRG-004 |
| 4 | Overview, Semantics | MRG-001, MRG-003 | TV-MRG-005, TV-MRG-006 |
| 5 | Metadata (input paths), Overview | TST-001 | TV-TST-001, TV-TST-002 |
| 6 | Goals, Semantics | KV-001, MRG-001 | TV-KV-001, TV-MRG-003 |
| 7 | Invariants, Semantics | ADP-001, OBS-001 | TV-ADP-002, TV-OBS-002 |
| 8 | Semantics (adapter contract) | ADP-001 | TV-ADP-001, TV-ADP-002 |
| 9 | Goals, Semantics | MRG-001 | TV-MRG-001, TV-MRG-002 |
| 10 | Invariants, Observability | OBS-001 | TV-OBS-001, TV-OBS-002 |
| 11 | Semantics, Invariants | OBS-001 | TV-OBS-002 |
| 12 | Security, Invariants | ADP-001, MRG-001 | TV-ADP-001, TV-MRG-001 |
| 13 | Error Mapping section in requirements and semantics | ERR-001 | TV-ERR-001, TV-ERR-002 |
| 14 | Plan + Phase 02 + Requirements | TST-001 | TV-TST-001, TV-TST-002 |
| 15 | Entire spec bundle outputs | All | All |

## Corrective Check

All intent items map to SPEC sections, requirements, and test vectors. No intent gaps remain.

## Final Audit Statement

**No missing intent items.**

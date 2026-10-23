# INTENT AUDIT: datafn Audit Gap Resolution

## Intent Inventory

Extracted from:
- `.conduct/audits/2026-02-11-nucleus-migration-gap-status-audit.md` (primary)
- `.conduct/intent/datafn.intent.md`
- `.conduct/intent/implementation.md`
- `.conduct/intent/migration-plan-from-nucleus.md`

### Open Gaps from 2026-02-11 Audit

| # | Intent Item | Source |
|---|-------------|--------|
| 1 | Fix pre-existing client test failures (14 failures) | Audit §Test Failure Status |
| 2 | Fix pre-existing server test failures (19 failures) | Audit §Test Failure Status |
| 3 | Event bus error isolation (handler throw breaks delivery) | Audit GAP-27 |
| 4 | Signal memory leak fix (dispose, lifecycle management) | Audit GAP-28 |
| 5 | Client destroy method (teardown all resources) | Audit GAP-10 |
| 6 | Client clear method (wipe data, keep client usable) | Audit GAP-10 |
| 7 | Debounced mutations (per-record-key coalescing) | Audit GAP-05 |
| 8 | KV debounced persistence (delay frequent KV writes) | Audit NEW-01 |
| 9 | KV seed data (getOrSeed for first-run defaults) | Audit NEW-02 |
| 10 | Silent mutations flag (suppress events for internal ops) | Audit NEW-04 |
| 11 | System mutation flag (propagate in event payload) | Audit NEW-03 |
| 12 | WebSocket reconnection with exponential backoff | Audit GAP-17 |
| 13 | Push retry exponential backoff | Audit GAP-18 |
| 14 | Fine-grained signal invalidation (per-record/field) | Audit GAP-12 (PARTIAL) |
| 15 | Optimistic signal updates (back-propagation) | Audit GAP-14 |
| 16 | Batch offline fallback (iterate per mutation) | Audit GAP-19 |
| 17 | Atomic offline merge (single IDB transaction) | Audit GAP-21 |
| 18 | Deep merge for offline (one-level nested objects) | Audit GAP-31 |
| 19 | Configurable pull batch size | Audit GAP-24 (PARTIAL) |
| 20 | AbortSignal support for queries | Audit GAP-26 |
| 21 | Data export (client.exportData) | Audit GAP-16 |
| 22 | Data import (client.importData) | Audit GAP-16 |
| 23 | Soft-delete plugin (delete → merge conversion) | Audit GAP-13 |
| 24 | Self-healing persistence (health check + recovery) | Audit GAP-33 |
| 25 | Bulk mutation fallback (individual retry on batch fail) | Audit NEW-05 |
| 26 | Cross-tab coordination (BroadcastChannel relay) | Audit NEW-06 |
| 27 | Client-side search indexing (offline search) | Audit GAP-22 |
| 28 | Mutation audit trail enrichment (userId, timestamp) | Audit GAP-32 |
| 29 | IDB migration reliability (two-phase approach) | Audit GAP-37 |

### Intent from Core Documents

| # | Intent Item | Source |
|---|-------------|--------|
| 30 | Optimistic UI + reactive updates | datafn.intent.md §Problem |
| 31 | Offline sync as first-class concern | datafn.intent.md §Problem |
| 32 | Extension delegation abstraction | datafn.intent.md §Usage |
| 33 | Plugin lifecycle hooks | datafn.intent.md §Plugins |
| 34 | Migration from Nucleus Flux without regressions | migration-plan-from-nucleus.md §Goal |

---

## Coverage Matrix

| # | Intent Item | SPEC.md Section | Requirement IDs | Test Vector IDs | Status |
|---|-------------|-----------------|-----------------|-----------------|--------|
| 1 | Fix client test failures | Overview | TEST-001 | TV-TEST-001, TV-TEST-001N | COVERED |
| 2 | Fix server test failures | Overview | TEST-002 | TV-TEST-002, TV-TEST-002N | COVERED |
| 3 | Event bus error isolation | §1 | BUS-001 | TV-BUS-001, TV-BUS-001N | COVERED |
| 4 | Signal memory leak fix | §2 | SIG-001 | TV-SIG-001, TV-SIG-001N | COVERED |
| 5 | Client destroy | §3 | CLN-001 | TV-CLN-001, TV-CLN-001N | COVERED |
| 6 | Client clear | §3 | CLN-002 | TV-CLN-002, TV-CLN-002N | COVERED |
| 7 | Debounced mutations | §4 | DEB-001 | TV-DEB-001, TV-DEB-001N | COVERED |
| 8 | KV debounced persistence | §5 | DEB-002 | TV-DEB-002, TV-DEB-002N | COVERED |
| 9 | KV seed data | §5 | KV-001 | TV-KV-001, TV-KV-001N | COVERED |
| 10 | Silent mutations flag | §6 | MUT-001 | TV-MUT-001, TV-MUT-001N | COVERED |
| 11 | System mutation flag | §6 | MUT-002 | TV-MUT-002, TV-MUT-002N | COVERED |
| 12 | WebSocket reconnection | §7 | WS-001 | TV-WS-001, TV-WS-001N | COVERED |
| 13 | Push retry backoff | §8 | RET-001 | TV-RET-001, TV-RET-001N | COVERED |
| 14 | Fine-grained invalidation | §9 | SIG-002 | TV-SIG-002, TV-SIG-002N | COVERED |
| 15 | Optimistic signal updates | §10 | SIG-003 | TV-SIG-003, TV-SIG-003N | COVERED |
| 16 | Batch offline fallback | §11 | OFF-001 | TV-OFF-001, TV-OFF-001N | COVERED |
| 17 | Atomic offline merge | §11 | OFF-002 | TV-OFF-002, TV-OFF-002N | COVERED |
| 18 | Deep merge offline | §11 | OFF-003 | TV-OFF-003, TV-OFF-003N | COVERED |
| 19 | Configurable pull batch size | §12 | CFG-001 | TV-CFG-001, TV-CFG-001N | COVERED |
| 20 | AbortSignal support | §12 | QRY-001 | TV-QRY-001, TV-QRY-001N | COVERED |
| 21 | Data export | §13 | EXP-001 | TV-EXP-001, TV-EXP-001N | COVERED |
| 22 | Data import | §13 | EXP-002 | TV-EXP-002, TV-EXP-002N | COVERED |
| 23 | Soft-delete plugin | §14 | SD-001 | TV-SD-001, TV-SD-001N | COVERED |
| 24 | Self-healing persistence | §15 | HEAL-001 | TV-HEAL-001, TV-HEAL-001N | COVERED |
| 25 | Bulk mutation fallback | §16 | BULK-001 | TV-BULK-001, TV-BULK-001N | COVERED |
| 26 | Cross-tab coordination | §17 | TAB-001 | TV-TAB-001, TV-TAB-001N | COVERED |
| 27 | Client-side search indexing | §18 | SRCH-001 | TV-SRCH-001, TV-SRCH-001N | COVERED |
| 28 | Mutation audit trail | §19 | AUD-001 | TV-AUD-001, TV-AUD-001N | COVERED |
| 29 | IDB migration reliability | §19 | IDB-001 | TV-IDB-001, TV-IDB-001N | COVERED |
| 30 | Optimistic UI + reactive updates | §4 (debounce), §10 (back-prop) | DEB-001, SIG-003 | TV-DEB-001, TV-SIG-003 | COVERED |
| 31 | Offline sync as first-class | §11 (offline improvements) | OFF-001/002/003 | TV-OFF-001/002/003 | COVERED |
| 32 | Extension delegation | §15 (system flag), Invariants | MUT-002 | TV-MUT-002 | PARTIALLY COVERED (extension deep integration is by-design partial; system flag helps) |
| 33 | Plugin lifecycle hooks | §14 (soft-delete), §18 (search) | SD-001, SRCH-001 | TV-SD-001, TV-SRCH-001 | COVERED |
| 34 | Migration from Nucleus without regressions | All sections | All requirements | All test vectors | COVERED (this entire spec serves the migration goal) |

---

## Missing Items

**No missing intent items.** All 29 audit gap items and 5 core intent items are mapped to spec sections, requirements, and test vectors.

### Explicitly Out of Scope (by design, not missing)
- GAP-03/04 (ResourceStore/ActiveResourceStore): By-design decision — Nucleus builds own wrappers
- Extension orchestration (Host/Client pair): Nucleus-specific, not datafn core
- Server namespace hard-coded fallback: Tracked in prior spec `2026-02-06-audit-fix-k4m2p9x7-spec`
- Server relation-level authz: Noted as partial, separate spec recommended
- GAP-36 (Hydration state atomicity): Low priority, addressed implicitly by state machine improvements

### Notes
- Intent item 32 (extension delegation) is only partially covered by this spec. The extension transport and subscription manager already exist (resolved in prior spec). The remaining gap (Host/Client orchestration pair) is a Nucleus-specific concern documented in the migration plan, not a datafn core issue. The `system: true` mutation flag (MUT-002) provides the hook that extension-aware code needs to distinguish system-initiated vs user-initiated mutations.
- The audit identified GAP-15 (Extension Deep Integration) as PARTIAL, but further extension orchestration is explicitly not in scope for this spec per the intent document's directive that "Nucleus adoption without Flux-style wrapper stores" implies extension orchestration lives in Nucleus.

---

**Final statement**: No missing intent items. All audit gaps are covered by SPEC, REQUIREMENTS, TEST_VECTORS, and PLAN with full phase decomposition.

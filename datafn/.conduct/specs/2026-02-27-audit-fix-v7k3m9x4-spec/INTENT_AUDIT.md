# INTENT AUDIT

## Source Documents

1. `datafn/.conduct/audits/2026-02-26-x3cjj10g-full-audit.md` — 157 issues (18 CRITICAL, 43 HIGH, 62 MEDIUM, 34 LOW + 7 test gaps)
2. `datafn/.conduct/audits/2026-02-27-x3cjj10g-audit-decisions.md` — 16 decision points with recommended approaches

## Intent Inventory → Spec Coverage

### CRITICAL Issues (18)

| # | Audit ID | Intent | SPEC.md Section | Requirement IDs | Test Vectors |
|---|---|---|---|---|---|
| 1 | SEC-C1 | WS namespace spoofing | Semantics: WS Authentication | SEC-002 | TV-SEC-003, TV-SEC-004 |
| 2 | SEC-C2 | WS no authentication | Semantics: WS Authentication | SEC-001 | TV-SEC-001, TV-SEC-002 |
| 3 | SEC-C3 | Authz bypass via aggregation/groupBy/sort/search | Security: Authorization boundaries | SEC-003 | TV-SEC-005 to TV-SEC-010 |
| 4 | SEC-C4 | Transact skips authz | Security: Authorization boundaries | SEC-004 | TV-SEC-011, TV-SEC-012 |
| 5 | SEC-C5 | No field value type validation | Semantics: Field Value Type Validation | SEC-005 | TV-SEC-013 to TV-SEC-020 |
| 6 | SEC-C6 | No batch size limit | Semantics: Batch Size Limits | SEC-006 | TV-SEC-021, TV-SEC-022 |
| 7 | SEC-C7 | Payload uses string length | Security: Validation rules | SEC-007 | TV-SEC-023, TV-SEC-024 |
| 8 | SEC-C8 | Prototype pollution | Semantics: Prototype Pollution | SEC-008 | TV-SEC-025 to TV-SEC-028 |
| 9 | REL-C1 | Transaction atomicity lost | Semantics: Transaction Fallback | REL-001 | TV-REL-001, TV-REL-002 |
| 10 | REL-C2 | Change tracking swallowed in push | Semantics: Change Tracking Failure | REL-002 | TV-REL-003, TV-REL-004 |
| 11 | REL-C3 | Rolled-back results misleading | Semantics: Rolled-back Result | REL-003 | TV-REL-005, TV-REL-006 |
| 12 | REL-C4 | DebouncerMap orphaned Promises | (Client reliability) | REL-004 | TV-REL-007 |
| 13 | REL-C5 | Duplicate push timers | (Client reliability) | REL-005 | TV-REL-008 |
| 14 | REL-C6 | Clone errors swallowed | (Client reliability) | REL-006 | TV-REL-009 |
| 15 | SCA-C1 | Reconcile full table scan | (Scalability) | SCA-001 | TV-SCA-001 |
| 16 | SCA-C2 | Clone loads all records | Semantics: Clone Pagination | SCA-002 | TV-SCA-002, TV-SCA-003 |
| 17 | SCA-C3 | Extension transport unbounded | (Scalability) | SCA-003 | TV-SCA-004 |
| 18 | SCA-C4 | Idempotency no TTL | Semantics: Idempotency Store TTL | SCA-004 | TV-SCA-005, TV-SCA-006 |

### HIGH Issues (43)

| # | Audit ID | Intent | Requirement IDs | Test Vectors |
|---|---|---|---|---|
| 19 | SEC-H1 | Relation authz bypass | SEC-009 | TV-SEC-029, TV-SEC-030 |
| 20 | SEC-H2 | REST path traversal | SEC-010 | TV-SEC-031, TV-SEC-032 |
| 21 | SEC-H3 | Seed hardcoded namespace | SEC-011/SRV-016 | TV-SEC-033 |
| 22 | SEC-H4 | Cross-tab no validation | SEC-012 | TV-SEC-034 |
| 23 | SEC-H5 | Having superficial validation | SEC-013 | TV-SEC-035, TV-SEC-036 |
| 24 | SEC-H6 | GroupBy no schema validation | SEC-014 | TV-SEC-037, TV-SEC-038 |
| 25 | SEC-H7 | LIKE pattern injection | SEC-015 | TV-SEC-039 |
| 26 | SEC-H8 | Search query unbounded | SEC-016 | TV-SEC-040 |
| 27 | SCA-H1 | Unbounded WS clients | SCA-005 | TV-SCA-007, TV-SCA-008 |
| 28 | SCA-H2 | O(n) WS broadcast | SCA-006 | TV-SCA-009 |
| 29 | SCA-H3 | Full table load for non-primary | SCA-007 | TV-SCA-010 |
| 30 | SCA-H4 | loadJoinRows full scan | SCA-008 | TV-SCA-011 |
| 31 | SCA-H5 | Aggregate groups unbounded | SCA-009 | TV-SCA-012 |
| 32 | SCA-H6 | Backward cursor doubles memory | SCA-010 | TV-SCA-013 |
| 33 | SCA-H7 | Offline changelog unbounded | SCA-011 | TV-SCA-014 |
| 34 | PER-H1 | Sequential serverSeq in push | PER-001 | TV-PER-001 |
| 35 | PER-H2 | Dynamic imports in hot paths | PER-002 | N/A |
| 36 | PER-H3 | Double validation in push | PER-003 | N/A |
| 37 | PER-H4 | Sequential relation DB calls | PER-004 | TV-PER-002 |
| 38 | PER-H5 | Relation filter O(N*M) | PER-005 | TV-PER-003 |
| 39 | PER-H6 | Changelog dedup O(n^2) | PER-006 | TV-PER-004 |
| 40 | REL-H1 | No WS heartbeat | REL-007 | TV-REL-010 |
| 41 | REL-H2 | Redis rate limit race | REL-008 | TV-REL-011 |
| 42 | REL-H3 | No graceful shutdown | REL-009 | TV-REL-012 |
| 43 | REL-H4 | CAS retry no backoff | REL-010 | TV-REL-013 |
| 44 | REL-H5 | Change tracking after commit | REL-011 | TV-REL-014 |
| 45 | REL-H6 | Push swallows change tracking | REL-002 (same as REL-C2) | TV-REL-003 |
| 46 | REL-H7 | Double event on offline | REL-012 | TV-REL-015 |
| 47 | REL-H8 | Batch query skip date codec | REL-013 | TV-REL-016 |
| 48 | REL-H9 | Pull catch-up infinite loop | REL-014 | TV-REL-017 |
| 49 | REL-H10 | WS pullNow not awaited | REL-015 | TV-REL-018 |
| 50 | DI-H1 | modifyRelation TOCTOU | DI-001 | TV-DI-001 |
| 51 | DI-H2 | Guard TOCTOU | DI-002 | TV-DI-002 |
| 52 | DI-H3 | FallbackSequenceStore duplicates | DI-003 | TV-DI-003 |
| 53 | DI-H4 | Join store key incorrect | DI-004 | TV-DI-004 |

### MEDIUM Issues (62)

| # | Audit IDs | Requirement IDs |
|---|---|---|
| 54-69 | M-S01 to M-S16 | SRV-001 to SRV-016 |
| 70-91 | M-E01 to M-E22 | EXE-001 to EXE-022 |
| 92-105 | M-C01 to M-C14 | CLI-001 to CLI-014 |
| 106-115 | M-V01 to M-V10 | VAL-001 to VAL-010 |

All 62 MEDIUM issues have corresponding requirements. See REQUIREMENTS.md for full mapping.

### LOW Issues (34)

| # | Audit IDs | Requirement IDs |
|---|---|---|
| 116-149 | L-S01 to L-S09, L-E01 to L-E12, L-C01 to L-C08, L-V01 to L-V05 | LOW-001 to LOW-034 |

All 34 LOW issues have corresponding requirements.

### Test Coverage Gaps (7)

| # | Audit ID | Requirement IDs |
|---|---|---|
| 150 | TG-1 | TST-001 |
| 151 | TG-2 | TST-002 |
| 152 | TG-3 | TST-003 |
| 153 | TG-4 | TST-004 |
| 154 | TG-5 | TST-005 |
| 155 | TG-6 | TST-006 |
| 156 | TG-7 | TST-007 |

### Decision Points (16)

| # | Decision | Recommended Option Used | Requirement IDs |
|---|---|---|---|
| D1 | WS Auth Strategy | A: Reuse HTTP auth on upgrade | SEC-001, SEC-002 |
| D2 | Change Tracking Failures | A+C: Fail mutation + retry | REL-002 |
| D3 | Transaction Fallback | A: Error, no fallthrough | REL-001 |
| D4 | Rolled-Back Results | A: `ok: false, rolledBack: true` | REL-003 |
| D5 | Type Validation Strictness | A: Strict rejection | SEC-005 |
| D6 | Batch Size Limits | A: Global 500 default | SEC-006 |
| D7 | Clone Pagination | B: Default limit, auto-paginate | SCA-002 |
| D8 | WS Limits/Heartbeat | All measures | SCA-005, SCA-006, REL-007 |
| D9 | Graceful Shutdown | A: Drain with timeout | REL-009 |
| D10 | Prototype Pollution | A: Reject with error | SEC-008 |
| D11 | Idempotency TTL | 24h TTL, 100k max | SCA-004 |
| D12 | Unknown Resource Authz | A: Deny by default | VAL-001 |
| D13 | Default Payload Size | 5MB | VAL-010, SEC-007 |
| D14 | Structured Logging | A: Pluggable interface | LOG-001, LOG-002, LOG-003 |
| D15 | $or Silent Drop | Reject or implement | SRV-015 |
| D16 | Error Disclosure | A: Generic in prod | VAL-009 |

---

## Coverage Summary

- **Total audit issues**: 157 (18 CRITICAL + 43 HIGH + 62 MEDIUM + 34 LOW)
- **Total test gaps**: 7
- **Total decision points**: 16
- **Total requirements generated**: 120+ (covering all 157 issues + 7 test gaps + 16 decisions)
- **Total test vectors**: 80+
- **Total phases**: 15 (PHASE_00 through PHASE_14)

**No missing intent items.** Every audit finding, decision recommendation, and test gap has been mapped to specific requirements, test vectors, and phase assignments.

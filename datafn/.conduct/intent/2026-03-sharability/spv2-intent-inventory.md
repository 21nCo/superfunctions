# SPV2 Intent Inventory (Phase 00)

Date: 2026-03-13
Purpose: Consolidate and freeze all authoritative sharing intent items before implementation.
Authoritative sources:
1. `2025-03-12-datafn-sharing-scenarios.md`
2. `2026-03-11-datafn-sharing-permissions-sufficiency-report.md`
3. `2026-03-11-datafn-sharing-analysis-t1.md`
4. `2026-03-11-datafn-sharing-recommendations-beginner-guide.md`
5. `visibility-column-ideation.md`
6. Spec bundle: `2026-03-13-new-bhszlzcn-spec` (SPEC/REQUIREMENTS/TEST_VECTORS/INTENT_AUDIT)

## Inventory (Locked)

| # | Intent item | Requirement references |
|---|---|---|
| 1 | Cross-namespace sharing must be supported explicitly (current hard namespace partition is insufficient). | ARCH-002, API-003 |
| 2 | Option analysis must be complete (A/B/C) and final architecture must pick one canonical model. | ARCH-002, ARCH-004 |
| 3 | Option B global permissions with namespace as data field is the chosen long-term model. | ARCH-002 |
| 4 | Query model must explicitly separate default namespace mode and shared-with-me mode. | ARCH-004, API-003 |
| 5 | Visibility must not include a fourth `cross-shared` state. | ARCH-004 |
| 6 | Cross-namespace restrictions must be share-policy checks, not visibility-state branching. | API-002, COMP-002 |
| 7 | Sharing is per-resource capability/configuration, not ad-hoc plugin behavior. | ARCH-001 |
| 8 | Visibility is system-managed and user writes must be rejected. | ARCH-003 |
| 9 | Visibility is optimization, not source-of-truth for authorization. | ARCH-003, AUTH-005 |
| 10 | Scope-level sharing (`resourceId = null`) is required. | API-002 |
| 11 | Scope-level sharing must support indefinite sharing patterns (e.g., cycle data). | API-002, USE-001 |
| 12 | Principal model must include user/team/group/project/org/workspace patterns. | ARCH-005, USE-001 |
| 13 | Principal model must not rely on fixed enum semantics for evolution. | ARCH-005 |
| 14 | DataFn must treat principal IDs as opaque strings. | ARCH-005 |
| 15 | Membership graph is required for actor-to-principal resolution. | ARCH-006, SYNC-004 |
| 16 | Hierarchy resolution with cache is required. | ARCH-006 |
| 17 | Flattened membership write amplification must be avoided. | ARCH-006 |
| 18 | Relation inheritance is required for parent-proxy sharing semantics. | REL-001 |
| 19 | Relate operations in shared parents require permission checks. | REL-002, AUTH-005 |
| 20 | Consent semantics are required for auto-share side effects in relation inheritance flows. | REL-002 |
| 21 | Namespace remains isolation/colocation primitive, not membership system. | ARCH-004, USE-001 |
| 22 | Collections/shared memories scenario must be natively supported. | USE-001 |
| 23 | Sharing ideas/inspiration/quotes scenario must be natively supported. | USE-001 |
| 24 | Memotron note/markdown/bookmark sharing scenario must be natively supported. | USE-001, API-001 |
| 25 | Shared space with mixed private records in same namespace must be supported. | ARCH-003, USE-001 |
| 26 | Selftron menstrual-cycle sharing must support high-sensitivity scope patterns. | API-002, USE-001, SEC-001 |
| 27 | Shared habits/activity tracking must support relation inheritance. | REL-001, USE-001 |
| 28 | Pointron group focus/objectives/events must support principal and shared models. | USE-001, ARCH-005 |
| 29 | Finatron shared accounts/household/splitwise patterns must support secure selective sharing. | USE-001, SEC-001 |
| 30 | Feedtron shared listening/audience segmentation must be supported. | USE-001, ARCH-005 |
| 31 | Compoundum org/project/team/individual hierarchy use cases must be supported. | USE-001, ARCH-006 |
| 32 | System must support private + restricted + org/project-wide resources in one model. | ARCH-003, API-002, USE-001 |
| 33 | Production readiness (security and correctness) is mandatory before declaring sufficiency. | TEST-001, SEC-001 |
| 34 | Push ACL bypass gap must be fixed. | AUTH-002 |
| 35 | Transact actor-context drift gap must be fixed. | AUTH-001, AUTH-003 |
| 36 | Clone/pull actor-filtering gap must be fixed. | AUTH-004 |
| 37 | Relation expansion leak gap must be fixed. | AUTH-005 |
| 38 | ownerField ambiguity must be resolved via runtime enforcement in this spec. | AUTH-006 |
| 39 | Python parity with TS behavior is required for production equivalence. | PY-001 |
| 40 | Performance/latency under ACL-heavy scale must be addressed. | PERF-001, PERF-002 |
| 41 | Pull assembly must avoid unbounded flatten+sort memory growth. | PERF-002 |
| 42 | WS invalidation should reduce unnecessary pull wakeups via actor/principal targeting where possible. | PERF-003 |
| 43 | Offline sync invariants (cursor monotonicity/idempotency/deterministic ordering) must remain intact. | SYNC-003 |
| 44 | Revokes/deletes must propagate safely offline and remove stale data. | SYNC-001 |
| 45 | Grant gain/backfill behavior for newly visible historical data must be explicit. | SYNC-002 |
| 46 | Conformance tests must gate release. | TEST-001 |
| 47 | Recommendations/docs must be beginner-friendly and avoid unexplained abbreviations. | DOC-001 |
| 48 | Docs must explain clone/pull/push and shared-resource revoke flows clearly. | DOC-001, SYNC-001, SYNC-002 |
| 49 | Migration and compatibility strategy from current model to SPV2 must be explicit. | COMP-001, COMP-002 |
| 50 | Final architectural direction is capability-native implementation with optional extension points, not plugin-only enforcement. | ARCH-001 |

## Cross-check Summary
1. Total inventory items: 50
2. Requirement IDs referenced: 16 unique IDs
3. Requirement reference gaps: none detected
4. Source-intent gaps: none detected

## Lock Statement
This inventory is phase-0 locked and is the baseline checklist for execution phases.

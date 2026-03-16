# Intent Audit

## Source Material Audited
1. `/Users/serro/Documents/dev/n/superfunctions/datafn/.conduct/intent/2026-03-sharability/2025-03-12-datafn-sharing-scenarios.md`
2. `/Users/serro/Documents/dev/n/superfunctions/datafn/.conduct/intent/2026-03-sharability/2026-03-11-datafn-sharing-permissions-sufficiency-report.md`
3. User thread directives in this conversation (capability-vs-plugin decision and full lifecycle requirement).

## Intent Inventory
1. Namespace isolation currently blocks cross-namespace sharing and needs explicit model.
2. Evaluate Option A/B/C for cross-namespace sharing.
3. Final architecture should favor Option B global permissions with `resourceNs`.
4. Query model must support normal namespace queries and shared-with-me queries.
5. Visibility should remain tri-state (`null/private/shared`) and not add `cross-shared`.
6. Cross-namespace restrictions should be enforced at share-time policy (`crossNsShareable`).
7. Sharing should be per-resource capability/configuration.
8. Visibility should be system-managed and optimized for query paths.
9. Visibility should not become source-of-truth for authz.
10. Scope-level sharing should be supported (`resourceId = null`).
11. Scope-level sharing must support indefinite/bulk sharing (e.g., cycle data).
12. Principals must support users, groups, teams, orgs, projects, roles.
13. Principal types should not be fixed enum; opaque ID model is preferred.
14. DataFn should treat principal IDs as opaque strings.
15. Membership graph is needed for principal resolution.
16. Hierarchy should be resolved from hierarchy table and cached.
17. Flattened membership write amplification should be avoided.
18. Relation inheritance should allow parent share to grant linked child visibility.
19. Relate operations into shared parent need permission checks.
20. Consent for auto-share side effects on relate should exist.
21. Namespace should stay colocation/isolation primitive, not membership model.
22. Collections shared memories use case must work.
23. Ideas/inspiration/quotes sharing use case must work.
24. Memotron per-note sharing must work.
25. Shared space with private records within same namespace must work.
26. Selftron menstrual cycle sharing (scope-level) must work.
27. Shared habits/activity tracking with relation inheritance must work.
28. Pointron group focus/objectives/events must work.
29. Finatron shared accounts/household expenses/splitwise style must work.
30. Feedtron shared listening must work.
31. Compoundum org/project/team/individual hierarchy must work.
32. Private/restricted/org-wide resource mix must work in same system.
33. Production readiness and high-confidence security is required.
34. Push ACL bypass must be fixed.
35. Transact actor context gap must be fixed.
36. Clone/pull actor filtering gap must be fixed.
37. Relation expansion leak risk must be fixed.
38. ownerField ambiguity must be resolved.
39. Python parity must be achieved.
40. Performance/latency must be considered at scale.
41. Pull scaling should avoid unbounded flatten/sort.
42. WS invalidation should reduce unnecessary pull amplification.
43. Offline sync invariants must hold with sharing changes.
44. Revokes/deletes must propagate safely offline.
45. Grant/backfill behavior for newly visible records must be defined.
46. Conformance tests must gate release.
47. Beginner-friendly documentation with examples is required.
48. Documentation must explain offline push/pull/revoke for shared resources.
49. Migration/versioning strategy from current model must be explicit.
50. Final architecture decision: deliver as capability with extension points, not standalone plugin.

## Coverage Mapping
| Intent # | Covered in SPEC.md | Requirement IDs | Test vectors |
|---|---|---|---|
| 1 | Overview; Semantics; Public API | ARCH-002, API-003 | TV-ARCH-002-P, TV-API-003-P |
| 2 | Overview; Semantics | ARCH-002, ARCH-004 | TV-ARCH-002-P, TV-ARCH-004-P |
| 3 | Public API; Data formats / protocol | ARCH-002 | TV-ARCH-002-P, TV-ARCH-002-N |
| 4 | Public API; Semantics (Query semantics) | ARCH-004, API-003 | TV-ARCH-004-P, TV-API-003-P |
| 5 | Semantics (Query semantics); Invariants | ARCH-003, ARCH-004 | TV-ARCH-003-P, TV-ARCH-004-N |
| 6 | Public API; Semantics (Mutation semantics) | API-002, COMP-002 | TV-API-002-N, TV-COMP-002-P |
| 7 | Public API (Capability configuration) | ARCH-001, ARCH-003 | TV-ARCH-001-P, TV-ARCH-003-P |
| 8 | Data formats / protocol; Semantics | ARCH-003 | TV-ARCH-003-P, TV-ARCH-003-N |
| 9 | Semantics (Query semantics); Security | ARCH-003, AUTH-005 | TV-ARCH-003-P, TV-AUTH-005-N |
| 10 | Data formats / protocol; Semantics (Mutation semantics) | API-002 | TV-API-002-P, TV-API-002-N |
| 11 | Semantics (Mutation semantics) | API-002, USE-001 | TV-API-002-P, TV-USE-001-P |
| 12 | Overview; Public API | ARCH-005, API-001 | TV-ARCH-005-P, TV-API-001-P |
| 13 | Public API; Glossary | ARCH-005 | TV-ARCH-005-P, TV-ARCH-005-N |
| 14 | Security; Semantics | ARCH-005 | TV-ARCH-005-P, TV-ARCH-005-N |
| 15 | Data formats / protocol | ARCH-006, SYNC-004 | TV-ARCH-006-P, TV-SYNC-004-P |
| 16 | Semantics (Access resolution algorithm) | ARCH-006 | TV-ARCH-006-P, TV-ARCH-006-N |
| 17 | Semantics; Invariants | ARCH-006, PERF-001 | TV-ARCH-006-P, TV-PERF-001-P |
| 18 | Semantics (Relation inheritance semantics) | REL-001 | TV-REL-001-P, TV-REL-001-N |
| 19 | Semantics (Relation inheritance semantics) | REL-002, AUTH-005 | TV-REL-002-P, TV-AUTH-005-P |
| 20 | Semantics (Relation inheritance semantics) | REL-002 | TV-REL-002-P, TV-REL-002-N |
| 21 | Glossary; Semantics | ARCH-004, USE-001 | TV-ARCH-004-P, TV-USE-001-P |
| 22 | Goals; Semantics; Docs scope | USE-001, DOC-001 | TV-USE-001-P, TV-DOC-001-P |
| 23 | Goals; Semantics; Docs scope | USE-001, DOC-001 | TV-USE-001-P, TV-DOC-001-P |
| 24 | Goals; Semantics; API | USE-001, API-001 | TV-USE-001-P, TV-API-001-P |
| 25 | Semantics (visibility + access) | ARCH-003, USE-001 | TV-ARCH-003-P, TV-USE-001-P |
| 26 | API; Semantics | API-002, USE-001 | TV-API-002-P, TV-USE-001-P |
| 27 | Semantics (Relation inheritance) | REL-001, USE-001 | TV-REL-001-P, TV-USE-001-P |
| 28 | Semantics; Access algorithm | REL-001, USE-001 | TV-REL-001-P, TV-USE-001-P |
| 29 | Semantics; Security | REL-001, USE-001, SEC-001 | TV-REL-001-P, TV-SEC-001-P |
| 30 | Semantics; Use-case coverage | USE-001 | TV-USE-001-P, TV-USE-001-N |
| 31 | Overview; Semantics | ARCH-006, USE-001 | TV-ARCH-006-P, TV-USE-001-P |
| 32 | Semantics (visibility/access model) | ARCH-003, API-002, USE-001 | TV-ARCH-003-P, TV-API-002-P |
| 33 | Goals; Security; Test gate | SEC-001, TEST-001 | TV-SEC-001-P, TV-TEST-001-P |
| 34 | Semantics (Sync semantics); Security | AUTH-002 | TV-AUTH-002-P, TV-AUTH-002-N |
| 35 | Semantics (Sync semantics); Invariants | AUTH-001, AUTH-003 | TV-AUTH-001-P, TV-AUTH-003-N |
| 36 | Semantics (Sync semantics) | AUTH-004 | TV-AUTH-004-P, TV-AUTH-004-N |
| 37 | Security; Semantics (Relation) | AUTH-005 | TV-AUTH-005-P, TV-AUTH-005-N |
| 38 | Semantics (Access algorithm) | AUTH-006 | TV-AUTH-006-P, TV-AUTH-006-N |
| 39 | Compatibility / versioning strategy | PY-001 | TV-PY-001-P, TV-PY-001-N |
| 40 | Performance constraints; Limits/caps | PERF-001, PERF-002 | TV-PERF-001-P, TV-PERF-002-P |
| 41 | Performance constraints; Semantics | PERF-002 | TV-PERF-002-P, TV-PERF-002-N |
| 42 | Performance constraints; Observability | PERF-003 | TV-PERF-003-P, TV-PERF-003-N |
| 43 | Invariants | SYNC-003 | TV-SYNC-003-P, TV-SYNC-003-N |
| 44 | Semantics (Sync semantics); Invariants | SYNC-001 | TV-SYNC-001-P, TV-SYNC-001-N |
| 45 | Semantics (Sync semantics) | SYNC-002 | TV-SYNC-002-P, TV-SYNC-002-N |
| 46 | Requirements + test strategy | TEST-001 | TV-TEST-001-P, TV-TEST-001-N |
| 47 | Goals; Docs section | DOC-001 | TV-DOC-001-P, TV-DOC-001-N |
| 48 | Semantics (Sync semantics); Docs | DOC-001, SYNC-001, SYNC-002 | TV-DOC-001-P, TV-SYNC-001-P |
| 49 | Compatibility / versioning strategy | COMP-001, COMP-002 | TV-COMP-001-P, TV-COMP-002-P |
| 50 | Semantics (Capability and plugin boundary) | ARCH-001 | TV-ARCH-001-P, TV-ARCH-001-N |

## Completeness Result
No missing intent items.

Corrective edits made during audit pass:
1. Added explicit requirement for docs clarity (`DOC-001`) to cover beginner-friendly request.
2. Added explicit requirement for release conformance gating (`TEST-001`).
3. Added explicit capability-vs-plugin boundary requirement (`ARCH-001`).

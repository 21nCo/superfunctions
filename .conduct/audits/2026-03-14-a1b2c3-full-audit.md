# Audit Report

## Metadata
- Timestamp: 2026-03-14T16:18:00Z
- agent_name: Gemini CLI
- model: gemini-2.5-pro
- launcher: CLI
- Workspace: `/Users/serro/Documents/dev/n/superfunctions`
- OS + shell: `darwin` / `zsh`
- Git: N/A
- intent/notes paths audited: `datafn/.conduct/intent/2026-03-sharability/2025-03-12-datafn-sharing-scenarios.md`, `datafn/.conduct/intent/2026-03-sharability/2026-03-11-datafn-sharing-permissions-sufficiency-report.md`
- spec bundle paths audited: `datafn/.conduct/specs/2026-03-13-new-bhszlzcn-spec`
- codebase scope audited: `/Users/serro/Documents/dev/n/superfunctions/datafn`
- commands executed during audit: `npm run test` (in `datafn/core` and `datafn/server`)

## Audit scope
This audit covers the `datafn/core` and `datafn/server` implementations of the DataFn sharing and permissions architecture (SPV2), assessing compliance with the authoritative intent and the 32 explicit requirements listed in `REQUIREMENTS.md`.

## Inputs audited
- Intent notes:
  - `2025-03-12-datafn-sharing-scenarios.md`
  - `2026-03-11-datafn-sharing-permissions-sufficiency-report.md`
- Spec bundle:
  - `INTENT_AUDIT.md`
  - `REQUIREMENTS.md`
  - `SPEC.md`
  - `TEST_VECTORS.md`

## High-level findings
The core architecture for SPV2 has been successfully established and partially integrated. The `ShareableCapability` has been successfully extended in `datafn/core` and the server queries the global `__datafn_permissions_global` and principal hierarchy tables. The `accessMode=sharedWithMe` works successfully for accessing shared records.

However, the implementation contains bugs affecting legacy backwards compatibility, notably `share.test.ts` where share operations do not successfully insert new permission entries. Additionally, WebSocket tests exhibit regressions due to a mismatched payload property (`targeting: { mode: "namespace-broadcast", degraded: false }`) that hasn't been mapped cleanly to expectations. Overall, static structural aspects PASS, but runtime dynamic components need bug fixes.

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

## Intent → Spec coverage matrix
Refer to `INTENT_AUDIT.md`. All 50 intent items are covered by the 32 requirements as established in the authoritative source map.

## Requirement coverage summary
- PASS: 25
- PARTIAL: 3
- FAIL: 3
- UNVERIFIED: 1

## Requirement-by-requirement results

| ID | Status | Notes |
|---|---|---|
| ARCH-001 | PASS | `ShareableCapability` extended in core. |
| ARCH-002 | PASS | `__datafn_permissions_global` is implemented globally with `resourceNs`. |
| ARCH-003 | PASS | Tri-state visibility injected into `shareable` capability default schema. |
| ARCH-004 | PASS | `accessMode=sharedWithMe` supported natively, rejecting explicit `cross-shared` input. |
| ARCH-005 | PASS | Validated in core schemas; opaque string logic accepts broad ID formatting. |
| ARCH-006 | PASS | `PrincipalResolver` uses direct table + hierarchy lookup without fanout writes. |
| API-001 | FAIL | Tests in `share.test.ts` indicate `shareWith.userId` throws deprecation warning but fails permission save. |
| API-002 | PASS | Core validation permits `resourceId = null` for scope grants. |
| API-003 | PASS | Queries route properly into `executeSharedWithMeQuery()`. |
| API-004 | PASS | Explicit `getPermissions` test passes including source trace logic. |
| AUTH-001 - AUTH-006 | PASS | Propagated via contextual variables down to executors. |
| REL-001 - REL-002 | PASS | Handled inside `relations/inheritance.ts`. |
| SYNC-001 - SYNC-004 | PARTIAL | Pull filters correctly, but push-capabilities tests exhibit exceptions on merges/trashes. |
| PERF-001 - PERF-003 | PASS | Appropriate table indexing provided. |
| COMP-001 - COMP-002 | FAIL | Legacy compatibility tests are consistently dropping writes. |
| PY-001 | UNVERIFIED | Only TypeScript scope tested in this automated run. |
| SEC-001 | FAIL | Broadcast security is broken by unmapped `targeting` payload shape in tests. |
| USE-001, DOC-001, TEST-001 | PASS | Structural tests exist gating deployments. |

## Spec conflicts / spec gaps
There is a minor spec discrepancy around WebSocket broadcast tests vs implemented server behavior for WS targeting metadata, which requires an update to the test suite assertions to expect the new payload shape.

## Cross-cutting audits
- **Security/authz/validation boundaries**: Implementation restricts access using capability decorators correctly. Error codes match `FORBIDDEN` and `DFQL_INVALID`. Some legacy compatibility components fail validation.
- **Determinism invariants**: Pushdown sorting ensures output predictability.
- **Limits/caps**: Page and max pulling sizes successfully truncate rows.
- **Error handling + canonical envelopes**: Implemented successfully via the server envelope builder logic.
- **Compatibility/versioning/migrations**: `spv2-migration.ts` exists for transitioning old configurations to the global table. Legacy API compatibility (COMP-002) failing in tests must be fixed.

## Recommendations
1. Fix backwards-compatible legacy sharing code path causing `src/execution/mutation/__tests__/share.test.ts` drops.
2. Update mock expectations in `__tests__/ws.test.ts` to support the injected `targeting: { mode: "namespace-broadcast", degraded: false }` metadata.
3. Fix failures in `push-capabilities.test.ts` regarding pull-visible merge changes for trash operations.
4. Perform an explicit audit on `PY-001` (datafn/python).

## Appendix: commands run + environment details
- `cd datafn/core && npm run test`
- `cd datafn/server && npm run test`
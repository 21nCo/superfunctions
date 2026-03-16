# Intent Audit (Coverage Mapping)

This audit maps every intent/finding from the user-provided audit observations plus repository scan findings to SPEC, REQUIREMENTS, and TEST_VECTORS coverage.

## Intent Inventory

1. Keep OAuth common infrastructure in shared packages (not per-function duplication).
2. Fix duplication in `oauth-testing` memory state/token stores.
3. Replace plugfn thin/memory-leaning OAuth wrapper path with production-ready persistent path.
4. Introduce a shared high-level OAuth flow package for common orchestration.
5. Migrate recfn calendar token storage/refresh from local interfaces to shared OAuth packages.
6. Extract reusable webhook signing/delivery utilities from recfn into shared packages.
7. Extract reusable response envelope helpers into shared packages.
8. Extract reusable error-code-to-HTTP-status mapping into shared packages.
9. Extract reusable queue adapter abstractions from recfn/cifn into shared packages.
10. Extract reusable metrics emitter interface from recfn into shared packages.
11. Extract reusable env/config loader patterns from recfn into shared packages.
12. Extract reusable bearer token auth middleware into shared auth package.
13. Unify rate limiting patterns (sliding window + token bucket) in shared package implementation.
14. Ensure OAuth scope includes redirect handling and webhooks-related reusable concerns where appropriate.
15. Perform thorough duplicate-code scan and capture additional high-value extractions.
16. Resolve envelope drift across recfn/cifn/cmsfn/datafn patterns.
17. Resolve storage adapter duplication clusters (`storage-s3/r2/minio` and related helpers).
18. Resolve search adapter duplication cluster (`searchfn/adapters` vs `searchfn/adapter-*`).
19. Align plugfn persistence typing with `@superfunctions/db` instead of local ad-hoc interface.
20. Validate architecture direction: authfn/plugfn should use `@superfunctions/http` for endpoint exposure.
21. Validate architecture direction: authfn/plugfn persistence should align with `@superfunctions/db` contracts.
22. Improve plugfn deterministic connection selection tie-breaking.
23. Add root shared docs site in monorepo using Fumadocs + shared styling.
24. Root docs must cover all shared packages, not partial subset.
25. Docs must be beginner-friendly with elaborative examples.
26. Docs must explicitly support external library builders, not only superfunction consumers.
27. Exclude authfn comprehensive better-auth-like implementation from this spec.
28. Add release/process guardrails so duplication and migration regressions are blocked.
29. Add migration guides and compatibility shims to avoid abrupt breakage.
30. Keep domain-specific bot/platform/ASR/analytics logic out of shared extraction scope.

## Coverage Mapping

| Intent ID | Intent statement | Covered in SPEC.md | Requirement IDs | Test vectors |
|---|---|---|---|---|
| INT-001 | OAuth common infra in shared packages | Overview, Public API (`@superfunctions/oauth-flow`), Semantics | OAUTH-002, OAUTH-009, OAUTH-011 | TV-OAUTH-002-P, TV-OAUTH-009-P, TV-OAUTH-011-P |
| INT-002 | Fix oauth-testing duplication | Goals, Semantics | OAUTH-001 | TV-OAUTH-001-P, TV-OAUTH-001-N |
| INT-003 | Replace plugfn thin/memory-leaning wrapper with persistent-ready path | Public API, Semantics, Compatibility | OAUTH-008, OAUTH-009, OAUTH-010 | TV-OAUTH-008-P, TV-OAUTH-009-P, TV-OAUTH-010-P |
| INT-004 | Shared high-level OAuth flow | Public API (`@superfunctions/oauth-flow`) | OAUTH-002, OAUTH-003, OAUTH-004, OAUTH-005, OAUTH-006 | TV-OAUTH-002-P, TV-OAUTH-003-P, TV-OAUTH-004-P |
| INT-005 | RecFn OAuth token migration | Goals, Semantics | OAUTH-012 | TV-OAUTH-012-P, TV-OAUTH-012-N |
| INT-006 | Shared webhook signing/delivery extraction | Public API (`@superfunctions/webhooks`) | REUSE-001, REUSE-002 | TV-REUSE-001-P, TV-REUSE-002-P |
| INT-007 | Shared envelope extraction | Data formats/protocol | REUSE-003, REUSE-005 | TV-REUSE-003-P, TV-REUSE-005-P |
| INT-008 | Shared error mapping extraction | Data formats/protocol, Security | REUSE-004, REUSE-005 | TV-REUSE-004-P, TV-REUSE-005-P |
| INT-009 | Shared queue extraction | Public API (`@superfunctions/queue`) | REUSE-006, REUSE-007, DUPL-004 | TV-REUSE-006-P, TV-REUSE-007-P, TV-DUPL-004-P |
| INT-010 | Shared metrics extraction | Public API (`@superfunctions/metrics`) | REUSE-008 | TV-REUSE-008-P, TV-REUSE-008-N |
| INT-011 | Shared config extraction | Public API (`@superfunctions/config`) | REUSE-009 | TV-REUSE-009-P, TV-REUSE-009-N |
| INT-012 | Shared bearer middleware extraction | Public API (`@superfunctions/auth` extension) | REUSE-010 | TV-REUSE-010-P, TV-REUSE-010-N |
| INT-013 | Shared rate-limit algorithm completeness | Public API (rate limit), Limits/caps | REUSE-011, REUSE-012 | TV-REUSE-011-P, TV-REUSE-012-P |
| INT-014 | OAuth scope includes redirect handling and webhook-related reusable concerns | Semantics, Security | OAUTH-003, OAUTH-004, REUSE-001 | TV-OAUTH-003-P, TV-OAUTH-004-N, TV-REUSE-001-P |
| INT-015 | Thorough duplicate scan and extraction capture | Overview, Goals | DUPL-001, DUPL-002, DUPL-003, DUPL-005, OPS-001 | TV-DUPL-001-P, TV-DUPL-003-P, TV-OPS-001-P |
| INT-016 | Resolve envelope drift across functions | Data formats/protocol | REUSE-003, REUSE-005 | TV-REUSE-003-P, TV-REUSE-005-N |
| INT-017 | Resolve storage adapter duplication cluster | Goals, Semantics | DUPL-001, DUPL-002 | TV-DUPL-001-P, TV-DUPL-002-P |
| INT-018 | Resolve search adapter duplication cluster | Goals, Compatibility/versioning | DUPL-003 | TV-DUPL-003-P, TV-DUPL-003-N |
| INT-019 | PlugFn db type contract alignment | Goals, Platform alignment | PLAT-001 | TV-PLAT-001-P, TV-PLAT-001-N |
| INT-020 | Authfn/plugfn use shared HTTP exposure | Goals, Public API, PLAT section | PLAT-002 | TV-PLAT-002-P, TV-PLAT-002-N |
| INT-021 | Authfn/plugfn persistence aligns to shared db contracts | Goals, Platform alignment | OAUTH-008, PLAT-001 | TV-OAUTH-008-P, TV-PLAT-001-P |
| INT-022 | PlugFn deterministic connection selection | Invariants | PLAT-003 | TV-PLAT-003-P, TV-PLAT-003-N |
| INT-023 | Root Fumadocs docs site with shared styling | Public API (docs), Docs goals | DOCS-001 | TV-DOCS-001-P, TV-DOCS-001-N |
| INT-024 | Docs must cover all shared packages | Docs semantics | DOCS-002 | TV-DOCS-002-P, TV-DOCS-002-N |
| INT-025 | Beginner-friendly elaborative docs | Docs semantics | DOCS-003 | TV-DOCS-003-P, TV-DOCS-003-N |
| INT-026 | Docs for external library builders | Context + Docs semantics | DOCS-003, DOCS-005 | TV-DOCS-003-P, TV-DOCS-005-P |
| INT-027 | Exclude authfn comprehensive implementation | Undefined / Explicitly deferred | Non-goal + deferred section, OAUTH-011 Notes | TV-OAUTH-011-P, TV-OAUTH-011-N |
| INT-028 | Add release/process guardrails | Observability + compatibility + ops | OPS-001, OPS-002, OPS-004 | TV-OPS-001-P, TV-OPS-002-P, TV-OPS-004-P |
| INT-029 | Migration guides and compatibility shims | Compatibility/versioning | PLAT-004, DOCS-006, OPS-003 | TV-PLAT-004-P, TV-DOCS-006-P, TV-OPS-003-P |
| INT-030 | Keep domain-specific bot/platform/ASR/analytics logic out of shared extraction | Non-goals | Explicit Non-goals section | TV-DOCS-005-P (architecture boundaries), TV-OPS-002-P (gate checks) |

## Coverage status

No missing intent items.

# ApiFn — Intent Audit

## Source Material

- `apifn/.conduct/intent-v0.md` — Initial intent document from prior conversation
- User message: approach change to use OpenCollection YAML instead of custom `.apifn` files
- User message: reference to Postman, Bruno, Swagger, Scalar as comparable tools
- External links: [OpenCollection Specification](https://spec.opencollection.com/), [Bruno OpenCollection Docs](https://docs.usebruno.com/opencollection-yaml/overview), [OpenCollection.com](https://www.opencollection.com/)

---

## Intent Inventory

### From intent-v0.md

| # | Intent Item | Source |
|---|---|---|
| 1 | OpenAPI 3.1 generation from `@superfunctions/http` route definitions | intent-v0.md, "Core library" |
| 2 | Schema validation (zod/typebox integration for request/response bodies) | intent-v0.md, "Core library" |
| 3 | Collection format — git-native plain files (originally `.apifn`, changed to OpenCollection YAML) | intent-v0.md + user correction |
| 4 | Breaking change detection (`apifn diff`) for CI | intent-v0.md, "Core library" |
| 5 | Environment management (dev/staging/prod variable sets) | intent-v0.md, "Core library" |
| 6 | Interactive API explorer UI (React + Svelte) | intent-v0.md, "UI components" |
| 7 | Try-it console with live watchfn performance overlay | intent-v0.md, "UI components" |
| 8 | Request history and response diffing | intent-v0.md, "UI components" |
| 9 | CLI: `apifn serve` — spin up local API explorer | intent-v0.md, "CLI" |
| 10 | CLI: `apifn test` — run collection against an environment | intent-v0.md, "CLI" |
| 11 | CLI: `apifn diff` — detect breaking changes | intent-v0.md, "CLI" |
| 12 | CLI: `apifn export` — emit OpenAPI YAML for interop | intent-v0.md, "CLI" |
| 13 | docsfn plugin: `<ApiReference />` component | intent-v0.md, "docsfn plugin" |
| 14 | docsfn plugin: embedded try-it console in docs | intent-v0.md, "docsfn plugin" |
| 15 | docsfn plugin: auto-sidebar generation | intent-v0.md, "docsfn plugin" |
| 16 | Python: FastAPI/Flask introspection adapter | intent-v0.md, "Python" |
| 17 | Self-hosted (no cloud, no vendor lock-in) | intent-v0.md, positioning table |
| 18 | Git-native collections | intent-v0.md, positioning table |
| 19 | Schema from code — no separate YAML maintenance | intent-v0.md, "Core Opportunity" |
| 20 | Live perf data per endpoint (watchfn) | intent-v0.md, positioning table |
| 21 | Embedded in docs site (docsfn) | intent-v0.md, positioning table |
| 22 | Breaking change detection in CI | intent-v0.md, positioning table |
| 23 | authfn integration — mint short-lived test tokens | intent-v0.md, "Ecosystem Advantages" |
| 24 | secfn + logfn — rate limit headroom, request log tailing | intent-v0.md, "Ecosystem Advantages" |
| 25 | watchfn integration — pull p50/p95/p99 latency, error rate, request volume | intent-v0.md, "Ecosystem Advantages" |

### From user's current message

| # | Intent Item | Source |
|---|---|---|
| 26 | Document and test APIs (like Postman, Bruno) | User message |
| 27 | Generate docs automatically (docsfn plugin) | User message |
| 28 | Connected to deployed APIs via watchfn for performance monitoring | User message |
| 29 | Use OpenCollection YAML format (NOT custom .apifn files) — Bruno interop | User correction + external links |
| 30 | Similar to Postman, Bruno, Swagger, Scalar in capabilities | User message |

### Derived from ecosystem analysis (implicitly required)

| # | Intent Item | Source |
|---|---|---|
| 31 | Mock server from OpenAPI spec | Standard API tool feature (Postman, Scalar) |
| 32 | Code snippet generation (curl, fetch, Python, etc.) | Standard API tool feature (Scalar, Swagger UI) |
| 33 | CI/CD integration (GitHub Actions) | Implied by "breaking change detection in CI" |
| 34 | testfn adapter for collection running through testfn | Ecosystem integration (testfn exists) |
| 35 | Multi-framework UI (React + Svelte, matching docsfn) | Ecosystem convention |

---

## Coverage Mapping

| Intent # | SPEC Section(s) | Requirements | Test Vectors | Phase(s) |
|---|---|---|---|---|
| 1 | 5.1 (introspectRouter, generateOpenAPI), 7.1, 7.3 | INTRO-001–005, OPENAPI-001–010 | TV-INTRO-*, TV-OPENAPI-* | 02, 04 |
| 2 | 5.1 (SchemaDescriptor), 7.2 | SCHEMA-001–005 | TV-SCHEMA-* | 03 |
| 3 | 5.2, 6.2 (OpenCollection YAML) | COLL-001–007 | TV-COLL-* | 06, 07 |
| 4 | 5.1 (diffOpenAPI), 7.5 | DIFF-001–009 | TV-DIFF-* | 13, 14 |
| 5 | 5.2, 6.3 | ENV-001–005 | TV-ENV-* | 08 |
| 6 | 5.4 (ApiExplorer, EndpointViewer, SchemaViewer) | UI-R-001–009, UI-S-001–009 | TV-UI-R-*, TV-UI-S-* | 18, 19 |
| 7 | 5.4 (TryIt, PerformanceOverlay) | UI-R-004, UI-R-007, UI-S-004, UI-S-007 | TV-UI-R-004, TV-UI-R-007 | 18, 19, 21 |
| 8 | 5.4 (RequestHistory, ResponseDiff) | UI-R-005–006, UI-S-005–006 | TV-UI-R-005–006 | 18, 19 |
| 9 | 5.3 (apifn serve) | CLI-006, SERVE-001–004 | TV-CLI-006, TV-SERVE-* | 17 |
| 10 | 5.3 (apifn test), 5.2 (runCollection) | CLI-004, RUN-001–011 | TV-CLI-004, TV-RUN-* | 10, 11, 12 |
| 11 | 5.3 (apifn diff) | CLI-005, CI-002 | TV-CLI-005 | 14 |
| 12 | 5.3 (apifn export) | CLI-003 | TV-CLI-003 | 09 |
| 13 | 5.5 (ApifnApiReference) | DOCS-002, DOCS-003 | TV-DOCS-002, TV-DOCS-003 | 20 |
| 14 | 5.5 (tryIt option) | DOCS-005 | TV-DOCS-005 | 20 |
| 15 | 5.5 (auto-sidebar) | DOCS-004 | TV-DOCS-004 | 20 |
| 16 | 5.9 (Python adapters) | PY-001–005 | TV-PY-* | 24 |
| 17 | 3 (Goals: self-hosted), 4 (Non-goals: not hosted SaaS) | — (architectural) | — | All |
| 18 | 6.2 (OpenCollection YAML, git-native) | COLL-001–007 | TV-COLL-* | 06, 07 |
| 19 | 1 (Overview), 3 (Goals: zero-drift), 7.1 (introspection rules) | INTRO-001–005, OPENAPI-001–010 | TV-INTRO-*, TV-OPENAPI-* | 02, 04 |
| 20 | 5.8 (watchfn integration) | WATCH-001–004 | TV-WATCH-* | 21 |
| 21 | 5.5 (docsfn plugin) | DOCS-001–006 | TV-DOCS-* | 20 |
| 22 | 5.1 (diffOpenAPI), 5.3 (apifn diff), CI | DIFF-001–009, CLI-005, CI-001–004 | TV-DIFF-*, TV-CLI-005, TV-CI-* | 13, 14, 25 |
| 23 | 5.8 (authfn integration) | AUTH-001–003 | TV-AUTH-* | 22 |
| 24 | 5.8 (secfn, logfn integration) | SEC-001–002, LOG-001–002 | TV-SEC-*, TV-LOG-* | 22 |
| 25 | 5.8 (watchfn: EndpointMetrics) | WATCH-001–004 | TV-WATCH-* | 21 |
| 26 | 3 (Goals: developer-first testing), 5.2 (collection runner) | RUN-001–011, ASSERT-001–007 | TV-RUN-*, TV-ASSERT-* | 10, 11, 12 |
| 27 | 5.5 (docsfn plugin) | DOCS-001–006 | TV-DOCS-* | 20 |
| 28 | 5.8 (watchfn integration) | WATCH-001–004 | TV-WATCH-* | 21 |
| 29 | 6.2 (OpenCollection YAML), 12 (Bruno interop) | COLL-001–007 | TV-COLL-006 | 06, 07 |
| 30 | 1 (Overview), 3 (Goals), 4 (Non-goals) | — (positioning) | — | All |
| 31 | 5.6 (Mock Server) | MOCK-001–007 | TV-MOCK-* | 16, 17 |
| 32 | 5.7 (Code Snippets) | SNIP-001–007 | TV-SNIP-* | 15 |
| 33 | 5.3 (CLI for CI), 5.8 (GitHub Actions) | CI-001–004 | TV-CI-* | 25 |
| 34 | 5.8 (testfn integration) | TESTFN-001–003 | TV-TESTFN-* | 23 |
| 35 | 5.4 (React + Svelte components) | UI-R-*, UI-S-* | — | 18, 19 |

---

## Audit Result

**No missing intent items.** All 35 intent items from the source material (intent-v0.md, user messages, and ecosystem-derived requirements) are fully covered in:

- SPEC.md (architecture, public API, semantics, invariants)
- REQUIREMENTS.md (103 individual requirements with acceptance criteria)
- TEST_VECTORS.md (deterministic test inputs/outputs for all major features)
- PLAN.md (26 phases with verification steps)
- Phase files (PHASE_00 through PHASE_25)

### Key Change from Original Intent

**Intent item 3** was modified per user instruction: the original intent specified custom `.apifn` files (inspired by Bruno's `.bru` files). The user explicitly changed this to use the **OpenCollection YAML format** ([spec.opencollection.com](https://spec.opencollection.com/)) instead. This ensures:
- Full Bruno 3.0.0+ interoperability (COLL-006)
- No proprietary format lock-in
- Standard YAML tooling ecosystem support
- Alignment with the open specification movement

This change is fully reflected across all spec documents (SPEC Section 6.2, all COLL-* requirements, collection-related phases).

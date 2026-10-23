# REQUIREMENTS

## Table of Contents
- ARCH-001
- ARCH-002
- API-001
- API-002
- ADP-MEM-001
- ADP-IDB-001
- ADP-PG-001
- ADP-ES-001
- ADP-MEI-001
- ADP-CONF-001
- SRV-001
- SRV-002
- SRV-003
- SRV-004
- CLI-001
- CLI-002
- CLI-003
- DFP-001
- MIG-001
- LEG-001
- DOC-001
- DOC-002
- DOC-003
- PRD-001
- PRD-002
- PRD-003
- QA-001

---

ID: ARCH-001
Priority: P0
Statement: SearchFn MUST be organized into strict layers where `@searchfn/adapters` is the runtime boundary, `@searchfn/server` and `@searchfn/client` are thin wrappers, and `@searchfn/datafn-provider` is the DataFn bridge.
Rationale: Prevents repeated business logic across packages and removes architecture drift.
Acceptance criteria:
- `@searchfn/server` and `@searchfn/client` invoke adapter methods only and do not duplicate ranking/index internals.
- Shared adapter contract exists in one file (`searchfn/adapters/src/types.ts`).
- CI checks fail if wrapper packages import removed legacy modules.
Test vectors: TV-ARCH-001, TV-NEG-001
Notes: Wrapper-level validation and envelope mapping are allowed.

ID: ARCH-002
Priority: P0
Statement: The rewrite MUST be breaking and MUST remove backward-compatibility exports and legacy migration layers.
Rationale: User explicitly requested no backward compatibility and no legacy docs.
Acceptance criteria:
- `@searchfn/client` main entrypoint does not export `SearchEngine`, legacy compat adapters, or migration helpers.
- Legacy docs/migration pages are removed from published docs trees.
- Internal imports of removed APIs fail typecheck until migrated.
Test vectors: TV-ARCH-002, TV-NEG-009
Notes: No `deprecated` placeholders are required.

ID: API-001
Priority: P0
Statement: `SearchAdapter` MUST support `index`, `search`, `remove`, `clear`, optional `searchAll`, optional lifecycle methods, and `AbortSignal` propagation.
Rationale: Needed for uniform orchestration across server/client/datafn-provider.
Acceptance criteria:
- Contract compiles and is exported from `@searchfn/adapters`.
- All built-in adapters implement required methods.
- Wrapper calls forward `signal` when provided.
Test vectors: TV-API-001, TV-NEG-003
Notes: Optional capability flags SHOULD be present.

ID: API-002
Priority: P0
Statement: Search wrappers MUST use canonical envelopes and canonical error codes (`DFQL_INVALID`, `LIMIT_EXCEEDED`, `DFQL_ABORTED`, `DFQL_UNSUPPORTED`, `FORBIDDEN`, `INTERNAL`).
Rationale: Ensures deterministic integration behavior and predictable failure handling.
Acceptance criteria:
- Server routes always return `{ok:true,result}` or `{ok:false,error}`.
- Validation errors map to canonical code/message pairs.
- Unexpected exceptions map to `INTERNAL` without leaking secrets.
Test vectors: TV-API-002, TV-NEG-002
Notes: Error `details.path` MUST be set for validation failures.

ID: ADP-MEM-001
Priority: P1
Statement: MemoryAdapter MUST provide deterministic scoring, sorting, and lifecycle behavior for all adapter operations.
Rationale: It is the baseline adapter used by tests and server/dev deployments.
Acceptance criteria:
- Equal-score ties are sorted by id deterministically.
- `dispose` blocks operations until `initialize` is called again.
- `searchAll` merges resources with deterministic ordering.
Test vectors: TV-ADP-MEM-001, TV-NEG-004
Notes: Adapter must remain dependency-light and fast.

ID: ADP-IDB-001
Priority: P1
Statement: IndexedDbAdapter MUST provide persistent browser behavior with deterministic reads/writes and proper reopen/rehydration semantics.
Rationale: Thin client depends on robust offline persistence.
Acceptance criteria:
- Data survives page reload in same DB namespace.
- Re-initialization after `dispose` reopens stores correctly.
- Search results remain deterministic across repeated runs.
Test vectors: TV-ADP-IDB-001, TV-NEG-004
Notes: IndexedDB-specific failures should map to adapter errors.

ID: ADP-PG-001
Priority: P0
Statement: PostgresAdapter MUST be fully implemented with index upsert/remove/search/searchAll/clear capabilities and deterministic ranking.
Rationale: Durable first-party server adapter is required for production deployments.
Acceptance criteria:
- Uses Postgres-native full-text indexing strategy.
- Supports field filtering and query limits.
- Handles bulk index and delete paths efficiently.
Test vectors: TV-ADP-PG-001, TV-NEG-005
Notes: Migration/setup SQL must be documented.

ID: ADP-ES-001
Priority: P0
Statement: Elasticsearch/OpenSearch support MUST be implemented using one elastic-compatible adapter with backend dialect configuration.
Rationale: OpenSearch can share most protocol behavior with Elasticsearch.
Acceptance criteria:
- Adapter supports both Elasticsearch and OpenSearch endpoints by config.
- Index lifecycle (create/mapping/update) is deterministic.
- Search and searchAll outputs follow canonical sort and id coercion rules.
Test vectors: TV-ADP-ES-001, TV-NEG-006
Notes: Dialect mismatch errors must map to `DFQL_UNSUPPORTED`.

ID: ADP-MEI-001
Priority: P0
Statement: MeilisearchAdapter MUST be fully implemented with index, search, searchAll fallback strategy, remove, and clear operations.
Rationale: Required first-party external search backend.
Acceptance criteria:
- Index creation and document upsert are implemented.
- Search supports limit/fields/fuzzy options as supported by backend.
- Remove and clear are idempotent.
Test vectors: TV-ADP-MEI-001, TV-NEG-006
Notes: Unsupported backend options should fail with explicit message.

ID: ADP-CONF-001
Priority: P0
Statement: A shared adapter conformance suite MUST run against Memory, IndexedDB, Postgres, Meilisearch, and elastic-compatible adapters.
Rationale: Prevents behavior drift and ensures contract-level correctness.
Acceptance criteria:
- Conformance suite is package-local and reusable.
- Each adapter has a test harness entry.
- CI/local command executes all conformance tests.
Test vectors: TV-ADP-CONF-001, TV-NEG-007
Notes: External adapter tests may use docker-backed environments.

ID: SRV-001
Priority: P0
Statement: `@searchfn/server` MUST expose a thin constructor that accepts a SearchAdapter and auto-registers search endpoints via `@superfunctions/http`.
Rationale: User requested server package revival as thin adapter-driven layer.
Acceptance criteria:
- Constructor signature matches spec.
- Endpoints `/status`, `/index`, `/search`, `/search-all`, `/remove`, `/clear` are registered.
- `close()` delegates to `adapter.dispose` when available.
Test vectors: TV-SRV-001, TV-NEG-002
Notes: Base path defaults to `/searchfn`.

ID: SRV-002
Priority: P0
Statement: Server endpoints MUST enforce validation and limits before adapter calls.
Rationale: Prevents expensive invalid traffic and ensures canonical behavior.
Acceptance criteria:
- Empty/too-long query and invalid limits return canonical validation errors.
- Index batch caps are enforced.
- `resources` arrays are validated and capped.
Test vectors: TV-SRV-002, TV-NEG-002
Notes: Payload size checks should happen before JSON parse when possible.

ID: SRV-003
Priority: P0
Statement: Server wrapper MUST support authorization callback and structured logging without leaking secrets.
Rationale: Production safety and multi-tenant integration requirement.
Acceptance criteria:
- Unauthorized requests return `FORBIDDEN`.
- Auth callback receives action and parsed payload.
- Logs redact credentials/tokens/connection strings.
Test vectors: TV-SRV-003, TV-NEG-008
Notes: Redaction is mandatory for both request and error logs.

ID: SRV-004
Priority: P1
Statement: Server wrapper MUST expose health/status data including adapter name/capabilities and lifecycle state.
Rationale: Operators need quick diagnostics and readiness checks.
Acceptance criteria:
- `GET /status` returns adapter metadata and uptime.
- Status response remains deterministic.
- Degraded adapter state is represented without crashing server process.
Test vectors: TV-SRV-004, TV-NEG-010
Notes: Health endpoint must not include secrets.

ID: CLI-001
Priority: P0
Statement: `@searchfn/client` MUST expose a thin `createSearchClient` API over any SearchAdapter.
Rationale: Enables direct client-app SearchFn usage without DataFn.
Acceptance criteria:
- API compiles and supports all standard methods.
- Client does not import legacy monolithic modules.
- Methods forward to adapter and normalize defaults.
Test vectors: TV-CLI-001, TV-NEG-001
Notes: API should remain adapter-agnostic.

ID: CLI-002
Priority: P1
Statement: `@searchfn/client` MUST ship convenience constructors for Memory and IndexedDB adapters.
Rationale: Common app use cases should be one-line setup.
Acceptance criteria:
- `createMemorySearchClient` and `createIndexedDbSearchClient` are exported.
- Constructor defaults are documented and tested.
- Returned objects satisfy SearchClient contract.
Test vectors: TV-CLI-002, TV-NEG-011
Notes: These constructors are conveniences; core path is `createSearchClient`.

ID: CLI-003
Priority: P1
Statement: Thin client search methods MUST clamp limits and preserve deterministic ordering semantics from adapters.
Rationale: Prevents UI inconsistencies and accidental expensive queries.
Acceptance criteria:
- Limit defaults and caps are enforced.
- Tie-break order is deterministic.
- Invalid params reject with canonical errors.
Test vectors: TV-CLI-003, TV-NEG-002
Notes: Client-side validation must mirror server semantics where applicable.

ID: DFP-001
Priority: P0
Statement: `@searchfn/datafn-provider` MUST remain fully compatible with DataFn SearchProvider integration and MUST pass through abort signals and deterministic fallback behavior.
Rationale: DataFn integration is a core use case for SearchFn.
Acceptance criteria:
- `createSearchProvider` maps adapter methods to provider methods correctly.
- Fallback `searchAll` behavior is deterministic when adapter lacks `searchAll`.
- `updateIndices` handles upsert/delete correctly.
Test vectors: TV-DFP-001, TV-NEG-003
Notes: Resource field extraction must remain configurable.

ID: MIG-001
Priority: P0
Statement: All internal monorepo consumers of old SearchFn client/server APIs MUST be migrated to rewritten APIs.
Rationale: Prevents dead code retention and broken builds after legacy removal.
Acceptance criteria:
- `recfn` and any other direct consumers compile against new APIs.
- No in-repo imports remain for removed legacy symbols.
- Build/test commands pass for affected packages.
Test vectors: TV-MIG-001, TV-NEG-009
Notes: Lockfile churn is allowed but must remain consistent.

ID: LEG-001
Priority: P0
Statement: Legacy SearchFn code paths and stale modules MUST be removed once replacements are in place.
Rationale: Reduces maintenance overhead and prevents accidental reintroduction.
Acceptance criteria:
- Old `searchfn/server` schema-coupled implementation is removed.
- Old monolithic `searchfn/client` internal engine folders are removed from runtime path.
- Old DataFn miniSearch plugin path is removed or explicitly marked out-of-scope and unused.
Test vectors: TV-LEG-001, TV-NEG-001
Notes: Removal must be atomic with migrations.

ID: DOC-001
Priority: P0
Statement: A new SearchFn docs site MUST be created using Fumadocs with architecture, API, adapters, server, client, DataFn integration, operations, and troubleshooting documentation.
Rationale: User requested comprehensive docs equivalent in quality to DataFn docs.
Acceptance criteria:
- `searchfn/docs` app exists and builds.
- Navigation includes all required sections.
- API pages reflect rewritten contracts exactly.
Test vectors: TV-DOC-001, TV-NEG-012
Notes: Legacy docs/migration content must not be published.

ID: DOC-002
Priority: P0
Statement: A shared docs theme package MUST be introduced and consumed by both DataFn and SearchFn docs sites.
Rationale: User requested reusable theme/colors across docs sites.
Acceptance criteria:
- Shared package exports layout tokens/components used by both docs apps.
- DataFn docs and SearchFn docs import shared theme package.
- Theme parity check command passes.
Test vectors: TV-DOC-002, TV-NEG-013
Notes: Package should be reusable for future docs sites.

ID: DOC-003
Priority: P1
Statement: Docs content MUST include production operation guidance for each adapter including setup, limits, observability, and failure modes.
Rationale: Full implementations require actionable operator guidance.
Acceptance criteria:
- Per-adapter pages include configuration matrices.
- Security and redaction guidance is documented.
- Troubleshooting tables map error codes to remediation.
Test vectors: TV-DOC-003, TV-NEG-012
Notes: Example code must compile or be test-validated.

ID: PRD-001
Priority: P0
Statement: External adapters MUST implement resilience controls including timeout, bounded retries with jitter, and classified retryable errors.
Rationale: Production reliability under transient backend faults.
Acceptance criteria:
- Each external adapter supports configurable timeout and retry policy.
- Retry behavior is deterministic and bounded.
- Non-retryable errors fail fast.
Test vectors: TV-PRD-001, TV-NEG-014
Notes: Defaults should be safe and conservative.

ID: PRD-002
Priority: P0
Statement: SearchFn runtime components MUST emit structured observability signals and MUST redact sensitive values.
Rationale: Needed for safe production diagnosis.
Acceptance criteria:
- Logs include operation metadata and duration.
- Secrets are never emitted in clear text.
- Observability docs include full field definitions.
Test vectors: TV-PRD-002, TV-NEG-008
Notes: Redaction should apply recursively.

ID: PRD-003
Priority: P1
Statement: Performance gates MUST be defined and enforced for indexing and query paths across adapters.
Rationale: Prevents regressions and supports capacity planning.
Acceptance criteria:
- Benchmark commands exist for at least memory, indexeddb, postgres.
- Thresholds are documented and validated in local test/benchmark scripts.
- Regression beyond threshold fails verification command.
Test vectors: TV-PRD-003, TV-NEG-015
Notes: Thresholds may differ per runtime/backend class.

ID: QA-001
Priority: P0
Statement: End-to-end validation MUST include local reproducible integration tests for server+adapter combinations and DataFn provider flow.
Rationale: Integration coverage is required for reliable rollout.
Acceptance criteria:
- Test matrix includes at least Postgres, Meilisearch, and Elasticsearch/OpenSearch.
- DataFn provider integration tests pass with rewritten adapters.
- One-command verification script exists and is documented.
Test vectors: TV-QA-001, TV-NEG-016
Notes: Docker-backed tests are acceptable and expected for external services.

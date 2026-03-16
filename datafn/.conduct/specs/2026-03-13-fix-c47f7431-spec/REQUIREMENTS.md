# Requirements

## Table of Contents
- CON-001
- CON-002
- CON-003
- CLI-001
- CLI-002
- CLI-003
- IDX-001
- IDX-002
- SRV-001
- SRV-002
- UNI-001
- UNI-002
- EX-001
- TST-001
- DOC-001

## CON-001
- ID: CON-001
- Priority: P0
- Statement: DataFn SearchProvider contracts in `datafn/core` and `datafn/server` MUST expose `prefix`, `fuzzy`, and `fieldBoosts` in both `search()` and `searchAll()` parameter types.
- Rationale: Type-level contract parity is required so caller layers can forward options without `any` casts or silent dropping.
- Acceptance criteria:
  - `datafn/core/src/search-provider.ts` includes all three fields for `search` and `searchAll`.
  - `datafn/server/src/search-provider.ts` mirrors the same shape.
  - TypeScript compilation passes for `@datafn/core`, `@datafn/server`, and `@searchfn/datafn-provider`.
- Test vectors: TV-CON-001-P, TV-CON-001-N
- Notes: This requirement fixes issue RC-1 and prevents future contract drift.

## CON-002
- ID: CON-002
- Priority: P0
- Statement: Server query/cross-resource transport types MUST include `prefix`, `fuzzy`, and `fieldBoosts` so the options are representable in the DFQL execution pipeline.
- Rationale: Even with provider contract updates, missing query-side types still force option loss.
- Acceptance criteria:
  - `datafn/server/src/execution/query/dfql.ts` search block includes all three fields.
  - `datafn/server/src/execution/search/cross-resource.ts` `CrossResourceSearchParams` includes all three fields.
  - No `as any` is required to read these properties in server search execution code paths.
- Test vectors: TV-CON-002-P, TV-CON-002-N
- Notes: This requirement addresses RC-3 and RC-4 typing gaps.

## CON-003
- ID: CON-003
- Priority: P1
- Statement: DataFn public request contracts for `client.search()` and `/datafn/search` MUST include optional `prefix`, `fuzzy`, and `fieldBoosts` fields with canonical validation.
- Rationale: Callers need a documented I/O envelope to use advanced search options consistently.
- Acceptance criteria:
  - Client and server docs/spec code paths document the same field names and types.
  - Omitted fields preserve existing behavior.
  - Invalid field shapes fail with canonical errors instead of being silently ignored.
- Test vectors: TV-CON-003-P, TV-CON-003-N
- Notes: This closes RC-2 and RC-5 caller-envelope ambiguity.

## CLI-001
- ID: CLI-001
- Priority: P0
- Statement: `createDatafnClient().search()` MUST validate `prefix`, `fuzzy`, and `fieldBoosts` using deterministic client-side validation before execution.
- Rationale: Deterministic validation avoids runtime ambiguity and keeps parity with server constraints.
- Acceptance criteria:
  - `prefix` accepts only boolean.
  - `fuzzy` accepts only boolean or finite number >=0.
  - `fieldBoosts` accepts only plain objects of finite positive numeric values with max 100 keys.
  - Validation errors use canonical `DFQL_INVALID`/`LIMIT_EXCEEDED` messages with `details.path`.
- Test vectors: TV-CLI-001-P, TV-CLI-001-N
- Notes: Keep existing query/limit/resource validations unchanged unless explicitly expanded.

## CLI-002
- ID: CLI-002
- Priority: P0
- Statement: `client.search()` MUST forward `prefix`, `fuzzy`, and `fieldBoosts` unchanged to local provider and remote transport payloads.
- Rationale: The current failure is option dropping at caller boundaries.
- Acceptance criteria:
  - Local path (`searchProvider.searchAll`) receives options when provided.
  - Remote path (`remote.search`) receives options when provided.
  - Omitted options remain `undefined` (no coercion to default values in payload).
- Test vectors: TV-CLI-002-P, TV-CLI-002-N
- Notes: This directly addresses RC-2.

## CLI-003
- ID: CLI-003
- Priority: P0
- Statement: `client.search()` MUST default to local-first execution in `source="auto"` mode and MUST support explicit source override values `local` and `remote`.
- Rationale: User intent requires local-default behavior in sync mode while preserving explicit remote usage.
- Acceptance criteria:
  - `source` omitted or `auto` chooses local provider when available.
  - `source=local` fails with `DFQL_UNSUPPORTED` when local provider is unavailable.
  - `source=remote` fails with `DFQL_UNSUPPORTED` when remote search is unavailable/offline.
  - `source` invalid string fails with `DFQL_INVALID`.
- Test vectors: TV-CLI-003-P, TV-CLI-003-N
- Notes: This requirement implements the user’s “default to local” directive.

## IDX-001
- ID: IDX-001
- Priority: P0
- Statement: Client mutation execution MUST call `searchProvider.updateIndices()` after successful local mutations with deterministic operation mapping.
- Rationale: Local index freshness is required for usable local-first search and local-only mode.
- Acceptance criteria:
  - Local-first/offline-success paths invoke index update for `insert/merge/replace/trash/restore/archive/unarchive` as `upsert`.
  - Local delete invokes index update as `delete`.
  - Batch mutations update indices per mutation in deterministic order.
  - Debounced local merge path updates index after optimistic local write.
- Test vectors: TV-IDX-001-P, TV-IDX-001-N
- Notes: This closes RC-6.

## IDX-002
- ID: IDX-002
- Priority: P0
- Statement: Client-side search index update failures MUST be fail-soft (do not fail mutation) and MUST be observable.
- Rationale: Search is secondary to mutation durability and must not block writes.
- Acceptance criteria:
  - Mutation result remains successful when `updateIndices()` throws.
  - Warning/error telemetry contains resource + operation + error string.
  - No unhandled promise rejection is emitted by search update failures.
- Test vectors: TV-IDX-002-P, TV-IDX-002-N
- Notes: Mirror server-side `tryUpdateSearchIndex()` non-fatal semantics.

## SRV-001
- ID: SRV-001
- Priority: P0
- Statement: Server execution paths (`executeSearchQuery`, `executeCrossResourceSearch`, and DB-native resolver wiring) MUST forward `prefix`, `fuzzy`, and `fieldBoosts` from request/query objects.
- Rationale: Prefix/fuzzy/boost options currently disappear before reaching adapters.
- Acceptance criteria:
  - `executeSearchQuery` provider call includes all options from `query.search`.
  - `executeCrossResourceSearch` provider call includes all options from params.
  - Query execution bridge passes options to DB-native per-resource resolver signature where applicable.
- Test vectors: TV-SRV-001-P, TV-SRV-001-N
- Notes: This addresses RC-3 and RC-4 in runtime execution.

## SRV-002
- ID: SRV-002
- Priority: P0
- Statement: Server route and query validators MUST parse and validate `prefix`, `fuzzy`, and `fieldBoosts` with canonical error behavior.
- Rationale: Route-level acceptance is required for HTTP callers and parity with client-side validation.
- Acceptance criteria:
  - `/datafn/search` route extracts and forwards all three options.
  - Query validator allows and validates these options inside `query.search`.
  - Invalid shapes produce deterministic `DFQL_INVALID` with accurate `details.path`.
- Test vectors: TV-SRV-002-P, TV-SRV-002-N
- Notes: This requirement directly closes RC-5.

## UNI-001
- ID: UNI-001
- Priority: P0
- Statement: When `searchProvider` is configured, `clientSearch` plugin MUST delegate search candidate resolution and index lifecycle updates to `searchProvider` instead of MiniSearch internals.
- Rationale: Client currently has two disconnected search systems; adapter-backed behavior must be unified.
- Acceptance criteria:
  - Plugin no longer constructs/uses MiniSearch in provider-delegation mode.
  - Plugin search candidate path uses provider `search()` and injects deterministic ID filtering.
  - Plugin mutation/sync hooks call provider update APIs rather than maintaining a second index.
- Test vectors: TV-UNI-001-P, TV-UNI-001-N
- Notes: This resolves RC-7 for provider-enabled clients.

## UNI-002
- ID: UNI-002
- Priority: P1
- Statement: MiniSearch-only plugin mode MUST remain backward compatible when no `searchProvider` exists and MUST be explicitly deprecated in documentation.
- Rationale: Existing users need non-breaking migration while converging to provider-backed search.
- Acceptance criteria:
  - Legacy plugin usage without provider still functions.
  - Provider-enabled mode takes precedence when provider exists.
  - Docs mark MiniSearch-only mode as deprecated/compatibility mode.
- Test vectors: TV-UNI-002-P, TV-UNI-002-N
- Notes: This keeps ecosystem stability while unifying target architecture.

## EX-001
- ID: EX-001
- Priority: P0
- Statement: Todo example app MUST be updated to demonstrate seamless local and server search using the same SearchFn option set (`prefix`, `fuzzy`, `fieldBoosts`) with local-first defaults.
- Rationale: User explicitly requested example parity and real-world verification.
- Acceptance criteria:
  - Client example uses IndexedDB SearchFn adapter configuration suitable for local-first use.
  - Server example uses Elasticsearch/OpenSearch adapter config with matching options.
  - UI search call path includes option forwarding and demonstrates working prefix/fuzzy behavior.
- Test vectors: TV-EX-001-P, TV-EX-001-N
- Notes: This requirement operationalizes the issue checklist in a runnable app.

## TST-001
- ID: TST-001
- Priority: P0
- Statement: Regression tests MUST cover positive and negative cases for every caller boundary where search options or lifecycle updates can be dropped.
- Rationale: The reported bug is a boundary wiring failure and requires boundary-focused tests.
- Acceptance criteria:
  - Client tests assert forwarding, local-first routing, and source override behavior.
  - Server tests assert forwarding from query and route paths.
  - Mutation tests assert local index updates and fail-soft behavior.
  - Plugin tests assert provider-delegation mode and legacy mode behavior.
  - Regression checklist explicitly covers each issue drop point (`RC-1` through `RC-8`) with at least one assertion per boundary.
- Test vectors: TV-TST-001-P, TV-TST-001-N
- Notes: Existing tests must remain green.

## DOC-001
- ID: DOC-001
- Priority: P1
- Statement: DataFn search documentation MUST be updated to describe provider-backed local-first search, option parity, and deprecation status of MiniSearch-only plugin mode.
- Rationale: Current docs describe stale behavior and will cause repeated misconfiguration.
- Acceptance criteria:
  - Search docs describe `prefix`, `fuzzy`, `fieldBoosts` for both query and cross-resource search.
  - Docs explain local-first default and `source` override semantics.
  - Docs include migration note from MiniSearch plugin-only usage to provider-backed mode.
- Test vectors: TV-DOC-001-P, TV-DOC-001-N
- Notes: Documentation is part of user-visible completion, not optional cleanup.

# Requirement IDs
- SARCH-001
- SPLAT-001
- SAPI-001
- SENG-001
- SMEM-001
- SSQL-001
- SDET-001
- SERR-001
- SOBS-001
- SDOC-001

## SARCH-001
- Priority: P0
- Statement: `searchfn/swift` MUST ship as a standalone Swift package whose core engine, adapter contracts, adapters, client, and convenience API remain usable without importing any DataFn target.
- Rationale: The user wants Swift SearchFn to work both independently and later as a DataFn backend without collapsing those concerns into one package.
- Acceptance criteria:
  - `searchfn/swift/Package.swift` defines separate products for core, contracts, adapters, client, and convenience APIs.
  - The core/search package graph contains no dependency on `datafn/*`.
  - A standalone app can create an in-memory or SQLite-backed search client using only `searchfn/swift`.
- Test vectors: TV-SF-001, TV-SF-006
- Notes: DataFn-specific integration is intentionally delegated to the companion DataFn spec.

## SPLAT-001
- Priority: P1
- Statement: The SearchFn Swift package MUST keep Apple-only frameworks out of `SearchFnCore`, `SearchFnAdapterContracts`, `SearchFnMemoryAdapter`, `SearchFnSQLiteAdapter`, and `SearchFnClient`.
- Rationale: The default decision was to keep the core portable where possible rather than baking Apple persistence assumptions into search itself.
- Acceptance criteria:
  - The named targets compile without importing Core Data, SwiftUI, CloudKit, or WebKit.
  - Filesystem and SQLite usage are expressed in a portable way using Foundation and system SQLite bindings only.
  - Any Apple-specific helper target is isolated from the portable targets.
- Test vectors: TV-SF-001, TV-SF-006
- Notes: This requirement does not promise Windows support. It only constrains package design away from Apple-only coupling.

## SAPI-001
- Priority: P0
- Statement: SearchFn Swift MUST expose adapter/client request and response types, defaults handling, validation limits, and `searchAll` fallback semantics equivalent to the current `searchfn/adapter-contracts` and `searchfn/client` behavior.
- Rationale: Reuse depends on stable semantics across languages, and DataFn integration must be able to rely on the same contract shape.
- Acceptance criteria:
  - Public Swift types exist for documents, initialize/index/search/searchAll/remove, capabilities, defaults, and errors.
  - `SearchFnClient` validates non-empty resources and queries, enforces the numeric limits in this spec, and applies defaults in the same precedence order as TypeScript.
  - If an adapter lacks native `searchAll`, `SearchFnClient` performs deterministic per-resource fallback and rejects missing `resources`.
- Test vectors: TV-SF-001, TV-SF-002, TV-SF-004, TV-SF-005
- Notes: Exact symbol names may differ slightly from TypeScript naming, but semantics must match.

## SENG-001
- Priority: P0
- Statement: The built-in Swift engine MUST implement tokenization, normalization, stop words, optional stemming, prefix indexing, fuzzy expansion, BM25-style scoring, and field boosts with deterministic results.
- Rationale: The value of Swift SearchFn is parity with existing SearchFn quality, not just storing strings in SQLite.
- Acceptance criteria:
  - Tokenization is Unicode-aware.
  - Lowercasing, stop-word removal, and optional stemming are applied consistently to indexed text and queries.
  - Prefix search is supported and exact matches rank above prefix-only matches.
  - Fuzzy search supports only valid distances up to `3`.
  - Field boosts affect ranking without breaking deterministic tie-break rules.
- Test vectors: TV-SF-002, TV-SF-003, TV-SF-010
- Notes: This requirement does not require byte-for-byte score equality with TypeScript, but ranking behavior and tie-break rules must be stable and equivalent.

## SMEM-001
- Priority: P0
- Statement: SearchFn Swift MUST provide an in-memory adapter and high-level in-memory convenience API for standalone local search workflows.
- Rationale: Independent usage should not require disk persistence or DataFn just to search app-local documents.
- Acceptance criteria:
  - An in-memory adapter exists and is backed by the built-in engine.
  - A convenience API exists for direct app usage without constructing every layer manually.
  - Indexing, searching, searchAll, removing, clearing, and disposing work end-to-end in memory.
- Test vectors: TV-SF-001, TV-SF-007, TV-SF-009
- Notes: The convenience API may wrap the client rather than reimplement search behavior.

## SSQL-001
- Priority: P0
- Statement: SearchFn Swift MUST provide a persistent SQLite-backed adapter that stores SearchFn-owned index data beneath a caller-supplied root directory using deterministic on-disk paths.
- Rationale: The package needs durable local search without using Core Data as the primary search backend.
- Acceptance criteria:
  - The adapter accepts `rootURL` and `indexKey`.
  - The adapter derives a deterministic directory name from `indexKey`.
  - The adapter stores `searchfn.sqlite` and `manifest.json` beneath that directory.
  - Reopening the same adapter configuration returns equivalent search results for the same indexed data.
  - Format mismatches fail explicitly instead of mutating the store silently.
- Test vectors: TV-SF-006, TV-SF-008
- Notes: This requirement is about SearchFn-owned persistence. It intentionally does not place SearchFn state into Core Data.

## SDET-001
- Priority: P0
- Statement: SearchFn Swift MUST guarantee deterministic ordering for search results and `searchAll` results, including native `searchAll` and fallback `searchAll`.
- Rationale: DataFn and standalone apps both need reproducible result ordering for testing, UI stability, and cross-runtime parity.
- Acceptance criteria:
  - Tie-breaking for `searchAll` uses `score desc`, `resource asc`, `id asc`.
  - Repeated identical queries against unchanged state return identical ordered results.
  - Fallback `searchAll` sorts merged per-resource results with the same deterministic rule.
- Test vectors: TV-SF-003, TV-SF-004, TV-SF-010
- Notes: Deterministic ordering applies even if the underlying adapter performs native `searchAll`.

## SERR-001
- Priority: P0
- Statement: SearchFn Swift MUST surface deterministic validation, disposed-state, format-mismatch, and cancellation failures using canonical error codes and structured details.
- Rationale: Callers need predictable failure modes that can be mapped into higher-level UX and DataFn integration.
- Acceptance criteria:
  - Validation failures use `DFQL_INVALID` or `LIMIT_EXCEEDED` with a `details.path`.
  - Cancellation failures use `DFQL_ABORTED`.
  - Disposed adapter calls use `SEARCH_ADAPTER_DISPOSED`.
  - SQLite format mismatches use `SEARCH_INDEX_FORMAT_MISMATCH`.
  - Unexpected internal failures use `INTERNAL`.
- Test vectors: TV-SF-005, TV-SF-008
- Notes: Error messages must be stable enough for deterministic tests.

## SOBS-001
- Priority: P1
- Statement: SearchFn Swift MUST provide opt-in diagnostics for indexing, querying, searchAll fallback, and persistence lifecycle without logging indexed field contents by default.
- Rationale: Local search requires visibility during development, but raw document content should not leak into logs.
- Acceptance criteria:
  - A documented diagnostics event surface exists.
  - Diagnostics can be disabled completely.
  - Default diagnostics do not include raw field values or full queries.
- Test vectors: TV-SF-001, TV-SF-006
- Notes: Query length and counts are acceptable; raw text payloads are not.

## SDOC-001
- Priority: P1
- Statement: SearchFn Swift MUST ship with package docs, standalone examples, and automated conformance tests covering in-memory and SQLite adapters.
- Rationale: Reusability depends on discoverable examples and on tests that keep semantics aligned with existing SearchFn behavior.
- Acceptance criteria:
  - README and docs describe standalone in-memory and persistent usage.
  - Tests cover validation, defaults, deterministic ordering, persistence reopen, clear/remove, and error conditions.
  - Example code compiles from the repo root without machine-specific paths.
- Test vectors: TV-SF-001, TV-SF-006, TV-SF-009
- Notes: The companion DataFn integration docs are out of scope for this spec.

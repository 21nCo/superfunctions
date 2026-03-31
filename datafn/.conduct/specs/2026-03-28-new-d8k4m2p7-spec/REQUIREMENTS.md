# Requirement IDs
- DARCH-001
- DAPI-001
- DCFG-001
- DJS-001
- DRT-001
- DIDX-001
- DREB-001
- DPST-001
- DERR-001
- DDOC-001

## DARCH-001
- Priority: P0
- Statement: DataFn MUST add native search contracts and a SearchFn-backed native integration target under `datafn/swift` without reimplementing SearchFn engine logic inside DataFn.
- Rationale: DataFn needs a clean integration boundary while preserving SearchFn as the reusable search runtime.
- Acceptance criteria:
  - `datafn/swift/Package.swift` exports `DatafnSearchContracts` and `DatafnSearchFnBackend`.
  - `DatafnSearchFnBackend` depends on the companion `searchfn/swift` package.
  - No duplicate BM25/tokenization/fuzzy engine implementation is introduced in `datafn/swift`.
- Test vectors: TV-DFS-002, TV-DFS-010
- Notes: This requirement intentionally keeps search ownership split: SearchFn owns search semantics, DataFn owns integration.

## DAPI-001
- Priority: P0
- Statement: `@datafn/swift-bridge` MUST expose a native-backed `SearchProvider` and bridge methods for search initialization, single-resource search, cross-resource search, and disposal.
- Rationale: WebView code needs a JS-facing provider that matches existing DataFn search usage while delegating work to Swift.
- Acceptance criteria:
  - `createNativeBackedSearchProvider(bus)` exists and returns a provider marked `__datafnNativeBacked = true`.
  - Bridge methods `search.initialize`, `search.search`, `search.searchAll`, and `search.dispose` are implemented.
  - Bridge request and response envelopes follow the existing `datafn-bridge/v1` pattern.
- Test vectors: TV-DFS-002, TV-DFS-003, TV-DFS-008
- Notes: The native-backed provider’s `updateIndices` remains for compatibility but does not own indexing lifecycle.

## DCFG-001
- Priority: P0
- Statement: Native search initialization MUST derive search-enabled resources exclusively from `schema.resources[].indices.search` and MUST reject invalid or duplicate search resource definitions.
- Rationale: DataFn already has an authoritative source for searchable fields; the native path should not invent a parallel configuration source.
- Acceptance criteria:
  - The JavaScript provider initialize payload is derived from schema indices.
  - The Swift runtime derives the same resource list from the same schema.
  - Resources with no search fields are excluded.
  - Duplicate normalized resource entries are rejected with `DFQL_INVALID`.
- Test vectors: TV-DFS-001, TV-DFS-002, TV-DFS-009
- Notes: This keeps browser-owned and native-backed search field selection aligned.

## DJS-001
- Priority: P0
- Statement: In native-backed mode, `@datafn/client` MUST route search through the native-backed provider and MUST skip JavaScript-side search index maintenance whenever the provider is marked native-backed.
- Rationale: Swift owns the derived local index in native-backed mode, so the JS client should not maintain a second search lifecycle or sidecar persistence path.
- Acceptance criteria:
  - Native-backed search queries call the bridge provider rather than an IndexedDB provider.
  - Browser-owned mode remains unchanged.
  - JavaScript mutation/sync/provider rebuild hooks do not call `updateIndices` when `__datafnNativeBacked` is true.
  - Native-backed mode does not create IndexedDB search persistence.
- Test vectors: TV-DFS-001, TV-DFS-003, TV-DFS-004
- Notes: The no-op `updateIndices` method remains only for interface compatibility.

## DRT-001
- Priority: P0
- Statement: `DatafnAppleRuntime` MUST host an optional native search backend, initialize it from schema-derived search resources, and expose direct Swift `search` and `searchAll` APIs over the same backend used by bridge requests.
- Rationale: SwiftUI/native code and embedded web content must share one native search authority.
- Acceptance criteria:
  - `DatafnAppleRuntimeConfiguration` accepts optional search configuration.
  - `DatafnAppleRuntime` initializes the backend when configured and resources are search-enabled.
  - `DatafnAppleRuntime.search` and `searchAll` query the same backend instance used by `search.*` bridge handlers.
- Test vectors: TV-DFS-002, TV-DFS-009, TV-DFS-010
- Notes: If no search backend is configured, runtime search APIs must fail deterministically instead of silently degrading.

## DIDX-001
- Priority: P0
- Statement: The native runtime MUST update the native search backend from Core Data changes caused by local writes, DataFn-server sync, and CloudKit merges.
- Rationale: The native index must stay aligned with the authoritative Core Data store across every native-backed topology.
- Acceptance criteria:
  - Local mutation writes cause matching index upserts or deletes.
  - DataFn-server clone/pull/reconcile writes cause matching index updates.
  - CloudKit imports/merges cause matching index updates.
  - Only configured search fields are indexed.
- Test vectors: TV-DFS-004, TV-DFS-005, TV-DFS-006
- Notes: This is the core reason the native runtime, not JavaScript, owns index maintenance.

## DREB-001
- Priority: P0
- Statement: The runtime MUST detect search config mismatches using a deterministic digest, clear stale native search state, and rebuild from Core Data before reporting the search backend ready.
- Rationale: Search field or schema changes must not leave a stale index serving incorrect results.
- Acceptance criteria:
  - A deterministic digest is computed from schema hash, search-enabled resources, search fields, and backend kind.
  - Mismatches trigger `rebuilding` state, clear existing search backend state, and full reindex from Core Data.
  - Rebuild failure respects `failIfUnavailable`.
- Test vectors: TV-DFS-007, TV-DFS-008
- Notes: This requirement applies equally to DataFn-server and CloudKit native-backed modes.

## DPST-001
- Priority: P0
- Statement: Native search persistence MUST live beneath the namespace support directory as SearchFn-owned derived local state and MUST NOT be synced through CloudKit.
- Rationale: Search must be colocated with native DataFn state while remaining separate from the authoritative Core Data store and CloudKit replication.
- Acceptance criteria:
  - Default search root is `<namespace support directory>/SearchFn`.
  - Search files are separate from `datafn.sqlite`.
  - CloudKit mode does not attempt to replicate SearchFn index files.
  - Different remote backends remain isolated because they already have separate store roots.
- Test vectors: TV-DFS-005, TV-DFS-006, TV-DFS-007
- Notes: An explicit override `searchRootURL` is allowed if it remains a file URL.

## DERR-001
- Priority: P0
- Statement: DataFn native search integration MUST surface deterministic errors for unavailable bridge, unavailable backend, invalid search requests, unsupported search, and rebuild failures.
- Rationale: Apps need reliable failure handling across bridge, runtime, and rebuild paths.
- Acceptance criteria:
  - Missing bridge or timeout surfaces `NATIVE_BRIDGE_UNAVAILABLE`.
  - Search backend absent or rebuilding surfaces `NATIVE_SEARCH_UNAVAILABLE`.
  - Invalid requests surface `DFQL_INVALID`.
  - Search requested with no provider/backend in unsupported contexts surfaces `DFQL_UNSUPPORTED`.
  - Rebuild failure surfaces `SEARCH_INDEX_REBUILD_FAILED` or the wrapped canonical failure code with structured details.
- Test vectors: TV-DFS-003, TV-DFS-007, TV-DFS-008, TV-DFS-009
- Notes: Error details must include `path` when validation is the source of failure.

## DDOC-001
- Priority: P1
- Statement: DataFn MUST document and test browser-owned search, native-backed SearchFn search, and CloudKit-derived local search behavior in examples and docs.
- Rationale: The dual-runtime topology is subtle; the examples and docs must make the search ownership boundary obvious.
- Acceptance criteria:
  - The todo example shows browser-owned IndexedDB search and native-backed SearchFn search.
  - Apple host example wires a native search backend.
  - Docs explain that native-backed mode disables IndexedDB search persistence and that CloudKit does not sync the search index itself.
  - Automated tests cover browser and native-backed regressions.
- Test vectors: TV-DFS-001, TV-DFS-004, TV-DFS-006, TV-DFS-010
- Notes: Documentation must not include absolute machine-specific paths.

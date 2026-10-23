# Architecture sketch
- `datafn/swift/Sources/DatafnSearchContracts`
  - DataFn-native search request/result/update contracts and backend factory protocol.
- `datafn/swift/Sources/DatafnSearchFnBackend`
  - integration target that adapts the companion `searchfn/swift` package into `DatafnNativeSearchBackend`.
- `datafn/swift/Sources/DatafnAppleRuntime`
  - runtime configuration, startup lifecycle, direct Swift search API, search metadata/rebuild orchestration.
- `datafn/swift/Sources/DatafnWebViewBridgeHost`
  - bridge request handlers for `search.initialize`, `search.search`, `search.searchAll`, and `search.dispose`.
- `datafn/swift-bridge/src`
  - TypeScript native-backed `SearchProvider` factory and bridge message support.
- `datafn/client/src`
  - native-backed search-provider marker handling, query routing, and suppression of JS-side indexing when native search is active.
- `datafn/examples/*` and docs
  - browser/native dual-mode examples and explanations.

# Dependency graph
1. `DatafnSearchContracts` must exist before bridge handlers, Apple runtime hooks, and the SearchFn backend target.
2. `@datafn/swift-bridge` search-provider factory depends on bridge protocol changes.
3. `@datafn/client` native-backed search behavior depends on the TS bridge factory marker.
4. `DatafnSearchFnBackend` depends on the companion `searchfn/swift` package.
5. Runtime rebuild and sync hooks depend on both the contracts and the backend target.
6. Docs/examples depend on completed TS and Swift integration.

# Phases overview
- Phase 00: Add DataFn native search contracts and bridge method scaffolding.
  - Delivered capability: compile-time contract foundation in Swift and TypeScript.
  - Verification: `npm --prefix datafn/swift-bridge test` and `swift test --package-path datafn/swift --filter DatafnSearchContractsTests`
- Phase 01: Add the native-backed TypeScript `SearchProvider` and client-side routing/marker behavior.
  - Delivered capability: WebView JS can issue native-backed search requests and JS indexing hooks are skipped when appropriate.
  - Verification: `npm --prefix datafn/client test -- native-backed-search`
- Phase 02: Add `DatafnSearchFnBackend` and direct Swift runtime search APIs.
  - Delivered capability: Apple runtime can host the companion SearchFn backend and native Swift code can query it.
  - Verification: `swift test --package-path datafn/swift --filter DatafnSearchFnBackendTests`
- Phase 03: Add native search placement, metadata digest comparison, and rebuild orchestration.
  - Delivered capability: deterministic index root, mismatch detection, and rebuild-from-Core-Data flow.
  - Verification: `swift test --package-path datafn/swift --filter DatafnSearchRebuildTests`
- Phase 04: Wire server-sync and CloudKit-driven index updates plus bridge-host execution.
  - Delivered capability: native index stays current across all native-backed topologies.
  - Verification: `swift test --package-path datafn/swift` and targeted JS bridge tests
- Phase 05: Update examples, docs, and regression matrix for browser vs native-backed search.
  - Delivered capability: user-facing examples and end-to-end regression coverage.
  - Verification: `npm --prefix datafn/client test`, `npm --prefix datafn/swift-bridge test`, `swift test --package-path datafn/swift`

# Definition of Done
No phase is complete unless its verification steps pass.

# Architecture sketch
- `searchfn/swift/Sources/SearchFnAdapterContracts`
  - Swift equivalents of SearchFn request/response/config/error contracts.
- `searchfn/swift/Sources/SearchFnCore`
  - tokenization, normalization, stop words, stemming, prefix expansion, vocabulary lookup, fuzzy expansion, BM25-style scoring, deterministic sorting helpers.
- `searchfn/swift/Sources/SearchFnMemoryAdapter`
  - in-process adapter backed by `SearchFnCore`.
- `searchfn/swift/Sources/SearchFnSQLiteAdapter`
  - persisted adapter backed by `SearchFnCore` plus SearchFn-owned SQLite storage.
- `searchfn/swift/Sources/SearchFnClient`
  - validation, defaults merging, `searchAll` fallback, adapter info surface.
- `searchfn/swift/Sources/SearchFnConvenience`
  - `InMemorySearchFn` and persisted `SearchFn` wrappers for direct app usage.
- `searchfn/swift/Tests/*`
  - unit, adapter, persistence, and conformance suites.

# Dependency graph
1. `SearchFnAdapterContracts` must exist before any adapter or client target.
2. `SearchFnCore` must exist before `SearchFnMemoryAdapter` and `SearchFnSQLiteAdapter`.
3. Adapters must exist before `SearchFnClient`.
4. `SearchFnClient` must exist before `SearchFnConvenience`.
5. Tests and docs depend on all of the above.

# Phases overview
- Phase 00: Scaffold the Swift package, public contracts, error model, and validating client surface.
  - Delivered capability: compilable package graph plus contract-parity client semantics.
  - Verification: `swift test --package-path searchfn/swift --filter SearchFnClientTests`
- Phase 01: Implement core engine semantics for tokenization, prefix, fuzzy, field boosts, and deterministic scoring helpers.
  - Delivered capability: built-in engine parity.
  - Verification: `swift test --package-path searchfn/swift --filter SearchFnCoreTests`
- Phase 02: Implement in-memory adapter and ergonomic in-memory convenience API.
  - Delivered capability: standalone in-memory search workflows.
  - Verification: `swift test --package-path searchfn/swift --filter SearchFnMemoryAdapterTests`
- Phase 03: Implement SQLite adapter, deterministic path layout, manifest handling, and reopen durability.
  - Delivered capability: durable local on-disk search index.
  - Verification: `swift test --package-path searchfn/swift --filter SearchFnSQLiteAdapterTests`
- Phase 04: Add conformance, determinism, diagnostics, and cross-adapter test matrix.
  - Delivered capability: behavior stability and observability.
  - Verification: `swift test --package-path searchfn/swift`
- Phase 05: Write docs/examples and finish package export polish.
  - Delivered capability: user-facing documentation and examples for standalone use.
  - Verification: `swift test --package-path searchfn/swift` and documentation/example compile checks from repo root.

# Definition of Done
No phase is complete unless its verification steps pass.

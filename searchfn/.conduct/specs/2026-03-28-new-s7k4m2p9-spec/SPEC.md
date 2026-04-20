# Metadata
- Timestamp: 2026-03-28T05:19:25Z
- agent_name: unknown-agent
- model: GPT-5 Codex
- launcher: Codex Desktop
- workspace: repo root
- OS: Darwin arm64
- shell: zsh
- git: detached HEAD at `50929162a8547f6f55db27bdc51c47289c0bc2af`, dirty `dirty`
- spec_folder: `2026-03-28-new-s7k4m2p9-spec`
- spec_path: `searchfn/.conduct/specs/2026-03-28-new-s7k4m2p9-spec`
- spec_type: `new`
- spec_id: `s7k4m2p9`
- input_paths:
  - `searchfn/.conduct/spec.md`
  - `searchfn/docs/content/docs/architecture.mdx`
  - `searchfn/adapter-contracts/src/index.ts`
  - `searchfn/client/src/client.ts`
  - `searchfn/client/src/types.ts`
  - `searchfn/client/README.md`
  - `searchfn/datafn-provider/src/index.ts`
  - thread intent: current conversation about Swift SearchFn + DataFn native-backed local search

# Overview
This spec defines a new reusable Swift SearchFn package under `searchfn/swift/` that MUST preserve the current SearchFn adapter-first architecture while making native local search available in two modes:

1. standalone Swift search workflows that do not depend on DataFn
2. future DataFn-native integration via a separate companion DataFn spec

The Swift package MUST not treat Core Data as the canonical search index model. The canonical design is:
- SearchFn owns its own search runtime and persisted index
- callers supply the root directory for persisted indexes
- DataFn, when integrated later, uses SearchFn as a derived local search subsystem on top of its own record store

This spec is intentionally limited to in-process/local usage. It does not define a Swift HTTP server, remote search service, vector search, or CloudKit-backed index replication.

# Glossary
- SearchFn Swift: The Swift Package Manager package added under `searchfn/swift/`.
- Search adapter: A Swift protocol equivalent to the existing `SearchAdapter` contract in TypeScript.
- Search client: A validating wrapper that applies defaults, enforces limits, delegates to an adapter, and provides `searchAll` fallback behavior.
- High-level API: A convenience API for direct app use, analogous in purpose to the existing ergonomic SearchFn entrypoints, but built on the adapter/client layer rather than bypassing it.
- Memory adapter: An in-memory adapter that uses the built-in Swift search engine and stores all index state in process memory.
- SQLite adapter: A persisted adapter that uses the built-in Swift search engine and stores index state in a SearchFn-owned on-disk SQLite store.
- Index key: The caller-provided stable logical identifier for a persisted search index instance.
- Resource: A logical document collection, equivalent to SearchFn resource names and DataFn resource names.
- Searchable field: A string field whose contents are indexed for full-text search.
- Config digest: A deterministic digest of adapter-relevant configuration such as resource definitions, pipeline options, and defaults.
- Derived index: An index that can be fully rebuilt from an authoritative source dataset and therefore is not itself the system of record.

# Goals / Non-goals
## Goals
- `searchfn/swift/` MUST provide a reusable Swift search runtime that does not require DataFn.
- The Swift runtime MUST preserve the current SearchFn layering: engine, adapter contracts, adapters, client, and convenience API.
- The Swift runtime MUST support both ephemeral in-memory search and durable on-disk search.
- The persisted on-disk search implementation MUST use a SearchFn-owned index format and MUST NOT require Core Data.
- The Swift runtime MUST mirror the current TypeScript contract semantics for:
  - `initialize`
  - `index`
  - `search`
  - `searchAll`
  - `remove`
  - `clear`
  - `dispose`
  - defaults application
  - validation limits
  - deterministic ordering
- The Swift runtime MUST be designed so a companion DataFn integration layer can consume it without modifying its core engine design.
- The Swift package MUST expose both low-level composable layers and a high-level app-facing API.

## Non-goals
- A Swift HTTP server, REST API, or service runtime is out of scope.
- Semantic/vector search is out of scope.
- CloudKit synchronization of the search index is out of scope.
- Core Data as the primary search index backend is out of scope.
- Automatic filesystem root discovery such as Application Support lookup is out of scope; callers supply root paths explicitly.
- Stored non-indexed document payload retrieval, worker snapshot transport, and legacy browser-only APIs are undefined unless later specified.

# Public API
## Package layout
The implementation MUST introduce `searchfn/swift/Package.swift` with these library products:

- `SearchFnCore`
- `SearchFnAdapterContracts`
- `SearchFnMemoryAdapter`
- `SearchFnSQLiteAdapter`
- `SearchFnClient`
- `SearchFnConvenience`

`SearchFnCore`, `SearchFnAdapterContracts`, `SearchFnMemoryAdapter`, `SearchFnSQLiteAdapter`, and `SearchFnClient` MUST avoid Apple-only frameworks. `SearchFnConvenience` MAY use Foundation, but MUST remain free of Core Data, SwiftUI, CloudKit, and WebKit.

## Swift types
```swift
public struct SearchFnDocument: Sendable, Equatable, Codable {
    public let id: String
    public let fields: [String: String]
}

public struct SearchFnIndexParams: Sendable, Equatable {
    public let resource: String
    public let documents: [SearchFnDocument]
}

public struct SearchFnSearchParams: Sendable, Equatable {
    public let resource: String
    public let query: String
    public let fields: [String]?
    public let limit: Int?
    public let fuzzy: SearchFnFuzzyOption?
    public let prefix: Bool?
    public let fieldBoosts: [String: Double]?
}

public struct SearchFnSearchAllParams: Sendable, Equatable {
    public let query: String
    public let resources: [String]?
    public let fields: [String]?
    public let limit: Int?
    public let limitPerResource: Int?
    public let fuzzy: SearchFnFuzzyOption?
    public let prefix: Bool?
    public let fieldBoosts: [String: Double]?
}

public struct SearchFnSearchAllResult: Sendable, Equatable, Codable {
    public let resource: String
    public let id: String
    public let score: Double
}

public enum SearchFnFuzzyOption: Sendable, Equatable, Codable {
    case disabled
    case enabled
    case distance(Int)
}

public struct SearchFnInitializeResourceConfig: Sendable, Equatable, Codable {
    public let name: String
    public let searchFields: [String]
}

public struct SearchFnInitializeParams: Sendable, Equatable, Codable {
    public let resources: [SearchFnInitializeResourceConfig]
}

public struct SearchFnAdapterCapabilities: Sendable, Equatable, Codable {
    public let persistent: Bool?
    public let searchAll: Bool?
    public let fuzzy: Bool?
    public let prefix: Bool?
    public let fieldBoosts: Bool?
    public let maxBatchSize: Int?
}

public struct SearchFnDefaults: Sendable, Equatable, Codable {
    public let limit: Int?
    public let limitPerResource: Int?
    public let fuzzy: SearchFnFuzzyOption?
    public let prefix: Bool?
    public let fieldBoosts: [String: Double]?
}

public struct SearchFnPipelineOptions: Sendable, Equatable, Codable {
    public let language: SearchFnLanguage
    public let enableStemming: Bool
    public let enablePrefixIndexing: Bool
    public let customStopWords: Set<String>?
}

public enum SearchFnLanguage: String, Sendable, Equatable, Codable {
    case english
    case spanish
    case french
}
```

## Adapter contract
```swift
public protocol SearchFnAdapter: Sendable {
    var name: String { get }
    var capabilities: SearchFnAdapterCapabilities? { get }

    func initialize(_ params: SearchFnInitializeParams) async throws
    func index(_ params: SearchFnIndexParams) async throws
    func search(_ params: SearchFnSearchParams) async throws -> [String]
    func searchAll(_ params: SearchFnSearchAllParams) async throws -> [SearchFnSearchAllResult]?
    func remove(resource: String, ids: [String]) async throws
    func clear(resource: String) async throws
    func dispose() async throws
}
```

Implementations that do not natively support `searchAll` MUST expose `capabilities.searchAll = false` and MUST return `nil` from `searchAll`; `SearchFnClient` MUST then provide deterministic fallback behavior.

## Client API
```swift
public protocol SearchFnClientProtocol: Sendable {
    func initialize(_ params: SearchFnInitializeParams) async throws
    func index(_ params: SearchFnIndexParams) async throws
    func search(_ params: SearchFnSearchParams) async throws -> [String]
    func searchAll(_ params: SearchFnSearchAllParams) async throws -> [SearchFnSearchAllResult]
    func remove(resource: String, ids: [String]) async throws
    func clear(resource: String) async throws
    func dispose() async throws
    func adapterInfo() -> (name: String, capabilities: SearchFnAdapterCapabilities?)
}

public struct SearchFnClientConfiguration: Sendable {
    public let adapter: any SearchFnAdapter
    public let defaults: SearchFnDefaults?
}

public func createSearchClient(
    _ configuration: SearchFnClientConfiguration
) -> any SearchFnClientProtocol
```

## Convenience APIs
```swift
public struct SearchFnSQLiteAdapterConfiguration: Sendable, Equatable {
    public let rootURL: URL
    public let indexKey: String
    public let pipeline: SearchFnPipelineOptions?
    public let defaults: SearchFnDefaults?
    public let postingsCacheLimit: Int?
    public let fuzzyCacheLimit: Int?
}

public final class InMemorySearchFn: Sendable {
    public init(
        pipeline: SearchFnPipelineOptions? = nil,
        defaults: SearchFnDefaults? = nil
    )
    public func client() -> any SearchFnClientProtocol
}

public final class SearchFn: Sendable {
    public init(sqlite configuration: SearchFnSQLiteAdapterConfiguration) async throws
    public func client() -> any SearchFnClientProtocol
}
```

# Data formats / protocol
## SQLite index layout
The SQLite adapter MUST persist each logical index beneath the caller-provided root directory using a deterministic path:

```text
<rootURL>/<slug(indexKey)>-<first16(sha256(indexKey))>/
  searchfn.sqlite
  manifest.json
```

`manifest.json` MUST be UTF-8 JSON with this canonical shape:

```json
{
  "format": "searchfn-swift/v1",
  "indexKey": "project-docs",
  "configDigest": "sha256-hex",
  "sqliteSchemaVersion": 1
}
```

The SQLite file and manifest MUST be SearchFn-owned. No Core Data metadata, CloudKit metadata, or application-private business records may be stored there.

## Internal SQLite schema
The adapter MUST use explicit relational tables for at least:
- resources
- documents
- postings
- document lengths
- vocabulary
- metadata

Table names are implementation-defined, but the schema version MUST be tracked in metadata and surfaced via `manifest.json`.

## Error envelope
Thrown errors MUST conform to this shape:

```swift
public struct SearchFnErrorDetails: Sendable, Equatable, Codable {
    public let path: String?
    public let reason: String?
    public let resource: String?
    public let indexKey: String?
}

public struct SearchFnError: Error, Sendable, Equatable, Codable {
    public let code: String
    public let message: String
    public let details: SearchFnErrorDetails?
}
```

# Semantics
## Validation and defaults
- `SearchFnClient` MUST validate inputs before delegating to its adapter.
- `resource` MUST be a non-empty string after trimming.
- `query` MUST be a non-empty string after trimming.
- `limit` MUST be positive and no greater than `10_000`.
- `limitPerResource` MUST be positive and no greater than `1_000`.
- `documents.count` MUST be no greater than `10_000` per `index` call.
- `resources.count` in `searchAll` MUST be no greater than `50`.
- Defaults MUST apply per current TypeScript semantics:
  - request value wins over default
  - default wins over hardcoded built-in
  - hardcoded built-ins are `limit = 10`, `limitPerResource = 10`

## Engine behavior
- The built-in engine MUST tokenize with the same Unicode-aware semantics as current SearchFn.
- Tokens MUST be lowercased before scoring.
- Built-in stop-word sets for English, Spanish, and French MUST be available.
- English stemming MUST be supported when enabled.
- Prefix indexing MUST be supported and MUST score lower than exact term matches.
- Fuzzy matching MUST use edit-distance expansion and MUST reject effective distances greater than `3`.
- Field boosts MUST multiply field contribution weights without changing deterministic tie-break order.

## Indexing
- `index` MUST upsert documents by `(resource, id)`.
- Re-indexing an existing `(resource, id)` MUST replace the previous field content.
- `remove` MUST delete all postings and metadata for the supplied IDs within the supplied resource.
- `clear` MUST delete all index state for the supplied resource without affecting other resources.
- `initialize` MUST declare which resources exist and which search fields are valid for each resource.
- Adapters MAY reject indexing documents for undeclared resources once `initialize` has been called.

## Querying
- `search` MUST return matching document IDs for one resource.
- `searchAll` MUST return `(resource, id, score)` triples.
- When the adapter implements native `searchAll`, `SearchFnClient` MUST still sort returned results deterministically and MUST clamp to effective `limit`.
- When the adapter does not implement native `searchAll`, `SearchFnClient` MUST:
  - require explicit `resources`
  - run per-resource searches
  - assign positional fallback scores
  - sort deterministically by `score desc`, `resource asc`, `id asc`
  - clamp to effective `limit`

## Persistence
- The SQLite adapter MUST reopen previously indexed data across process restarts.
- Search results after reopen MUST be equivalent to results returned before shutdown for the same inputs and configuration.
- The adapter MUST create only directories beneath `rootURL`.
- If `manifest.json` and on-disk SQLite schema versions disagree, the adapter MUST throw a deterministic `SEARCH_INDEX_FORMAT_MISMATCH` error instead of mutating data silently.

# Invariants
- Result ordering MUST be deterministic.
- Query execution MUST be side-effect free.
- `index`, `remove`, and `clear` MUST be idempotent for identical repeated inputs.
- The Swift built-in engine MUST not depend on wall-clock time, randomization, locale-dependent string comparison, or filesystem enumeration order for ranking.
- All persisted file and directory names derived from `indexKey` MUST be deterministic.
- The search runtime MUST remain usable without importing any DataFn target.

# Security
- The package MUST perform no network I/O.
- The package MUST not scan or write outside the caller-provided `rootURL`.
- The package MUST reject empty or path-traversal-like `indexKey` values after normalization.
- Diagnostic output MUST not log indexed field contents by default.
- Errors MAY include resource names, index keys, and validation paths, but MUST NOT include raw document field bodies unless the caller explicitly opts into debug logging.

# Limits/caps
- Maximum query length: `1000`
- Maximum `limit`: `10000`
- Maximum `limitPerResource`: `1000`
- Maximum resources per `searchAll`: `50`
- Maximum documents per `index` batch: `10000`
- Maximum fuzzy distance: `3`
- Maximum directory slug length derived from `indexKey`: `32`

# Observability
The package MUST expose an optional diagnostics sink:

```swift
public enum SearchFnDiagnosticEvent: Sendable, Equatable {
    case indexStarted(resource: String, count: Int)
    case indexCompleted(resource: String, count: Int)
    case searchExecuted(resource: String?, queryLength: Int, resultCount: Int)
    case searchAllFallback(resources: [String])
    case persistenceOpened(indexKey: String)
    case persistenceClosed(indexKey: String)
    case persistenceCleared(indexKey: String, resource: String?)
}
```

The diagnostics sink MUST be opt-in. When disabled, the runtime MUST emit nothing externally.

# Compatibility / versioning strategy
- The Swift adapter/client semantics MUST track the current SearchFn TypeScript contract, not the legacy monolithic browser-only API.
- Package evolution MUST use additive changes where possible.
- Breaking changes to on-disk SQLite format MUST increment `sqliteSchemaVersion`.
- Breaking changes to public Swift symbols MUST require a semver-major package bump.

# Undefined / Explicitly user-deferred only
- HTTP server/API surface
- vector embeddings and semantic search
- CloudKit or Core Data search-index persistence
- automatic Application Support path resolution
- browser worker snapshot import/export compatibility
- non-indexed stored payload retrieval APIs

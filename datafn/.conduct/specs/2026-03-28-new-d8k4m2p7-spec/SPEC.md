# Metadata
- Timestamp: 2026-03-28T05:19:25Z
- agent_name: unknown-agent
- model: GPT-5 Codex
- launcher: Codex Desktop
- workspace: repo root
- OS: Darwin arm64
- shell: zsh
- git: detached HEAD at `50929162a8547f6f55db27bdc51c47289c0bc2af`, dirty `dirty`
- spec_folder: `2026-03-28-new-d8k4m2p7-spec`
- spec_path: `datafn/.conduct/specs/2026-03-28-new-d8k4m2p7-spec`
- spec_type: `new`
- spec_id: `d8k4m2p7`
- input_paths:
  - `datafn/.conduct/specs/2026-03-27-new-t8vzvg1r-spec/SPEC.md`
  - `datafn/core/src/search-provider.ts`
  - `datafn/client/src/client.ts`
  - `datafn/client/src/query.ts`
  - `datafn/client/src/mutate.ts`
  - `datafn/client/src/sync/engine.ts`
  - `datafn/docs/content/docs/documentation/client/setup.mdx`
  - `datafn/examples/todo-app/client/src/lib/datafn.ts`
  - `datafn/swift/Sources/DatafnCoreDataStore/NamespaceStoreLocator.swift`
  - `datafn/swift/README.md`
  - `searchfn/docs/content/docs/architecture.mdx`
  - `searchfn/.conduct/specs/2026-03-28-new-s7k4m2p9-spec/SPEC.md`
  - thread intent: current conversation about native-backed Swift SearchFn integration for DataFn

# Overview
This companion spec integrates a reusable Swift SearchFn runtime into DataFn’s Apple-native topology so local search works across all intended DataFn client modes:

1. browser-owned mode remains unchanged and continues to use JavaScript search providers such as IndexedDB-backed SearchFn
2. native-backed `WKWebView` mode uses a Swift-owned local search backend with no IndexedDB search persistence
3. pure Swift/native UI code can query the same local index directly through the Apple runtime
4. CloudKit mode keeps search derived locally from Core Data records and does not sync the search index itself through CloudKit

This spec does not redesign SearchFn. It adds the DataFn-side contracts, runtime hooks, bridge methods, and example/docs changes required so the companion `searchfn/swift` package can be used as the native search backend.

# Glossary
- Search-enabled resource: A DataFn schema resource whose `indices.search` array is non-empty.
- Native search backend: A Swift runtime object used by `DatafnAppleRuntime` to maintain and query local search state.
- Native-backed search provider: A TypeScript `SearchProvider` created from `@datafn/swift-bridge` that proxies search calls into the Swift host.
- JS-owned search: Existing browser mode where JavaScript owns search provider lifecycle and persistence.
- Native-owned search: Apple-native mode where Swift owns search index lifecycle and persistence.
- Search config digest: A deterministic digest of schema hash plus search-enabled resource names and search fields used to decide whether a native index rebuild is required.
- Search root: The root directory where the native search backend persists its index files.
- Derived local index: A search index rebuilt from Core Data records and never treated as the authoritative store.

# Goals / Non-goals
## Goals
- DataFn MUST add a native search contract in `datafn/swift` so native runtimes can host a local search backend.
- DataFn MUST add a Swift integration target that consumes the companion SearchFn Swift package as a native backend implementation.
- `@datafn/swift-bridge` MUST expose a native-backed `SearchProvider` for `@datafn/client`.
- Native-backed search MUST use the same schema-derived search field source as current JavaScript initialization: `schema.resources[].indices.search`.
- Native-backed `WKWebView` mode MUST not persist search state in IndexedDB.
- Native-backed search MUST be updated by the Swift runtime for local writes, DataFn-server sync, and CloudKit merges.
- Pure Swift/native code MUST be able to issue search queries against the same native search backend used by embedded web content.
- CloudKit mode MUST keep the search index as derived local state rather than syncing the index itself through CloudKit.

## Non-goals
- Browser-owned search architecture changes are out of scope except where regression tests are needed.
- A generic DataFn server-side search redesign is out of scope.
- Syncing the search index through CloudKit is out of scope.
- Using Core Data as the primary search engine/index format is out of scope.
- New schema syntax for search fields is out of scope; existing `indices.search` remains authoritative.

# Public API
## Package layout changes
The implementation MUST extend `datafn/swift/Package.swift` with these library products:

- `DatafnSearchContracts`
- `DatafnSearchFnBackend`

The `DatafnSearchFnBackend` product MUST depend on the companion `searchfn/swift` package and MUST not reimplement search engine semantics inside `datafn/swift`.

## TypeScript API
### `@datafn/swift-bridge`
```typescript
export interface DatafnNativeBackedSearchProvider extends SearchProvider {
  readonly __datafnNativeBacked: true;
}

export function createNativeBackedSearchProvider(
  bus: DatafnBridgeBus
): DatafnNativeBackedSearchProvider;
```

The returned provider MUST implement:
- `initialize`
- `search`
- `searchAll`
- `updateIndices`
- `dispose`

`updateIndices` on the native-backed provider MUST be a compatibility no-op that resolves successfully. Native indexing ownership lives in Swift; the JavaScript client MUST skip redundant update calls when the provider is marked native-backed.

### Bridge protocol additions
`DatafnBridgeMethod` MUST add:
- `search.initialize`
- `search.search`
- `search.searchAll`
- `search.dispose`

Canonical request envelope:
```json
{
  "protocol": "datafn-bridge/v1",
  "id": "req-1",
  "method": "search.search",
  "payload": {
    "resource": "todos",
    "query": "milk",
    "fields": ["text"],
    "limit": 10,
    "prefix": true,
    "fuzzy": 1,
    "fieldBoosts": { "text": 2 }
  }
}
```

Canonical success response envelope:
```json
{
  "protocol": "datafn-bridge/v1",
  "id": "req-1",
  "ok": true,
  "result": {
    "ids": ["td-1", "td-5"]
  }
}
```

Canonical `searchAll` success response envelope:
```json
{
  "protocol": "datafn-bridge/v1",
  "id": "req-2",
  "ok": true,
  "result": {
    "results": [
      { "resource": "todos", "id": "td-1", "score": 12.5 }
    ]
  }
}
```

## Swift contracts
```swift
public struct DatafnSearchResourceConfig: Sendable, Equatable, Codable {
    public let name: String
    public let searchFields: [String]
}

public struct DatafnSearchRequest: Sendable, Equatable, Codable {
    public let resource: String
    public let query: String
    public let fields: [String]?
    public let limit: Int?
    public let prefix: Bool?
    public let fuzzy: Int?
    public let fieldBoosts: [String: Double]?
}

public struct DatafnSearchAllRequest: Sendable, Equatable, Codable {
    public let query: String
    public let resources: [String]?
    public let fields: [String]?
    public let limit: Int?
    public let limitPerResource: Int?
    public let prefix: Bool?
    public let fuzzy: Int?
    public let fieldBoosts: [String: Double]?
}

public struct DatafnSearchAllResult: Sendable, Equatable, Codable {
    public let resource: String
    public let id: String
    public let score: Double
}

public enum DatafnSearchIndexOperation: String, Sendable, Codable {
    case upsert
    case delete
}

public struct DatafnSearchIndexRecord: Sendable, Equatable, Codable {
    public let id: String
    public let fields: [String: String]
}

public struct DatafnSearchIndexUpdate: Sendable, Equatable, Codable {
    public let resource: String
    public let operation: DatafnSearchIndexOperation
    public let records: [DatafnSearchIndexRecord]
}

public struct DatafnSearchBackendContext: Sendable, Equatable {
    public let namespace: String
    public let schemaHash: String
    public let remoteMode: DatafnNativeRemoteMode
    public let searchRootURL: URL
    public let resources: [DatafnSearchResourceConfig]
}

public protocol DatafnNativeSearchBackend: Sendable {
    func initialize(resources: [DatafnSearchResourceConfig]) async throws
    func search(_ request: DatafnSearchRequest) async throws -> [String]
    func searchAll(_ request: DatafnSearchAllRequest) async throws -> [DatafnSearchAllResult]
    func apply(_ update: DatafnSearchIndexUpdate) async throws
    func clearAll() async throws
    func dispose() async throws
}

public protocol DatafnNativeSearchBackendFactory: Sendable {
    func makeBackend(
        context: DatafnSearchBackendContext
    ) async throws -> any DatafnNativeSearchBackend
}

public struct DatafnSearchConfiguration: Sendable {
    public let backendFactory: any DatafnNativeSearchBackendFactory
    public let searchRootURL: URL?
    public let failIfUnavailable: Bool
}
```

### Apple runtime configuration
```swift
public struct DatafnAppleRuntimeConfiguration: Sendable {
    public let schemaJSON: Data
    public let schemaHash: String
    public let namespace: String
    public let clientID: String
    public let storeRootURL: URL
    public let syncBackend: DatafnSyncBackendConfiguration
    public let search: DatafnSearchConfiguration?
}
```

### Apple runtime direct API
```swift
public actor DatafnAppleRuntime {
    public func search(_ request: DatafnSearchRequest) async throws -> [String]
    public func searchAll(_ request: DatafnSearchAllRequest) async throws -> [DatafnSearchAllResult]
}
```

### Companion integration target
`DatafnSearchFnBackend` MUST expose a factory:

```swift
public struct DatafnSearchFnBackendFactory: DatafnNativeSearchBackendFactory {
    public init(
        pipeline: SearchFnPipelineOptions? = nil,
        defaults: SearchFnDefaults? = nil
    )
}
```

This factory MUST build a backend on top of the companion `searchfn/swift` package and MUST persist the native search index beneath the runtime-provided `searchRootURL`.

# Data formats / protocol
## Search resource discovery
The authoritative list of search-enabled resources MUST be derived from the DataFn schema using:
- resource name
- `resource.indices.search`

Resources with an empty or missing `indices.search` list MUST NOT be initialized into the native search backend.

## Native search root
If `DatafnSearchConfiguration.searchRootURL` is nil, the runtime MUST derive:

```text
<namespace support directory>/SearchFn/
```

The namespace support directory is the existing `NamespaceStoreLocation.supportDirectoryURL`.

## Search metadata
The runtime MUST persist search metadata alongside namespace metadata with at least:
- `searchBackendKind`
- `searchSchemaHash`
- `searchConfigDigest`
- `searchStatus`

`searchStatus` MUST be one of:
- `notConfigured`
- `ready`
- `rebuilding`
- `failed`

## Search config digest
The digest input MUST include:
- `schemaHash`
- sorted search-enabled resource names
- sorted `searchFields` for each resource
- backend kind identifier

The digest algorithm MUST be deterministic and stable across launches for unchanged inputs.

# Semantics
## Browser-owned mode
- Browser-owned mode MUST remain unchanged.
- A browser-owned app MAY continue using any JavaScript `SearchProvider`, including IndexedDB-backed SearchFn.
- This spec MUST NOT require browser mode to adopt the Swift bridge.

## Native-backed WebView mode
- A WebView app that wants local search in native-backed mode MUST configure `searchProvider: createNativeBackedSearchProvider(bus)`.
- Native-backed search MUST not create or rely on IndexedDB persistence.
- The native-backed search provider MUST forward `initialize`, `search`, `searchAll`, and `dispose` over the bridge.
- The native-backed search provider’s `updateIndices` MUST resolve without error and MUST NOT own the index lifecycle.
- `@datafn/client` MUST treat `__datafnNativeBacked === true` as authoritative and MUST skip JavaScript-side search index maintenance in:
  - local mutation hooks
  - sync clone indexing
  - sync pull indexing
  - plugin-based provider rebuild/update helpers

## Native runtime ownership
- `DatafnAppleRuntime` MUST initialize the native search backend once at startup if:
  - `configuration.search` is present, and
  - the schema has at least one search-enabled resource
- The runtime MUST keep the native search backend synchronized with Core Data changes caused by:
  - local writes originating from WebView JavaScript
  - local writes originating from native Swift code
  - DataFn-server clone/pull/reconcile cycles
  - CloudKit imports/merges
  - namespace clear/reset flows
- Native search updates MUST convert only the configured search fields into indexable string payloads.

## Rebuild behavior
- On startup, the runtime MUST compare the stored `searchConfigDigest` and `searchSchemaHash` to the current runtime values.
- If either value differs, the runtime MUST:
  - mark `searchStatus = rebuilding`
  - clear the native search backend
  - enumerate all currently stored records for search-enabled resources from Core Data
  - rebuild the search index
  - mark `searchStatus = ready` only after the rebuild succeeds
- If rebuild fails and `failIfUnavailable = true`, runtime startup MUST fail.
- If rebuild fails and `failIfUnavailable = false`, runtime startup MAY continue, but search requests MUST return `NATIVE_SEARCH_UNAVAILABLE` until the backend recovers.

## Query routing
- `client.search()` and DFQL search clauses in native-backed mode MUST route to the native-backed search provider rather than to IndexedDB-backed browser search.
- Pure Swift/native callers using `DatafnAppleRuntime.search` and `searchAll` MUST query the same native backend instance used by bridge requests.
- Result ordering MUST remain deterministic across bridge and direct runtime APIs.

## CloudKit mode
- In `icloud` mode, the authoritative data remains Core Data records replicated by `NSPersistentCloudKitContainer`.
- The search index MUST remain derived local state only.
- CloudKit MUST NOT sync SearchFn index files.
- CloudKit merges/imports MUST still trigger native index updates from the resulting Core Data record changes.

# Invariants
- Search-enabled resource selection is schema-derived, not manually duplicated in JavaScript or Swift host configuration.
- Native-backed mode never silently falls back to IndexedDB for search persistence.
- The native search index is not the system of record; Core Data remains authoritative.
- Search queries are read-only and must not mutate Core Data or index state.
- The native-backed `SearchProvider` marker is authoritative for skipping redundant JavaScript-side indexing work.
- Bridge and direct-runtime search results MUST use the same ordering rules for identical underlying index state.

# Security
- Search bridge requests MUST validate resource names, limits, fuzzy distance, and fieldBoost values before backend execution.
- The runtime MUST not index fields outside the schema-derived `indices.search` list for a resource.
- Diagnostics and errors MUST not expose raw record field bodies by default.
- Search root paths MUST remain beneath the namespace support directory or an explicitly supplied file URL.

# Limits/caps
- Search request validation MUST preserve current DataFn/SearchFn client-side limits:
  - query length `<= 1000`
  - `limit <= 10000`
  - `limitPerResource <= 1000`
  - search-all resources `<= 50`
  - fuzzy distance `1...3` when numeric
- Native-backed `search.initialize` MUST reject duplicate resources after normalization.

# Observability
- The runtime MUST emit bridge/runtime events or structured diagnostics for:
  - search backend initialized
  - search rebuild started
  - search rebuild completed
  - search rebuild failed
  - native search request executed
- These diagnostics MUST include namespace, backend kind, and counts where relevant, but MUST NOT include raw indexed field text by default.

# Compatibility / versioning strategy
- The DataFn TypeScript `SearchProvider` contract remains the JS-facing boundary.
- The new Swift native search contract is DataFn-specific and MAY evolve additively, but must remain backward compatible within a semver-major line.
- The DataFn-side SearchFn backend MUST consume the companion `searchfn/swift` package rather than fork its engine behavior into `datafn`.

# Undefined / Explicitly user-deferred only
- browser-side automatic fallback from native-backed provider to IndexedDB search
- CloudKit replication of search index files
- non-Apple native runtimes
- semantic/vector search integration

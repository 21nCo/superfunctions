# Metadata
- Timestamp: 2026-03-27T07:12:06Z
- agent_name: unknown-agent
- model: GPT-5 Codex
- launcher: Codex desktop
- workspace: repo root
- OS: Darwin arm64
- shell: zsh
- git: detached HEAD at `50929162a8547f6f55db27bdc51c47289c0bc2af`, dirty `clean`
- spec_folder: `2026-03-27-new-t8vzvg1r-spec`
- spec_path: `datafn/.conduct/specs/2026-03-27-new-t8vzvg1r-spec`
- spec_type: `new`
- spec_id: `t8vzvg1r`
- input_paths:
  - `datafn/.conduct/intent/datafn.intent.md`
  - `datafn/.conduct/intent/dfql.intent.md`
  - `datafn/.conduct/intent/spec.md`
  - `datafn/client/README.md`
  - `datafn/server/README.md`
  - `datafn/client/src/client.ts`
  - `datafn/client/src/storage.ts`
  - `datafn/client/src/query.ts`
  - `datafn/client/src/mutate.ts`
  - `datafn/client/src/sync.ts`
  - `datafn/client/src/extension/transport.ts`
  - `datafn/docs/content/docs/reference/client/config.mdx`
  - `datafn/docs/content/docs/reference/client/storage.mdx`
  - `datafn/docs/content/docs/reference/client/transport.mdx`
  - `datafn/docs/content/docs/documentation/storage/custom.mdx`
  - `datafn/docs/content/docs/documentation/storage/indexeddb.mdx`
  - external reference: Nucleus WebView host-message bridge example

# Overview
This spec defines an Apple-native DataFn runtime and a WebView bridge that let one application codebase run in two supported topologies without changing its DataFn authoring model:

1. Browser topology: `@datafn/client` with IndexedDB local persistence and JavaScript-owned DataFn server sync.
2. Embedded Apple topology: `@datafn/client` inside `WKWebView` with Core Data local persistence via bridge, Swift-owned sync and remote persistence, and optional CloudKit-backed personal multi-device sync with no DataFn server.

The spec preserves existing DataFn invariants:
- schema-driven runtime behavior
- typed SDKs as the primary authoring surface
- DFQL as the canonical wire and execution envelope
- local-first semantics
- deterministic ordering, idempotency, and namespace isolation

The Apple feature set is not a SwiftUI-only client. It is a native Swift runtime with a thin SwiftUI binding layer, plus a TypeScript bridge package for embedded WebView applications.

# Glossary
- Browser-owned mode: A DataFn client topology where JavaScript owns local persistence, query routing, and sync lifecycle.
- Native-backed mode: A DataFn client topology where JavaScript still uses `@datafn/client`, but local persistence is bridged to Swift/Core Data and sync ownership moves to Swift.
- Native sync owner: The Swift runtime that owns remote transport, background sync scheduling, CloudKit participation, and auth when `sync.owner = "native"`.
- Bridge bus: The request/response/event message channel between WebView JavaScript and the Swift host.
- Bridge protocol: The canonical JSON envelope contract carried across the bridge bus.
- Remote mode: The Swift-owned remote persistence backend for native-backed mode. Valid values are `datafn-server` and `icloud`.
- Core Data store: The canonical native local store that persists records, join rows, metadata, hydration state, cursors, key-value data, and changelog entries.
- CloudKit mode: Native-backed mode where Swift uses `NSPersistentCloudKitContainer` private database syncing and does not use a DataFn server.
- Namespace: The DataFn isolation key used to separate tenants, users, and store instances.
- Remote-only resource: A schema resource marked `isRemoteOnly` that is not cloned into local storage.
- Hydration state: Per-resource state `notStarted | hydrating | ready` that determines local-vs-remote query routing.

# Goals / Non-goals
## Goals
- DataFn MUST support a first-class Apple-native runtime under `datafn/swift/`.
- DataFn MUST support a TypeScript bridge package under `datafn/swift-bridge/` for `WKWebView` applications.
- The same web application code MUST be able to select browser-owned mode or native-backed mode through configuration.
- Native-backed mode MUST disable DataFn IndexedDB persistence for the affected client instance.
- Native-backed mode MUST preserve DataFn local-first semantics using Core Data as the local store.
- Native-backed mode MUST allow Swift to own DataFn-server sync for embedded apps.
- Native-backed mode MUST allow Swift to own CloudKit private-database sync for personal multi-device apps without a DataFn server.
- SwiftUI support MUST exist as a thin binding layer over the native runtime and the same Core Data store.

## Non-goals
- Android, React Native, and non-Apple native runtimes are out of scope.
- SwiftData-specific APIs are out of scope; Core Data is the required persistence layer.
- CloudKit shared database and public database modes are out of scope.
- Generated Swift entity/type source code is out of scope; runtime schema loading and runtime Core Data model generation are required instead.
- Silent fallback from native-backed mode to IndexedDB is out of scope and forbidden.
- Running DataFn server sync and CloudKit sync simultaneously against the same namespace store is out of scope and forbidden.

# Public API
## Package layout
- `datafn/swift/`
  - Swift Package Manager package.
  - Library products:
    - `DatafnAppleRuntime`
    - `DatafnCoreDataStore`
    - `DatafnWebViewBridgeHost`
    - `DatafnSwiftUI`
- `datafn/swift-bridge/`
  - npm package name: `@datafn/swift-bridge`
- `@datafn/client`
  - extended to understand `sync.owner = "native"` and a native sync controller.

## TypeScript API
### `@datafn/client`
```typescript
export type DatafnSyncOwner = "javascript" | "native";
export type DatafnNativeRemoteMode = "datafn-server" | "icloud";

export interface DatafnNativeSyncController {
  handshake(payload: DatafnNativeHandshakeRequest): Promise<DatafnEnvelope<DatafnNativeHandshakeResult>>;
  start(): Promise<void>;
  stop(): Promise<void>;
  pullNow(): Promise<void>;
  cloneNow(): Promise<void>;
  reconcileNow(): Promise<void>;
  schedulePush(): Promise<void>;
  onEvent(handler: (event: DatafnBridgeEventEnvelope) => void): () => void;
}

export interface DatafnNativeSyncConfig {
  syncController: DatafnNativeSyncController;
  remoteMode: DatafnNativeRemoteMode;
  failIfUnavailable?: boolean; // default true
  expectedSchemaHash?: string;
  remoteProfile?: string;
}

export interface DatafnSyncConfig {
  mode?: "sync" | "local-only";
  owner?: DatafnSyncOwner; // default "javascript"
  native?: DatafnNativeSyncConfig;
  remote?: string;
  remoteAdapter?: DatafnRemoteAdapter;
  ws?: boolean;
  wsUrl?: string;
  offlinability?: boolean;
  pushInterval?: number;
  pushBatchSize?: number;
  pushMaxRetries?: number;
  pushRetryBackoff?: {
    baseDelayMs?: number;
    maxDelayMs?: number;
    multiplier?: number;
    jitterMs?: number;
  };
  pushIntervalBackoff?: {
    baseMultiplier?: number;
    maxDelayMs?: number;
    jitterMs?: number;
  };
  hydration?: {
    bootResources?: string[];
    backgroundResources?: string[];
    clonePageSize?: number | Record<string, number>;
  };
  wsReconnect?: {
    enabled?: boolean;
    baseDelayMs?: number;
    maxDelayMs?: number;
    multiplier?: number;
    jitterMs?: number;
  };
  pullBatchSize?: number;
  maxPullIterations?: number;
  crossTab?: boolean;
}
```

### `@datafn/swift-bridge`
```typescript
export type DatafnBridgeMethod =
  | "handshake"
  | "storage.getRecord"
  | "storage.listRecords"
  | "storage.upsertRecord"
  | "storage.deleteRecord"
  | "storage.mergeRecord"
  | "storage.findRecords"
  | "storage.listJoinRows"
  | "storage.getJoinRows"
  | "storage.getJoinRowsInverse"
  | "storage.upsertJoinRow"
  | "storage.setJoinRows"
  | "storage.deleteJoinRow"
  | "storage.getCursor"
  | "storage.setCursor"
  | "storage.getHydrationState"
  | "storage.setHydrationState"
  | "storage.changelogAppend"
  | "storage.changelogList"
  | "storage.changelogAck"
  | "storage.countRecords"
  | "storage.countJoinRows"
  | "storage.clearAll"
  | "storage.close"
  | "storage.healthCheck"
  | "remote.query"
  | "remote.mutation"
  | "remote.transact"
  | "remote.seed"
  | "remote.clone"
  | "remote.pull"
  | "remote.push"
  | "remote.reconcile"
  | "sync.start"
  | "sync.stop"
  | "sync.pullNow"
  | "sync.cloneNow"
  | "sync.reconcileNow"
  | "sync.schedulePush"
  | "health.check";

export interface DatafnBridgeRequestEnvelope {
  protocol: "datafn-bridge/v1";
  id: string;
  method: DatafnBridgeMethod;
  payload?: unknown;
}

export type DatafnBridgeResponseEnvelope =
  | {
      protocol: "datafn-bridge/v1";
      id: string;
      ok: true;
      result: unknown;
    }
  | {
      protocol: "datafn-bridge/v1";
      id: string;
      ok: false;
      error: DatafnError;
    };

export interface DatafnBridgeEventEnvelope {
  protocol: "datafn-bridge/v1";
  event:
    | "bridge.ready"
    | "bridge.closed"
    | "storage.changed"
    | "hydration.changed"
    | "mutation.applied"
    | "mutation.rejected"
    | "sync.status"
    | "sync.failed"
    | "health.changed";
  payload: unknown;
}

export interface CreateWKWebViewBridgeBusOptions {
  handlerName?: string; // default "datafn"
  timeoutMs?: number;   // default 30000
}

export interface DatafnBridgeBus {
  request(message: DatafnBridgeRequestEnvelope): Promise<DatafnBridgeResponseEnvelope>;
  subscribe(handler: (event: DatafnBridgeEventEnvelope) => void): () => void;
}

export function createWKWebViewBridgeBus(options?: CreateWKWebViewBridgeBusOptions): DatafnBridgeBus;
export function createNativeBackedStorageAdapter(bus: DatafnBridgeBus): DatafnStorageAdapter;
export function createNativeBackedRemoteAdapter(bus: DatafnBridgeBus): DatafnRemoteAdapter;
export function createNativeSyncController(bus: DatafnBridgeBus): DatafnNativeSyncController;
```

### Canonical TypeScript configurations
#### Browser-owned mode
```typescript
const client = createDatafnClient({
  schema,
  clientId,
  namespace,
  storage: IndexedDbStorageAdapter.create({ dbName: "app", schema }),
  sync: {
    owner: "javascript",
    mode: "sync",
    offlinability: true,
    remote: "https://api.example.com/datafn",
    ws: true,
  },
});
```

#### Native-backed mode with DataFn server
```typescript
const bus = createWKWebViewBridgeBus();

const client = createDatafnClient({
  schema,
  clientId,
  namespace,
  storage: createNativeBackedStorageAdapter(bus),
  sync: {
    owner: "native",
    mode: "sync",
    offlinability: true,
    remoteAdapter: createNativeBackedRemoteAdapter(bus),
    native: {
      syncController: createNativeSyncController(bus),
      remoteMode: "datafn-server",
      expectedSchemaHash,
      failIfUnavailable: true,
      remoteProfile: "default",
    },
  },
});
```

#### Native-backed mode with CloudKit
```typescript
const bus = createWKWebViewBridgeBus();

const client = createDatafnClient({
  schema,
  clientId,
  namespace,
  storage: createNativeBackedStorageAdapter(bus),
  sync: {
    owner: "native",
    mode: "sync",
    offlinability: true,
    remoteAdapter: createNativeBackedRemoteAdapter(bus),
    native: {
      syncController: createNativeSyncController(bus),
      remoteMode: "icloud",
      expectedSchemaHash,
      failIfUnavailable: true,
    },
  },
});
```

## Swift API
```swift
public enum DatafnNativeRemoteMode: String, Codable, Sendable {
  case datafnServer = "datafn-server"
  case iCloud = "icloud"
}

public struct DatafnServerSyncConfiguration: Sendable {
  public let baseURL: URL
  public let websocketURL: URL?
  public let profileID: String
  public let auth: DatafnAuthConfiguration?
}

public struct DatafnCloudKitConfiguration: Sendable {
  public let containerIdentifier: String
  public let databaseScope: DatafnCloudKitDatabaseScope // MUST be .privateDatabase in this spec
}

public enum DatafnCloudKitDatabaseScope: String, Codable, Sendable {
  case privateDatabase = "private"
}

public enum DatafnSyncBackendConfiguration: Sendable {
  case datafnServer(DatafnServerSyncConfiguration)
  case iCloud(DatafnCloudKitConfiguration)
}

public struct DatafnAppleRuntimeConfiguration: Sendable {
  public let schemaJSON: Data
  public let schemaHash: String
  public let namespace: String
  public let clientID: String
  public let storeRootURL: URL
  public let syncBackend: DatafnSyncBackendConfiguration
}

public actor DatafnAppleRuntime {
  public init(configuration: DatafnAppleRuntimeConfiguration) async throws
  public func start() async throws
  public func stop() async
  public func healthCheck() async -> DatafnNativeHealthReport
  public func makeBridgeHost(handlerName: String) -> DatafnWKWebViewBridgeHost
}

public final class DatafnWKWebViewBridgeHost: NSObject, WKScriptMessageHandler {
  public func attach(to userContentController: WKUserContentController)
  public func detach(from userContentController: WKUserContentController)
}
```

## SwiftUI API
```swift
@Observable
public final class DatafnObservedQuery<Value: Sendable> {
  public private(set) var value: Value
  public private(set) var isLoading: Bool
  public private(set) var lastError: DatafnError?
}
```

# Data formats / protocol
## Canonical bridge handshake
```json
{
  "protocol": "datafn-bridge/v1",
  "id": "req-1",
  "method": "handshake",
  "payload": {
    "schemaHash": "abc123",
    "namespace": "org-1:user-1",
    "clientId": "device-1",
    "remoteMode": "datafn-server",
    "remoteProfile": "default"
  }
}
```

Successful handshake result:
```json
{
  "protocol": "datafn-bridge/v1",
  "id": "req-1",
  "ok": true,
  "result": {
    "bridgeVersion": 1,
    "schemaHash": "abc123",
    "namespace": "org-1:user-1",
    "storageBackend": "coredata",
    "syncOwner": "native",
    "remoteMode": "datafn-server",
    "indexedDbDisabled": true,
    "cloudKitPrivateOnly": true,
    "capabilities": [
      "storage",
      "remote",
      "sync",
      "events",
      "health"
    ]
  }
}
```

Failure result:
```json
{
  "protocol": "datafn-bridge/v1",
  "id": "req-1",
  "ok": false,
  "error": {
    "code": "BRIDGE_PROTOCOL_MISMATCH",
    "message": "Bridge protocol version mismatch",
    "details": { "path": "handshake.protocol" }
  }
}
```

## New error codes
The following error codes are added to `@datafn/core`:
- `BRIDGE_UNAVAILABLE`
- `BRIDGE_PROTOCOL_MISMATCH`
- `BRIDGE_METHOD_UNSUPPORTED`
- `NATIVE_SYNC_CONFLICT`
- `ICLOUD_UNAVAILABLE`

## Health report
```json
{
  "ok": true,
  "result": {
    "mode": "native",
    "storageBackend": "coredata",
    "syncOwner": "native",
    "remoteMode": "icloud",
    "issues": []
  }
}
```

# Semantics
## 1. Mode resolution
- `sync.owner` defaults to `javascript`.
- `sync.owner = "native"` requires:
  - `storage` to be a native-backed adapter
  - `sync.native` to be present
  - `sync.remoteAdapter` to be a native-backed remote adapter
  - `sync.offlinability = true`
- `sync.owner = "native"` forbids direct JavaScript network ownership. `sync.remote` MUST be absent.
- `sync.owner = "native"` with `sync.native.remoteMode = "icloud"` still uses `sync.mode = "sync"` because CloudKit is a native remote persistence backend. It MUST NOT use JavaScript `local-only` semantics unless the caller explicitly disables remote synchronization entirely.

## 2. Browser-owned mode
- JavaScript uses IndexedDB or Memory storage.
- JavaScript owns the SyncEngine and direct DataFn remote transport.
- Existing DataFn semantics remain unchanged.

## 3. Native-backed mode
- JavaScript uses `@datafn/client`, but local storage requests resolve through the bridge to Core Data.
- Swift owns remote transport, background sync, CloudKit participation, auth, and health reporting.
- JavaScript `client.sync.start()`, `stop()`, `pullNow()`, `cloneNow()`, and `reconcileNow()` delegate to the native sync controller.
- JavaScript local-first mutation flows continue to write changelog entries, cursors, hydration state, and optimistic records into the bridged Core Data store.
- `schedulePush()` MUST notify Swift to process changelog work against the same Core Data namespace store.

## 4. Query routing
- Ready resources MUST query locally through the bridged storage adapter.
- Hydrating resources MUST use the native-backed remote adapter so browser and embedded routing semantics stay equivalent.
- Remote-only resources MUST use the native-backed remote adapter in `datafn-server` mode.
- Remote-only resources MUST fail with `DFQL_UNSUPPORTED` in `icloud` mode because no DataFn server exists in that topology.
- Batch queries MUST continue to use the remote adapter. In `icloud` mode, the native-backed remote adapter MUST execute batch queries against the native runtime rather than a network server.

## 5. Mutation routing
- When `offlinability = true` and the target resource is `ready`, mutations MUST apply locally first to the bridged Core Data store and changelog.
- The bridged store MUST preserve DataFn optimistic update semantics, search indexing update hooks, and mutation event emission.
- When a mutation cannot be satisfied locally because the resource is not ready or is remote-only, the native-backed remote adapter MUST handle it.
- JavaScript MUST NOT write the same mutation to IndexedDB in native-backed mode.

## 6. Transaction routing
- `client.transact()` MUST remain available in browser-owned and native-backed modes.
- In native-backed `datafn-server` mode, transactions MUST be executed by the native-backed remote adapter.
- In native-backed `icloud` mode, transactions MUST be executed by the native runtime against the Core Data store; steps that require remote-only resources MUST fail explicitly.

## 7. Core Data store mapping
- The Swift runtime MUST generate the Core Data model at runtime from the DataFn schema.
- The runtime MUST represent:
  - resource records
  - many-many join rows
  - built-in key-value records
  - hydration state
  - cursors
  - changelog entries
  - namespace metadata
- `mergeRecord` MUST be atomic.
- `changelogAppend` MUST deduplicate by `(clientId, mutationId)`.
- `listRecords` MUST return records ordered by `id` ascending.
- `listJoinRows` MUST return rows ordered by `(from, to)` ascending.

## 8. Namespace isolation
- Every namespace MUST map to an isolated Core Data store file set and change-tracking domain.
- SwiftUI views and WebView clients that share a namespace MUST observe the same Core Data store.
- Browser-owned IndexedDB databases and native-backed Core Data stores MUST remain isolated from one another even when the namespace string matches.

## 9. Native DataFn-server mode
- Swift MUST read changelog entries from Core Data and use DataFn server `seed`, `clone`, `pull`, `push`, `reconcile`, and query/mutation/transact endpoints as needed.
- Swift MUST support auth configuration parity with browser/server usage:
  - bearer token provider
  - static headers
  - request interceptor
  - WebSocket auth attachment
- Swift MUST emit sync and storage events back through the bridge using canonical DataFn event shapes where possible.

## 10. Native CloudKit mode
- Swift MUST use `NSPersistentCloudKitContainer`.
- Database scope MUST be private database only.
- No DataFn server endpoints are used in this mode.
- CloudKit import/export activity MUST update the same Core Data store observed by SwiftUI and WebView.
- DataFn server sync metadata such as server cursors and WebSocket connectivity MUST NOT be fabricated in this mode.
- CloudKit mode is for personal multi-device synchronization only.

## 11. Same-store exclusivity
- A namespace store MUST have exactly one remote sync backend:
  - DataFn server
  - CloudKit
  - none
- The runtime MUST reject attempts to enable DataFn server and CloudKit on the same namespace store with `NATIVE_SYNC_CONFLICT`.

## 12. Bridge lifecycle
- The bridge MUST handshake before the client performs native-backed storage or sync work.
- If the bridge is unavailable and `failIfUnavailable` is true, the client MUST fail during initialization with `BRIDGE_UNAVAILABLE`.
- If the bridge closes after initialization, the client MUST emit a fatal health issue and reject further sync control operations.

# Invariants
- Native-backed mode MUST NOT create, read, or write DataFn IndexedDB persistence for that client instance.
- The authoritative local store in native-backed mode MUST be Core Data, not duplicated browser storage.
- The authoritative sync owner in native-backed mode MUST be Swift, not the JavaScript SyncEngine.
- Query results for a stable underlying store and identical input MUST remain deterministic across browser-owned and native-backed modes.
- Local changelog ordering MUST remain monotonic within a namespace store.
- Schema hash mismatches between JavaScript and Swift MUST fail fast.
- CloudKit mode MUST NOT masquerade as DataFn server sync; backend-specific health/status MUST be truthful.
- Secrets and auth headers MUST NOT be emitted in bridge events, client events, or logs.

# Security
- The bridge host MUST accept only the canonical method whitelist defined in this spec.
- The bridge host MUST reject non-JSON payloads and unknown methods with `BRIDGE_METHOD_UNSUPPORTED`.
- The bridge host MUST validate namespace, schema hash, and remote mode during handshake.
- Native-backed mode MUST allow native-only auth configuration so tokens can remain outside WebView JavaScript when desired.
- Logs MUST redact auth headers, bearer tokens, CloudKit container identifiers beyond the configured identifier string, and record payload bodies by default.

# Limits/caps
- Supported verified platforms: iOS 17+, iPadOS 17+, macOS 14+.
- `visionOS` MAY be compatible-by-design, but is not a separately verified target in this spec.
- Default bridge request timeout: 30000 ms.
- Maximum in-flight bridge requests per WebView instance: 256.
- Default maximum bridge payload size: 1 MiB before chunking or rejection.
- CloudKit mode is limited to private database only.
- One namespace store may bind to one sync backend at a time.

# Observability
- Native-backed mode MUST expose:
  - bridge readiness
  - storage backend type
  - sync owner
  - remote mode
  - health issues
  - last sync success/failure
  - CloudKit availability in `icloud` mode
- The Swift runtime MUST emit `storage.changed`, `hydration.changed`, `sync.status`, and `sync.failed` events through the bridge.
- `healthCheck()` MUST aggregate bridge, Core Data, and backend-specific issues.
- Observability MUST prefer stable envelope shapes and machine-readable codes.

# Compatibility / versioning strategy
- Bridge protocol version is `datafn-bridge/v1`.
- Additive bridge methods MAY be introduced within v1.
- Removing or changing a request/response shape requires `v2`.
- Native-backed mode MUST be backward-compatible with existing browser-owned mode semantics.
- Existing non-Apple consumers of `@datafn/client` MUST not need to import `@datafn/swift-bridge`.
- The Swift package MUST depend on runtime schema JSON rather than generated Swift source to preserve schema portability.

# Undefined / Explicitly user-deferred only
- Swift source code generation from DataFn schema is Undefined and not required.
- CloudKit shared database and public database behavior is Undefined and not required.
- Android, React Native, watchOS, and tvOS support are Undefined and not required.
- Mixing DataFn server sync and CloudKit sync on the same namespace store is Undefined and not required beyond explicit rejection.

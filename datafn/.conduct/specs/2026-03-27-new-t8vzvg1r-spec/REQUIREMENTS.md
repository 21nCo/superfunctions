# Requirement Index
- PKG-001
- API-001
- API-002
- API-003
- BRG-001
- STO-001
- STO-002
- QRY-001
- REM-001
- MUT-001
- SYN-001
- SYN-002
- CLD-001
- CLD-002
- SWUI-001
- AUTH-001
- SEC-001
- EVT-001
- OBS-001
- COMP-001

## PKG-001
- ID: PKG-001
- Priority: P0
- Statement: The implementation MUST add `datafn/swift/` as a Swift Package Manager package and `datafn/swift-bridge/` as an npm workspace package without creating a nested monorepo.
- Rationale: The feature spans Swift and TypeScript, but it still has to fit the existing repository structure cleanly.
- Acceptance criteria:
  - `datafn/swift/Package.swift` exists and defines the Swift products in this spec.
  - `datafn/swift-bridge/package.json` exists and is addressable through the existing `datafn/*` workspace rule.
  - No nested workspace or monorepo root is introduced under `datafn/swift/`.
  - The package layout matches the architecture described in `PLAN.md`.
- Test vectors: TV-PKG-001
- Notes: The Swift package is not an npm workspace package; the TypeScript bridge package is.

## API-001
- ID: API-001
- Priority: P0
- Statement: `@datafn/client` MUST support `sync.owner = "native"` with a validated native sync config while preserving current browser-owned configuration semantics.
- Rationale: The same app code needs an explicit switch between browser-owned and native-backed modes.
- Acceptance criteria:
  - `sync.owner` defaults to `javascript`.
  - `sync.owner = "native"` validates required native config fields.
  - `sync.owner = "native"` rejects direct JavaScript network ownership configuration.
  - Browser-owned mode remains valid with IndexedDB and direct `remote` configuration.
- Test vectors: TV-API-001, TV-API-002, TV-API-003
- Notes: `sync.owner = "native"` is a mode switch, not a best-effort hint.

## API-002
- ID: API-002
- Priority: P0
- Statement: `@datafn/swift-bridge` MUST provide concrete bridge bus, native-backed storage adapter, native-backed remote adapter, and native sync controller implementations for `WKWebView`.
- Rationale: The embedded web app needs official bridge primitives rather than custom app-specific glue.
- Acceptance criteria:
  - The package exports the public functions defined in `SPEC.md`.
  - The default bus implementation uses `WKWebView` message-handler transport.
  - The storage adapter implements the full `DatafnStorageAdapter` contract.
  - The sync controller exposes the full native sync lifecycle contract.
- Test vectors: TV-API-002, TV-BRG-001, TV-STO-001, TV-SYN-001
- Notes: The package MAY expose additional helpers, but these exports are mandatory.

## API-003
- ID: API-003
- Priority: P0
- Statement: `datafn/swift/` MUST expose a native runtime, Core Data store, WebView bridge host, and SwiftUI binding targets that load schema at runtime.
- Rationale: The Swift side is a runtime layer, not a generated-code-only layer.
- Acceptance criteria:
  - `DatafnAppleRuntime`, `DatafnCoreDataStore`, `DatafnWebViewBridgeHost`, and `DatafnSwiftUI` products exist.
  - Runtime initialization accepts schema JSON and schema hash.
  - Core Data model generation is runtime-driven.
  - No generated Swift record/entity source is required for correctness.
- Test vectors: TV-PKG-001, TV-API-003, TV-SWUI-001
- Notes: Generated Swift source may be added later, but this spec does not require it.

## BRG-001
- ID: BRG-001
- Priority: P0
- Statement: The WebView bridge MUST use the canonical `datafn-bridge/v1` request, response, and event envelopes with handshake, schema-hash validation, and version negotiation.
- Rationale: The bridge becomes a protocol boundary shared by the TypeScript client and the Swift host.
- Acceptance criteria:
  - All bridge requests include protocol version, request id, method, and payload.
  - All responses are envelope-shaped with `ok: true` or `ok: false`.
  - Handshake validates protocol version, namespace, remote mode, and schema hash.
  - Mismatches fail with stable error codes.
- Test vectors: TV-BRG-001, TV-BRG-002, TV-BRG-003
- Notes: The bridge is JSON-only and MUST NOT accept arbitrary native invocation.

## STO-001
- ID: STO-001
- Priority: P0
- Statement: Native-backed storage MUST implement full DataFn local persistence semantics over Core Data, including records, join rows, key-value data, cursors, hydration state, changelog, counts, lifecycle, and health checks.
- Rationale: Core Data is replacing IndexedDB for the embedded topology, not narrowing the storage contract.
- Acceptance criteria:
  - The native-backed adapter supports every method on `DatafnStorageAdapter`.
  - The Core Data store includes entities or equivalent mapping for records, joins, kv, meta, and changelog data.
  - `mergeRecord` is atomic.
  - `changelogAppend` deduplicates by `(clientId, mutationId)`.
- Test vectors: TV-STO-001, TV-STO-002
- Notes: The internal entity layout may vary as long as the contract remains correct.

## STO-002
- ID: STO-002
- Priority: P0
- Statement: Native-backed storage MUST preserve namespace isolation and deterministic ordering semantics across browser-owned and native-backed modes.
- Rationale: Namespace isolation and deterministic reads are core DataFn guarantees, not browser-specific details.
- Acceptance criteria:
  - Each namespace maps to an isolated native store instance.
  - Shared namespace between SwiftUI and WebView reads/writes the same native store.
  - `listRecords` returns `id`-ascending order.
  - `listJoinRows` returns `(from, to)` ascending order.
- Test vectors: TV-STO-002, TV-EVT-001
- Notes: Isolation between IndexedDB and Core Data is required even when namespace strings match.

## QRY-001
- ID: QRY-001
- Priority: P0
- Statement: Query routing in native-backed mode MUST preserve ready, hydrating, and remote-fallback semantics by combining the native-backed storage adapter with the native-backed remote adapter.
- Rationale: The embedded topology must behave like DataFn, not like a separate query engine with different routing rules.
- Acceptance criteria:
  - Ready resources query via bridged storage.
  - Hydrating resources route through the native-backed remote adapter.
  - Batch queries continue to use the remote adapter contract.
  - `icloud` mode batch queries are satisfied by the native runtime rather than a DataFn server.
- Test vectors: TV-QRY-001, TV-QRY-002, TV-QRY-003
- Notes: This requirement preserves existing client routing expectations.

## REM-001
- ID: REM-001
- Priority: P0
- Statement: Remote-only resources MUST continue to work in native-backed `datafn-server` mode and MUST fail explicitly in native-backed `icloud` mode.
- Rationale: `isRemoteOnly` has clear meaning when a DataFn server exists, but not when CloudKit is the only remote backend.
- Acceptance criteria:
  - Native-backed `datafn-server` mode routes remote-only resources to the native-backed remote adapter.
  - Native-backed `icloud` mode rejects remote-only resource access with `DFQL_UNSUPPORTED`.
  - The failure path identifies the offending resource.
- Test vectors: TV-QRY-003, TV-QRY-004
- Notes: The rejection is intentional and part of the supported contract.

## MUT-001
- ID: MUT-001
- Priority: P0
- Statement: Local-first mutations in native-backed mode MUST write through Core Data, append changelog entries there, emit DataFn mutation events, and trigger native sync scheduling without touching IndexedDB.
- Rationale: The WebView app still needs local-first mutation behavior even though Swift owns remote synchronization.
- Acceptance criteria:
  - Ready-resource mutations update the native-backed store optimistically.
  - Changelog entries land in the Core Data-backed changelog.
  - Mutation events are emitted in canonical DataFn shapes.
  - Native sync scheduling occurs through the native sync controller.
- Test vectors: TV-MUT-001, TV-MUT-002
- Notes: This requirement is about durable local-first behavior, not direct server mutation ownership.

## SYN-001
- ID: SYN-001
- Priority: P0
- Statement: When `sync.owner = "native"`, the JavaScript client MUST delegate sync lifecycle methods to the native sync controller and MUST NOT start the JavaScript `SyncEngine`.
- Rationale: The embedded topology requires a single sync owner to avoid split-brain state and duplicate remote work.
- Acceptance criteria:
  - `client.sync.start()`, `stop()`, `pullNow()`, `cloneNow()`, and `reconcileNow()` delegate to native.
  - `schedulePush()` is available for local-first mutation flows.
  - JavaScript `SyncEngine` timers, WebSocket handling, and push loops remain inactive in native-backed mode.
  - Browser-owned mode remains unaffected.
- Test vectors: TV-SYN-001, TV-SYN-002, TV-SYN-003
- Notes: The delegation layer may be implemented with a controller rather than a full `SyncEngine`.

## SYN-002
- ID: SYN-002
- Priority: P0
- Statement: Native-backed `datafn-server` mode MUST let Swift own DataFn HTTP and WebSocket synchronization against the same Core Data namespace store used by SwiftUI and WebView clients.
- Rationale: The user explicitly requires the Swift side to own remote persistence and sync in embedded mode.
- Acceptance criteria:
  - Swift reads and writes the same changelog and cursor state used by WebView local-first mutations.
  - Swift handles DataFn `seed`, `clone`, `pull`, `push`, `reconcile`, and real-time update participation.
  - Sync and health events propagate back to the bridge.
  - Remote auth configuration is applied on the Swift side.
- Test vectors: TV-SYN-001, TV-SYN-004, TV-AUTH-001
- Notes: The JS client still retains the canonical public API, but remote ownership is native.

## CLD-001
- ID: CLD-001
- Priority: P0
- Statement: Native-backed `icloud` mode MUST use `NSPersistentCloudKitContainer` private database syncing as the only remote persistence backend for personal multi-device applications that do not use a DataFn server.
- Rationale: This is an explicit user requirement and a distinct supported topology.
- Acceptance criteria:
  - CloudKit mode initializes a private-database-backed persistent container.
  - No DataFn server endpoints are required or contacted.
  - SwiftUI and WebView observe the same Core Data store during CloudKit sync.
  - CloudKit availability and failures surface through health and sync status.
- Test vectors: TV-API-003, TV-CLD-001, TV-CLD-002
- Notes: CloudKit shared/public databases are outside this spec.

## CLD-002
- ID: CLD-002
- Priority: P0
- Statement: A namespace store MUST NOT enable DataFn server sync and CloudKit sync at the same time, and conflicting configuration MUST fail with `NATIVE_SYNC_CONFLICT`.
- Rationale: Two remote sync systems over one authoritative local store would produce ambiguous conflict ownership.
- Acceptance criteria:
  - Store initialization rejects dual-backend configuration for the same namespace store.
  - Health reporting identifies the conflict clearly.
  - Recovery requires separate namespace stores or explicit reconfiguration.
- Test vectors: TV-CLD-002, TV-CLD-003
- Notes: The rejection is a correctness requirement, not an implementation shortcut.

## SWUI-001
- ID: SWUI-001
- Priority: P1
- Statement: The Swift package MUST provide a thin SwiftUI/Observation binding layer over the native runtime and the same Core Data namespace store.
- Rationale: SwiftUI support is required, but UI concerns should stay above the runtime and persistence layers.
- Acceptance criteria:
  - SwiftUI bindings subscribe to the same runtime/store as WebView bridge clients.
  - Binding updates reflect local mutations and remote sync changes.
  - The binding target does not introduce a second persistence or sync layer.
  - Observation-based APIs target the platform baseline in this spec.
- Test vectors: TV-SWUI-001, TV-EVT-001
- Notes: The runtime stays UI-agnostic; the SwiftUI layer is a consumer.

## AUTH-001
- ID: AUTH-001
- Priority: P0
- Statement: Native-backed `datafn-server` mode MUST provide first-class auth configuration parity on the Swift side while allowing credentials to remain outside WebView JavaScript.
- Rationale: Embedded apps often need native-owned secrets and token refresh behavior.
- Acceptance criteria:
  - Swift supports bearer-token providers, static headers, and request interception.
  - WebSocket connections support auth attachment.
  - Auth material is redacted from logs and bridge events.
  - JavaScript-native config can select a remote profile without requiring token material in JS.
- Test vectors: TV-AUTH-001, TV-SEC-001
- Notes: JavaScript-supplied auth MAY still be supported, but native-only credentials are the security baseline.

## SEC-001
- ID: SEC-001
- Priority: P0
- Statement: The bridge host MUST whitelist supported methods, validate handshake inputs, reject arbitrary payload execution, and expose only JSON-serializable envelopes.
- Rationale: The WebView bridge is a privileged native boundary and must be narrow by design.
- Acceptance criteria:
  - Unsupported methods fail with `BRIDGE_METHOD_UNSUPPORTED`.
  - Invalid protocol or schema-hash mismatches fail during handshake.
  - The host never evaluates arbitrary code received from JavaScript.
  - Only documented envelope shapes cross the bridge.
- Test vectors: TV-BRG-002, TV-BRG-003, TV-SEC-001
- Notes: This applies to request/response flow and event delivery.

## EVT-001
- ID: EVT-001
- Priority: P0
- Statement: Native-backed mode MUST propagate canonical storage and sync events back into the JavaScript event bus and SwiftUI observers deterministically.
- Rationale: Local-first UI correctness depends on the same invalidation and status signals regardless of runtime topology.
- Acceptance criteria:
  - Bridge events include deterministic protocol, event name, and payload shape.
  - JavaScript signals/subscriptions refresh from native storage changes.
  - SwiftUI observers refresh from the same native changes.
  - Native-backed mode reuses canonical DataFn event names whenever possible.
- Test vectors: TV-EVT-001, TV-SWUI-001
- Notes: New bridge-specific events are allowed when no canonical DataFn event exists.

## OBS-001
- ID: OBS-001
- Priority: P1
- Statement: Native-backed mode MUST expose health checks, backend status, and redacted diagnostics for bridge, storage, sync, and CloudKit/DataFn-server backends.
- Rationale: The added architecture layers make explicit health reporting necessary for debugging and support.
- Acceptance criteria:
  - A native-backed health report is available through the bridge and the Swift runtime.
  - Reports identify the mode, backend, and active issues.
  - Logs and reports redact record payloads and secrets by default.
  - CloudKit account availability is reported in `icloud` mode.
- Test vectors: TV-OBS-001, TV-CLD-001
- Notes: Observability output MUST be machine-readable.

## COMP-001
- ID: COMP-001
- Priority: P0
- Statement: Browser-owned IndexedDB mode MUST remain supported exactly as today, while native-backed mode MUST fail explicitly rather than silently falling back to IndexedDB when native prerequisites are missing.
- Rationale: The feature adds a new topology; it must not regress the existing one or mask configuration mistakes.
- Acceptance criteria:
  - Browser-owned config still uses IndexedDB and JS-owned sync.
  - Native-backed config with missing bridge fails before persistence starts.
  - No DataFn IndexedDB database is created in native-backed mode.
  - Existing non-Apple consumers of `@datafn/client` remain unaffected.
- Test vectors: TV-API-001, TV-BRG-002, TV-SYN-002
- Notes: Explicit failure is part of the product contract.

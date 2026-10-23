# Phase goal

Implement the native-backed WebView bridge host, native asset registry/preview plumbing, and the `filefn/swift-bridge` JavaScript package.

# In scope / Out of scope

- **In scope**: bridge protocol parity across Swift/TypeScript, `WKWebView` bus/host wiring, handshake validation, native-backed FileFn method dispatch, asset-handle upload delegation, sanitized bridge events, preview URL strategy, and associated tests.
- **Out of scope**: HEIC-specific preprocessing, SwiftUI helper wrappers, and final contract/docs polish.

# Deliverables

- `filefn/swift/Sources/FileFnWebViewBridgeHost/FileFnBridgeProtocol.swift`
- `filefn/swift/Sources/FileFnWebViewBridgeHost/FileFnBridgeDispatcher.swift`
- `filefn/swift/Sources/FileFnWebViewBridgeHost/FileFnBridgeEventEmitter.swift`
- `filefn/swift/Sources/FileFnWebViewBridgeHost/FileFnNativeAssetRegistry.swift`
- `filefn/swift/Sources/FileFnWebViewBridgeHost/FileFnBridgePreviewSchemeHandler.swift`
- `filefn/swift/Sources/FileFnWebViewBridgeHost/FileFnWKWebViewBridgeHost.swift`
- `filefn/swift/Tests/FileFnWebViewBridgeHostTests/FileFnBridgeHostTests.swift`
- `filefn/swift/Tests/FileFnWebViewBridgeHostTests/FileFnBridgeSecurityTests.swift`
- `filefn/swift-bridge/package.json`
- `filefn/swift-bridge/src/index.ts`
- `filefn/swift-bridge/src/protocol.ts`
- `filefn/swift-bridge/src/wkwebviewBus.ts`
- `filefn/swift-bridge/src/nativeBackedClient.ts`
- `filefn/swift-bridge/__tests__/wkwebviewBus.test.ts`
- `filefn/swift-bridge/__tests__/nativeBackedClient.test.ts`

# Requirements covered

- BRIDGE-001
- BRIDGE-002
- SEC-001
- FILE-001
- RENDER-001
- POL-001
- GRANT-001
- SHARE-001
- PROC-001

# Implementation tasks

1. Finalize the canonical `filefn-bridge/v1` method names, event names, request/response envelopes, and bridge error codes in both Swift and TypeScript.
2. Implement the `WKWebView` bridge bus on the JavaScript side with timeout handling, stable error mapping, and event subscription.
3. Implement `FileFnWKWebViewBridgeHost` and `FileFnBridgeDispatcher` so native-backed mode can route read/query/capability methods through the existing `FileFnClient`.
4. Implement `FileFnNativeAssetRegistry` plus opaque asset-handle resolution so native-backed uploads never require raw bridged bytes.
5. Reuse `FileFnForegroundUploader` and `FileFnBackgroundUploader` inside the bridge host for `upload.start`, `upload.status`, and `upload.abort`.
6. Implement a preview URL strategy that yields opaque bridge-local URLs rather than absolute file-system paths.
7. Redact auth headers, upload session tokens, signed URL query strings, and absolute paths from all bridge events and responses before delivery to JavaScript.
8. Add Swift tests for handshake success/failure, method dispatch, native-backed upload event delivery, asset-handle failures, and redaction.
9. Add TypeScript tests for bus behavior, bridge error mapping, fail-fast native-backed mode, and client-facade request/event semantics.

# Verification steps

- `swift test --package-path filefn/swift --filter FileFnBridgeHostTests`
  - Expected outcome: handshake, dispatch, and native-backed upload host tests pass.
- `swift test --package-path filefn/swift --filter FileFnBridgeSecurityTests`
  - Expected outcome: bridge redaction and preview URL safety tests pass.
- `npm --workspace filefn/swift-bridge test`
  - Expected outcome: bridge bus and native-backed client tests pass.

# Stop condition

Report the finalized bridge protocol string, the native asset/preview strategy, the bridge methods now supported, and the exact Swift/TypeScript test commands that passed before starting Phase 06.

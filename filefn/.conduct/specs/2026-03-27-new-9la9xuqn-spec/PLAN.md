# PLAN

## Architecture sketch

- `filefn/swift/Package.swift`
  - Declares `FileFnClient`, `FileFnSwiftUI`, and `FileFnWebViewBridgeHost` library products plus unit/integration test targets.
- `filefn/swift/Sources/FileFnClient`
  - Core transport, envelope decoding, error types, JSON value model, request construction, endpoint methods, and upload orchestration.
- `filefn/swift/Sources/FileFnClient/Models`
  - Codable request/response models for files, versions, artifacts, grants, shares, policies, quota, processing, and uploads.
- `filefn/swift/Sources/FileFnClient/Upload`
  - Foreground uploader, background uploader, chunking/materialization utilities, preprocessor abstractions, HEIC converter, state/secret store protocols and defaults.
- `filefn/swift/Sources/FileFnWebViewBridgeHost`
  - Versioned bridge protocol definitions, `WKWebView` host, dispatcher, event redaction, native asset registry, and native-preview URL plumbing.
- `filefn/swift/Sources/FileFnSwiftUI`
  - Observable upload-state wrapper plus PhotosPicker/file-import loaders that can feed direct uploads or native asset registration.
- `filefn/swift-bridge`
  - TypeScript workspace package exporting the `WKWebView` bridge bus, protocol types/constants, and a native-backed FileFn client facade for JavaScript apps rendered inside `WKWebView`.
- `filefn/swift/Tests`
  - Deterministic unit tests, bridge-host tests, and local integration tests against the existing FileFn demo server.
- `filefn/swift-bridge/__tests__`
  - Deterministic protocol, bus, and native-backed client tests.
- `filefn/server/contracts`
  - Deterministic OpenAPI artifact describing the supported Swift client contract.
- Repo root files
  - `.gitignore` and `package.json` helper scripts/documentation hooks for Swift build/test discoverability.

## Dependency graph

- Phase 00 scaffolding MUST land before any Swift or bridge-package implementation compiles.
- Core envelope/error/config primitives MUST exist before endpoint methods.
- Endpoint models MUST exist before uploaders and SwiftUI helpers.
- Foreground uploader MUST exist before background uploader because background recovery reuses the same part-signing and completion logic.
- Secret/state-store abstractions MUST exist before anonymous-session-token persistence and recovery.
- Native foreground/background uploaders MUST exist before the WebView bridge so native-backed mode can reuse the same upload engine rather than fork it.
- The WebView bridge host MUST exist before WebView-specific docs/examples are declared complete.
- The contract artifact SHOULD be authored after the endpoint surface is defined, but before final docs/examples are declared complete.
- README/examples MUST be updated after the public API settles and tests pass.

## Phases overview

- **Phase 00**: Create the Swift and bridge-package scaffolds, core envelope/error/config/protocol primitives, repo hygiene updates, and baseline build/tests.
- **Phase 01**: Implement read/query routes for files, versions, downloads, artifacts, and render descriptors.
- **Phase 02**: Implement optional capability routes for policies, quota, grants, shares, and processing with capability-unavailable classification.
- **Phase 03**: Implement low-level upload-session methods and the high-level foreground uploader with proxy/signed upload support.
- **Phase 04**: Implement background upload coordination, durable recovery, token persistence, and cleanup semantics.
- **Phase 05**: Implement the native-backed WebView bridge host, native asset registry/preview plumbing, and the `filefn/swift-bridge` JavaScript package.
- **Phase 06**: Implement preprocessors, built-in HEIC conversion, and the SwiftUI helper target.
- **Phase 07**: Publish the machine-readable contract artifact, add integration and bridge-package coverage, and finalize docs/repo-level verification hooks.

## Definition of Done

No phase is complete unless its verification steps pass.

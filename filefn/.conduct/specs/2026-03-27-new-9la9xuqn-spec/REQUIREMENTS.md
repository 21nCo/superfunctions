# Requirement IDs

- PKG-001
- CFG-001
- ENV-001
- ERR-001
- FILE-001
- RENDER-001
- POL-001
- GRANT-001
- SHARE-001
- PROC-001
- UP-001
- UP-002
- BG-001
- BRIDGE-001
- BRIDGE-002
- SEC-001
- HEIC-001
- UI-001
- CONTRACT-001
- TEST-001
- DOC-001

## PKG-001

- **Priority**: P0
- **Statement**: The repo MUST add a Swift Package Manager package at `filefn/swift` plus a companion TypeScript bridge package at `filefn/swift-bridge`, with repo-level ignore/tooling updates that avoid creating a nested monorepo.
- **Rationale**: The user asked for native Swift support and then expanded scope to native-backed WebView apps; `AGENTS.md` explicitly forbids nested monorepos.
- **Acceptance criteria**:
  - `filefn/swift/Package.swift` exists and defines `FileFnClient`, `FileFnSwiftUI`, and `FileFnWebViewBridgeHost` library products.
  - `filefn/swift-bridge/package.json` exists and exposes the bridge package as a normal workspace package under the existing `filefn/*` glob.
  - `.gitignore` includes Swift build-output ignores needed for a library package.
  - Root helper scripts or documentation show how to run `swift build`, `swift test`, and bridge-package tests from repo root without machine-specific paths.
  - No nested Swift or npm monorepo layout is introduced.
- **Test vectors**: TV-PKG-001
- **Notes**: The Swift package remains outside npm packaging concerns, while the bridge package is a normal TypeScript workspace package.

## CFG-001

- **Priority**: P0
- **Statement**: The Swift client MUST expose a configurable base URL, auth provider, request-ID provider, retry policy, logger, and injectable `URLSession`/JSON coders.
- **Rationale**: Native apps and tests need dependency injection, while auth semantics remain caller-owned.
- **Acceptance criteria**:
  - `FileFnClientConfiguration` includes all required configuration points.
  - Base URLs are normalized consistently.
  - Auth headers and request IDs are injected into outgoing requests when configured.
  - `POST /upload/init` retries are disabled unless an idempotency key is present.
- **Test vectors**: TV-CFG-001
- **Notes**: `sendClientVersionHeader` is allowed as a boolean knob rather than a caller-supplied raw header.

## ENV-001

- **Priority**: P0
- **Statement**: The Swift client MUST decode FileFn canonical success and error envelopes and MUST treat missing `warnings` as an empty array.
- **Rationale**: The existing FileFn server and JS client both rely on envelope unwrapping; Swift must preserve the same contract.
- **Acceptance criteria**:
  - `{ ok: true, data }` responses decode to the unwrapped value plus warnings/request ID metadata.
  - `{ ok: false, error }` responses decode to structured server errors.
  - Missing `data` on `ok: true` is rejected as an invalid response.
  - Missing `warnings` is normalized to `[]`.
- **Test vectors**: TV-ENV-001
- **Notes**: The package may keep the generic envelope type internal or public, but the behavior MUST be testable.

## ERR-001

- **Priority**: P0
- **Statement**: The Swift client MUST preserve FileFn server error codes/statuses and MUST separately classify non-canonical optional-route 404/405 responses as capability unavailability.
- **Rationale**: SwiftUI apps need actionable errors that distinguish authorization/resource failures from server route families that were never mounted.
- **Acceptance criteria**:
  - Canonical FileFn errors surface as `FileFnClientError.server`.
  - Non-canonical 404/405 responses from optional route families surface as `FileFnClientError.capabilityUnavailable`.
  - Generic malformed transport failures surface as `transport` or `invalidResponse`.
  - `requestId` is retained when present.
- **Test vectors**: TV-ERR-001
- **Notes**: Capability detection only applies to the optional route families named in this spec.

## FILE-001

- **Priority**: P0
- **Statement**: `FileFnClient` MUST support listing files, fetching file details, and deleting files using the existing FileFn HTTP contract.
- **Rationale**: A SwiftUI app cannot meaningfully consume FileFn without file discovery and lifecycle operations.
- **Acceptance criteria**:
  - `listFiles` returns file summaries and opaque cursors.
  - `getFile` returns the detail payload shape exposed by the server route.
  - `deleteFile` succeeds on canonical `{ deleted: true }` responses and throws on canonical errors.
  - The client never attempts to parse or regenerate the opaque cursor.
- **Test vectors**: TV-FILE-001
- **Notes**: `listFiles` returns `policy` and `metadata`; `getFile` does not. The Swift models MUST reflect that asymmetry rather than inventing fields.

## RENDER-001

- **Priority**: P0
- **Statement**: `FileFnClient` MUST support versions, download descriptors, artifact descriptors, and render descriptors exactly as exposed by the FileFn server.
- **Rationale**: SwiftUI apps need both raw downloads and display-oriented resolution for images, PDFs, and other file types.
- **Acceptance criteria**:
  - `listVersions` and `getVersion` decode their distinct payloads.
  - `downloadURL`, `downloadArtifact`, and `resolveShareDownload` preserve URL plus headers.
  - `listArtifacts` and `resolveRenderable` preserve placeholder and warning behavior.
  - The client does not automatically fetch file bytes during descriptor resolution.
- **Test vectors**: TV-RENDER-001
- **Notes**: Relative proxy URLs are valid and MUST be resolved against `baseURL`.

## POL-001

- **Priority**: P1
- **Statement**: `FileFnClient` MUST support mounted policy and quota routes and MUST throw capability-unavailable errors when those route families are absent.
- **Rationale**: Swift apps may need upload-policy discovery and quota display, but the server may omit either route family.
- **Acceptance criteria**:
  - `listPolicies` decodes `{ policies: [...] }`.
  - `getStorageQuota` decodes `{ current, limit }`.
  - Non-canonical route-missing failures surface as capability unavailability.
  - Canonical `FILEFN_NOT_FOUND` from a mounted quota route remains a server error.
- **Test vectors**: TV-POL-001
- **Notes**: Policies and quota are independent capabilities.

## GRANT-001

- **Priority**: P1
- **Statement**: `FileFnClient` MUST support create/list/revoke permission grant routes with the exact request and response fields exposed by FileFn.
- **Rationale**: A native app managing collaborative files needs grant management parity with the server.
- **Acceptance criteria**:
  - `createGrant` encodes optional user/role/tenant scopes and permission booleans.
  - `listGrants` decodes `{ permissions: [...] }`.
  - `revokeGrant` succeeds only on canonical `{ revoked: true }`.
  - Canonical 400/403/404 failures surface without remapping.
- **Test vectors**: TV-GRANT-001
- **Notes**: Grant routes are optional capabilities and therefore also participate in capability-unavailable detection.

## SHARE-001

- **Priority**: P1
- **Statement**: `FileFnClient` MUST support create/list/revoke share-link routes and share-link download resolution, including auth-required and expiration/error semantics.
- **Rationale**: Share links are part of the mounted FileFn router surface and are directly useful in SwiftUI apps.
- **Acceptance criteria**:
  - `createShareLink` encodes version, expiration, auth, and max-download options.
  - `listShareLinks` returns share metadata including `tokenHashPrefix`.
  - `resolveShareDownload` returns URL, headers, file name, and MIME type.
  - Canonical `FILEFN_SHARE_*` errors surface intact.
- **Test vectors**: TV-SHARE-001
- **Notes**: The client is not required to fetch the share-link bytes directly; it only resolves the download descriptor.

## PROC-001

- **Priority**: P1
- **Statement**: `FileFnClient` MUST support the mounted processing trigger route and MUST preserve `started`, `enqueued`, and `jobId` semantics.
- **Rationale**: Some Apple apps may need to request derivative processing explicitly after uploads or imports.
- **Acceptance criteria**:
  - `triggerProcessing` encodes the required request fields.
  - `triggerProcessing` decodes `{ processing: { started, enqueued, jobId } }`.
  - Canonical `FILEFN_PROCESSING_ENQUEUE_FAILED` surfaces intact.
  - Missing route families surface as capability unavailability.
- **Test vectors**: TV-PROC-001
- **Notes**: The server may validly return `enqueued: false`.

## UP-001

- **Priority**: P0
- **Statement**: `FileFnClient` MUST expose low-level upload-session methods that respect FileFn's header, token, idempotency, part-signing, and completion semantics exactly.
- **Rationale**: Native apps need a precise low-level escape hatch for custom transfer workflows and debugging.
- **Acceptance criteria**:
  - `createUploadSession` sends `x-idempotency-key` when an idempotency key is present.
  - Follow-up upload calls send `x-upload-session-token` when provided.
  - The client supports session creation, status, part signing, part completion, final completion, and abort.
  - Low-level methods surface `FILEFN_SESSION_TOKEN_REQUIRED`, `FILEFN_SESSION_TOKEN_INVALID`, `FILEFN_INVALID_PART_NUMBER`, `FILEFN_INVALID_ETAG`, and `FILEFN_UPLOAD_INCOMPLETE` correctly.
- **Test vectors**: TV-UP-001
- **Notes**: Proxy part-byte uploads are used by the high-level uploaders and MAY remain internal to the public low-level surface if still fully tested.

## UP-002

- **Priority**: P0
- **Statement**: The package MUST provide a high-level foreground uploader that generates stable local IDs, preprocesses inputs, supports proxy and signed upload modes, and emits ordered progress/completion events.
- **Rationale**: SwiftUI apps need a practical upload API, not only route-by-route primitives.
- **Acceptance criteria**:
  - Foreground uploads accept both file-URL and `Data` sources.
  - A missing `fileId` generates a `file_...` identifier before session creation.
  - A missing idempotency key is generated automatically for foreground uploads.
  - Multipart uploads stream file chunks from disk or controlled temporary storage rather than loading the entire file into memory.
  - Event ordering and aggregate progress are monotonic.
- **Test vectors**: TV-UP-002, TV-UP-003
- **Notes**: The uploader MAY internally create temporary files for `Data` sources.

## BG-001

- **Priority**: P0
- **Statement**: The package MUST provide a background uploader with durable state, resumable multipart coordination, relaunch recovery, and cleanup semantics suitable for SwiftUI apps.
- **Rationale**: Background resilience was a key reason the Swift client is valuable beyond the browser client.
- **Acceptance criteria**:
  - Background uploads require disk-backed local files.
  - Background uploader persists enough state to recover after app relaunch.
  - Recovery reconciles persisted state with `getUploadStatus` and resumes only missing work.
  - Recovered uploads remain the authoritative state even if a native-backed WebView has not yet reconnected.
  - Cancellation and terminal completion clean up chunk files, state snapshots, and anonymous session tokens.
- **Test vectors**: TV-BG-001
- **Notes**: The background uploader may reject impossible states as `backgroundStateCorrupt`.

## BRIDGE-001

- **Priority**: P0
- **Statement**: The repo MUST provide a native-backed WebView bridge consisting of a Swift `FileFnWebViewBridgeHost` target and a TypeScript `filefn/swift-bridge` package that communicate through an explicit versioned `filefn-bridge/v1` protocol.
- **Rationale**: The bridge mode is how web-rendered Apple apps reuse native auth, upload ownership, and file access without reimplementing FileFn semantics in WebView JavaScript.
- **Acceptance criteria**:
  - `filefn/swift` exports a `FileFnWKWebViewBridgeHost` implementation plus bridge configuration and native asset registry types.
  - `filefn/swift-bridge` exports a `createWKWebViewBridgeBus(...)` helper and a FileFn-compatible native-backed client facade.
  - `handshake` is required before any native-backed method call and validates bridge protocol/version plus native-backed mode selection.
  - Bridge unavailability, protocol mismatch, and unsupported methods surface as stable bridge error codes rather than generic exceptions.
  - Native-backed mode does not silently fall back to browser/web-owned behavior.
- **Test vectors**: TV-BRIDGE-001
- **Notes**: The bridge package is intentionally thin and reuses the native Swift runtime as the real owner of FileFn behavior.

## BRIDGE-002

- **Priority**: P0
- **Statement**: Native-backed WebView uploads MUST be native-owned, asset-handle-based, and sanitized so that large file bytes, auth headers, and anonymous upload session tokens do not traverse the JavaScript bridge.
- **Rationale**: The value of the bridge mode is native file ownership, background resilience, and secret containment; a byte-pipe bridge would undermine all three.
- **Acceptance criteria**:
  - `upload.start` accepts an opaque `assetHandle` and FileFn metadata, not raw `Blob`, base64, or arbitrary byte-array payloads.
  - The Swift bridge host resolves the asset handle to a native file URL and reuses the same foreground/background uploaders as direct native mode.
  - Bridge upload start/status/abort APIs expose an opaque `uploadID` to JavaScript, not `uploadSessionToken`.
  - Bridge events and responses never expose auth headers, upload session tokens, signed URL query strings, or absolute file paths.
  - Bridge preview URLs are opaque app-controlled URLs rather than raw file-system paths.
  - Documentation explicitly directs browser-owned `File`/`Blob` uploads to the existing `filefn/client` web-owned mode.
- **Test vectors**: TV-BRIDGE-002
- **Notes**: Small-file inline transfer over the bridge is undefined and not required.

## SEC-001

- **Priority**: P0
- **Statement**: The Swift client MUST store anonymous upload session tokens securely and MUST redact secrets and absolute local paths from persisted state and logs.
- **Rationale**: Upload session tokens authorize anonymous follow-up calls and therefore require secret handling.
- **Acceptance criteria**:
  - The package exposes a `FileFnSecretStore` abstraction and uses it for anonymous upload session tokens.
  - Persisted background snapshots exclude auth headers, signed URLs, and upload session tokens.
  - Native-backed bridge events/responses exclude auth headers, upload session tokens, signed URL query strings, and absolute local file paths.
  - Native-backed preview descriptors use opaque application-controlled URLs rather than filesystem paths.
  - Default logging redacts auth headers, upload session tokens, signed URL query strings, and absolute local file paths.
  - Tokens are removed after terminal completion/cancellation.
- **Test vectors**: TV-SEC-001
- **Notes**: Keychain is the expected default implementation on Apple platforms.

## HEIC-001

- **Priority**: P1
- **Statement**: The package MUST support pluggable upload preprocessors and MUST ship a configurable built-in HEIC-to-JPEG preprocessor for Apple-platform assets.
- **Rationale**: HEIC is a common iOS capture format and the native client should offer a first-class strategy instead of forcing every app to reinvent it.
- **Acceptance criteria**:
  - Foreground and background upload requests accept preprocessors.
  - A built-in HEIC preprocessor is available and enabled by default.
  - Successful conversion updates source, MIME type, and filename extension consistently.
  - Native-backed bridge uploads use the same preprocessor pipeline after the asset handle is resolved to a native file URL.
  - Conversion failures surface as a client preprocessing error without creating a server upload session.
- **Test vectors**: TV-HEIC-001
- **Notes**: Apps may disable the built-in HEIC preprocessor explicitly.

## UI-001

- **Priority**: P1
- **Statement**: The repo MUST provide a thin `FileFnSwiftUI` target with observable upload-state bridging and local-asset loaders for `PhotosPickerItem` and file-imported URLs.
- **Rationale**: The user explicitly wants SwiftUI apps to make use of FileFn, so basic SwiftUI integration should be built in.
- **Acceptance criteria**:
  - `FileFnUploadObservable` bridges `FileFnUploadTask` events into published state.
  - `FileFnPhotosPickerLoader` loads a picker item into a local file URL plus metadata suitable for upload APIs.
  - `FileFnFileImporterLoader` normalizes imported file URLs for upload use.
  - The loaded assets are suitable for direct native uploads or registration in `FileFnNativeAssetRegistry` for native-backed WebView uploads.
  - The target remains helper-only and does not ship opinionated UI components.
- **Test vectors**: TV-UI-001
- **Notes**: Conditional compilation is acceptable for Apple-only frameworks.

## CONTRACT-001

- **Priority**: P0
- **Statement**: The repo MUST publish and test a deterministic OpenAPI 3.1 artifact describing every FileFn route and header the Swift client supports.
- **Rationale**: A machine-readable contract is the cleanest way to reduce drift between TypeScript server code and the new Swift client.
- **Acceptance criteria**:
  - A checked-in OpenAPI JSON artifact exists under `filefn/server/contracts/`.
  - The artifact covers upload, file, artifact, policy, quota, grant, share, and processing routes plus canonical envelopes and headers.
  - Regeneration is deterministic and test-verified.
  - Swift docs reference the artifact as the compatibility source of truth.
- **Test vectors**: TV-CONTRACT-001
- **Notes**: The generation mechanism may be custom and does not have to reuse `@superfunctions/http-openapi`.

## TEST-001

- **Priority**: P0
- **Statement**: The implementation MUST ship automated unit and integration tests that verify the Swift client against the FileFn contract, upload semantics, recovery behavior, and native helpers.
- **Rationale**: This work spans transport, upload orchestration, persistence, and SwiftUI integration; untested behavior will drift quickly.
- **Acceptance criteria**:
  - `swift test --package-path filefn/swift` covers core transport, envelopes, uploads, background recovery, secret redaction, HEIC preprocessing, and SwiftUI helpers.
  - Swift bridge-host tests verify handshake semantics, upload-event emission, asset-handle resolution, and secret redaction.
  - `filefn/swift-bridge` tests verify bridge-bus behavior, protocol errors, and native-backed client semantics.
  - At least one integration test target runs against a locally started FileFn demo server.
  - TypeScript-side contract tests validate the published OpenAPI artifact.
  - Tests do not depend on machine-specific paths.
- **Test vectors**: TV-TEST-001
- **Notes**: Local demo-server integration is sufficient; CI wiring may be added later as long as local execution is defined now.

## DOC-001

- **Priority**: P1
- **Statement**: The repo MUST document installation, configuration, direct native usage, native-backed WebView usage, upload behavior, background recovery, capability routes, HEIC behavior, and local verification using repo-relative instructions only.
- **Rationale**: A native SDK without docs will force every adopter to reverse-engineer the contract and the recovery model.
- **Acceptance criteria**:
  - `filefn/swift/README.md` includes installation, auth configuration, basic reads, foreground upload, background upload, SwiftUI helper examples, and native-backed WebView guidance.
  - `filefn/swift-bridge/README.md` explains handshake, native-backed mode, asset-handle uploads, and the explicit non-goal of browser-owned `Blob` bridging.
  - Documentation references the machine-readable contract artifact, native-backed bridge protocol, and optional capability-route behavior.
  - Commands and paths are repo-relative.
  - Docs do not mention unsupported distribution mechanisms such as CocoaPods or Carthage.
- **Test vectors**: TV-DOC-001
- **Notes**: Example snippets should compile conceptually against the package's public API.

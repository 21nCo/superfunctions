# Metadata

- **timestamp**: 2026-03-27T07:16:42Z
- **updated_at**: 2026-03-29T06:00:37Z
- **agent_name**: unknown-agent
- **model**: gpt-5-codex
- **launcher**: Codex Desktop
- **workspace**: repo root
- **os**: Darwin arm64
- **shell**: zsh
- **git.branch**: HEAD (detached)
- **git.commit**: 50929162a8547f6f55db27bdc51c47289c0bc2af
- **git.dirty**: false
- **spec_folder**: 2026-03-27-new-9la9xuqn-spec
- **spec_path**: filefn/.conduct/specs/2026-03-27-new-9la9xuqn-spec
- **spec_type**: new
- **spec_id**: 9la9xuqn
- **input_paths**:
  - AGENTS.md
  - package.json
  - filefn/client/package.json
  - filefn/client/src/client.ts
  - filefn/client/src/index.ts
  - filefn/client/src/types.ts
  - filefn/client/src/upload-manager.ts
  - filefn/client/tests/envelope-unwrapping.test.ts
  - filefn/examples/full-demo/README.md
  - filefn/examples/full-demo/client/src/routes/+page.svelte
  - filefn/examples/full-demo/server/src/index.ts
  - filefn/server/package.json
  - filefn/server/src/auth.ts
  - filefn/server/src/errors.ts
  - filefn/server/src/router.ts
  - filefn/server/src/upload-sessions/routes.ts
  - filefn/server/src/upload-sessions/service.ts
  - filefn/server/src/files/routes.ts
  - filefn/server/src/files/service.ts
  - filefn/server/src/authz/grants.routes.ts
  - filefn/server/src/authz/grants.service.ts
  - filefn/server/src/shares/routes.ts
  - filefn/server/src/shares/service.ts
  - filefn/server/src/processing/routes.ts
  - filefn/server/src/policies.routes.ts
  - filefn/server/src/quota.routes.ts
  - filefn/server/src/__tests__/upload-sessions.test.ts
  - filefn/server/src/__tests__/idempotency-complete.test.ts
  - filefn/server/src/__tests__/files-list-accessible.test.ts
  - filefn/server/src/__tests__/files.test.ts
  - sibling worktree reference: datafn/swift/Package.swift
  - sibling worktree reference: datafn/swift/README.md
  - sibling worktree reference: datafn/swift/Sources/DatafnWebViewBridgeHost/*
  - sibling worktree reference: datafn/swift-bridge/README.md
  - sibling worktree reference: datafn/swift-bridge/src/*
  - external: spec skill instructions
  - conversation: user request for a FileFn Swift client for SwiftUI apps
  - conversation: user-provided review response covering background uploads, HEIC, and picker helpers
  - conversation: user request to support both native uploads and native-backed WebView apps
  - conversation: design ideation after reviewing the DataFn Swift + WebView bridge split

# Overview

## Project context

- **Project name**: FileFn Swift client
- **One-sentence goal**: Add a native Swift Package Manager FileFn client plus a companion native-backed WebView bridge so SwiftUI and `WKWebView`-hosted Apple apps can talk to FileFn servers for uploads, file browsing, downloads, rendering, sharing, permissions, and processing while preserving the existing HTTP contract.
- **Target users**:
  - iOS and macOS application developers building with SwiftUI
  - teams embedding web-rendered application shells inside `WKWebView` while keeping file/network ownership in native Swift
  - Superfunctions maintainers responsible for FileFn client/server compatibility
  - Teams embedding FileFn into first-party Apple-platform apps
- **Target environments**:
  - Apple platforms only
  - iOS 16.0+ and macOS 13.0+
  - online-first applications with intermittent connectivity
  - foreground and background upload flows
  - direct SwiftUI applications consuming `URLSession`, structured concurrency, and SwiftPM
  - native-backed `WKWebView` applications where JavaScript UI talks to a Swift host over a versioned bridge
- **Languages/packages required**:
  - Swift 6-compatible source under `filefn/swift`
  - TypeScript source under `filefn/swift-bridge`
  - existing FileFn TypeScript server/client packages under `filefn/server` and `filefn/client`
  - existing repo tooling in `package.json` and `.gitignore`
- **Existing systems it must integrate with**:
  - `filefn/server` HTTP routes and canonical envelopes
  - `filefn/client` as the existing browser/web-owned client for true browser `File`/`Blob` ownership
  - demo servers under `filefn/examples/full-demo` and `filefn/examples/production`
  - optional FileFn route families for policies, quota, grants, shares, and processing
  - repo-level `.conduct` and monorepo conventions from `AGENTS.md`
- **Data model summary**:
  - file records, file versions, render descriptors, artifact descriptors
  - upload sessions, upload parts, upload progress and completion records
  - permission grants, share links, policies, quota usage, processing job results
  - client-side persisted background upload state plus securely stored anonymous upload session tokens
- **Security model**:
  - authentication remains server-defined and is injected by the client via headers/cookies
  - authorization remains server-enforced across file, grant, share, and processing routes
  - anonymous upload follow-up calls use `x-upload-session-token` and MUST treat that token as a secret
  - native-backed WebView mode MUST keep auth headers and upload session tokens inside Swift and MUST NOT expose them to JavaScript bridge responses/events
  - the client MUST NOT log auth headers, upload session tokens, signed URL query strings, or absolute local file paths
- **Performance constraints**:
  - large uploads MUST stream from disk and MUST NOT require loading an entire file into memory
  - background uploads MUST survive suspension/relaunch by reconciling persisted state with server session status
  - foreground uploads SHOULD retry idempotent calls with bounded exponential backoff
  - local verification MUST run from repo root without machine-specific paths
- **Non-goals / out of scope**:
  - a server-side Swift implementation for FileFn
  - UIKit/AppKit UI components or a full visual file browser
  - browser-only OPFS/offline queue semantics
  - watchOS, tvOS, Linux, or server-side Swift package targets
  - client-side encryption, sync engines, or background download managers
  - shuttling arbitrary large browser-owned `Blob` payloads through `WKScriptMessageHandler` in native-backed mode
  - silent fallback from native-backed WebView mode to browser/web-owned upload mode when the bridge is unavailable or mismatched
- **Hard constraints**:
  - the implementation MUST live under `filefn/swift` and MUST NOT create a nested monorepo
  - the native-backed WebView package MUST live under `filefn/swift-bridge` and participate in the existing `filefn/*` workspace pattern without creating a nested monorepo
  - the Apple-native package MUST use Swift Package Manager only; the companion WebView bridge MAY ship as a workspace TypeScript package under `filefn/swift-bridge`
  - the Swift client MUST preserve the existing FileFn HTTP contract; any HTTP contract additions MUST be additive and documented
  - the native-backed WebView bridge MUST use an explicit, versioned bridge protocol rather than implicit `evaluateJavaScript` strings with ad hoc payloads
  - no third-party runtime dependency is required; Foundation, SwiftUI, PhotosUI, UniformTypeIdentifiers, ImageIO, CoreImage, and Security MAY be used
  - repo artifacts MUST remain portable and use repo-relative commands/paths only

## Assumptions

1. The Swift package name will be `FileFnSwift`, with library products named `FileFnClient`, `FileFnSwiftUI`, and `FileFnWebViewBridgeHost`.
2. The first supported Apple targets are iOS 16.0+ and macOS 13.0+ so the implementation can rely on async/await, `PhotosPickerItem`, and modern `URLSession` APIs without fallback shims.
3. The existing FileFn server routes remain authoritative; the Swift client may add a machine-readable contract artifact, but it does not rename or remove current routes.
4. Full offline-first staging semantics equivalent to the browser OPFS client are not required; resumable foreground uploads and durable background uploads are required.
5. The companion JavaScript package will live at `filefn/swift-bridge` and publish as `@filefn/swift-bridge`, using the repo's existing `filefn/*` workspace glob rather than a nested monorepo.
6. Native-backed WebView mode is explicit and fail-fast. If the bridge is unavailable or the handshake mismatches, the JS package throws a stable bridge error and does not silently fall back to browser-owned transport.
7. Native-backed uploads use native-owned asset handles and native file URLs; browser-owned `File`/`Blob` uploads remain the responsibility of the existing `filefn/client` web-owned mode.

# Glossary

- **FileFn server**: The existing TypeScript HTTP router exported by `filefn/server`, including upload, file, artifact, share, grant, policy, quota, and processing endpoints.
- **Canonical envelope**: A JSON HTTP response of the form `{ "ok": true, "data": ... }` or `{ "ok": false, "error": ... }`, optionally including `warnings` and `requestId`.
- **Capability route family**: An optional FileFn endpoint group that may be mounted or omitted by the server, specifically policies, quota, grants, shares, and processing.
- **Foreground upload**: An upload driven by an active app process using direct async calls and in-process progress streaming.
- **Background upload**: An upload coordinated through a background `URLSession` and durable state so it can continue or recover after suspension or relaunch.
- **Anonymous upload session token**: The secret token returned by the server when auth is not required and the session must remain bound to the caller across follow-up requests.
- **Signed upload mode**: A server-selected mode where the client uploads parts directly to a storage URL returned by `signPart`.
- **Proxy upload mode**: A server-selected mode where the client uploads part bytes to FileFn's own `PUT /upload/{session}/parts/{part}` endpoint.
- **Render descriptor**: The structured response describing whether a file can be displayed directly, via a derived artifact, or via a placeholder.
- **Machine-readable contract**: A deterministic OpenAPI 3.1 JSON artifact that describes every FileFn route the Swift client supports.
- **Native-backed WebView mode**: A topology where JavaScript UI in `WKWebView` talks to a Swift host over a versioned bridge and the Swift host owns auth, upload orchestration, and local file access.
- **Web-owned mode**: A topology where the JavaScript app owns browser `File`/`Blob` values and uses the existing `filefn/client` HTTP path directly.
- **Native asset handle**: An opaque, bridge-safe identifier for a native file or imported asset registered with the Swift host.
- **Bridge-local preview URL**: An app-controlled opaque URL such as a custom scheme or local app asset URL that resolves a preview for a native asset without exposing an absolute filesystem path.
- **Bridge protocol**: The versioned `filefn-bridge/v1` request/response/event envelope used between `filefn/swift-bridge` and `FileFnWebViewBridgeHost`.

# Goals / Non-goals

## Goals

1. The repo MUST expose a native Swift client that fully covers the FileFn HTTP surface needed by SwiftUI apps.
2. The Swift package MUST provide both low-level route methods and high-level upload conveniences.
3. Background upload support MUST be first-class rather than bolted on after the initial client exists.
4. The implementation MUST encode FileFn's canonical envelopes, idempotency rules, anonymous-session-token rules, and render semantics precisely.
5. The repo MUST expose a native-backed WebView bridge so web-rendered Apple apps can delegate FileFn ownership to Swift.
6. The repo MUST gain a machine-readable client contract artifact so Swift and TypeScript behavior do not drift silently.

## Non-goals

- Rewriting `filefn/server` into a Swift/Vapor/Hummingbird package.
- Porting browser-only OPFS or object-URL helpers directly into Apple-platform APIs.
- Shipping a prebuilt XCFramework, CocoaPods spec, or Carthage manifest.
- Designing a generic document-management UI kit on top of FileFn.
- Making `filefn/swift-bridge` the only supported JavaScript client path. Browser/web-owned FileFn remains valid and separate.
- Treating the WebView bridge as a byte pipe for large uploads.

# Public API

## Swift package layout

```swift
// filefn/swift/Package.swift
products: [
  .library(name: "FileFnClient", targets: ["FileFnClient"]),
  .library(name: "FileFnSwiftUI", targets: ["FileFnSwiftUI"]),
  .library(name: "FileFnWebViewBridgeHost", targets: ["FileFnWebViewBridgeHost"])
]

targets: [
  .target(name: "FileFnClient"),
  .target(name: "FileFnWebViewBridgeHost", dependencies: ["FileFnClient"]),
  .target(name: "FileFnSwiftUI", dependencies: ["FileFnClient"]),
  .testTarget(name: "FileFnClientTests", dependencies: ["FileFnClient"]),
  .testTarget(name: "FileFnSwiftUITests", dependencies: ["FileFnSwiftUI"]),
  .testTarget(name: "FileFnWebViewBridgeHostTests", dependencies: ["FileFnWebViewBridgeHost"]),
  .testTarget(name: "FileFnIntegrationTests", dependencies: ["FileFnClient"])
]
```

## Core configuration surface

```swift
public protocol FileFnAuthProvider: Sendable {
  func headers(for request: FileFnAuthContext) async throws -> [String: String]
}

public struct FileFnAuthContext: Sendable, Equatable {
  public let method: String
  public let path: String
  public let requiresUploadSessionToken: Bool
}

public struct FileFnRetryPolicy: Sendable, Equatable {
  public var maxAttempts: Int
  public var baseDelayMilliseconds: Int
  public var maxDelayMilliseconds: Int
  public var retryableStatusCodes: Set<Int>
}

public protocol FileFnLogger: Sendable {
  func log(_ event: FileFnLogEvent)
}

public struct FileFnLogEvent: Sendable, Equatable {
  public let level: FileFnLogLevel
  public let message: String
  public let requestId: String?
  public let uploadID: String?
  public let metadata: [String: FileFnJSONValue]
}

public struct FileFnClientConfiguration: Sendable {
  public var baseURL: URL
  public var authProvider: (any FileFnAuthProvider)?
  public var defaultHeaders: [String: String]
  public var retryPolicy: FileFnRetryPolicy
  public var requestIDProvider: (@Sendable () -> String?)?
  public var logger: (any FileFnLogger)?
  public var sendClientVersionHeader: Bool
  public var urlSession: URLSession
  public var jsonEncoder: JSONEncoder
  public var jsonDecoder: JSONDecoder
}

public actor FileFnClient {
  public init(configuration: FileFnClientConfiguration)
}
```

## Native-backed WebView bridge surface

```swift
public struct FileFnNativeAssetDescriptor: Codable, Sendable, Equatable {
  public let assetHandle: String
  public let fileName: String
  public let mimeType: String
  public let size: Int64
  public let previewURL: URL?
}

public protocol FileFnNativeAssetRegistry: Sendable {
  func registerFile(url: URL, fileName: String?, mimeType: String?) async throws -> FileFnNativeAssetDescriptor
  func resolveFileURL(assetHandle: String) async throws -> URL
  func descriptor(assetHandle: String) async throws -> FileFnNativeAssetDescriptor
  func remove(assetHandle: String) async throws
}

public struct FileFnWebViewBridgeConfiguration: Sendable, Equatable {
  public var handlerName: String
  public var previewScheme: String
  public var bridgeVersion: Int
}

public final class FileFnWKWebViewBridgeHost: NSObject, WKScriptMessageHandler {
  public init(
    client: FileFnClient,
    foregroundUploader: FileFnForegroundUploader,
    backgroundUploader: FileFnBackgroundUploader?,
    assetRegistry: any FileFnNativeAssetRegistry,
    configuration: FileFnWebViewBridgeConfiguration
  )

  public func attach(to userContentController: WKUserContentController)
  public func detach(from userContentController: WKUserContentController)
}
```

```typescript
// filefn/swift-bridge/src/index.ts
export const FILEFN_BRIDGE_PROTOCOL = "filefn-bridge/v1" as const;

export interface CreateWKWebViewBridgeBusOptions {
  handlerName?: string;
  timeoutMs?: number;
}

export interface FileFnBridgeBus {
  request(message: FileFnBridgeRequestEnvelope): Promise<FileFnBridgeResponseEnvelope>;
  subscribe(handler: (event: FileFnBridgeEventEnvelope) => void): () => void;
}

export interface FileFnNativeAssetDescriptor {
  assetHandle: string;
  fileName: string;
  mimeType: string;
  size: number;
  previewURL?: string;
}

export function createWKWebViewBridgeBus(
  options?: CreateWKWebViewBridgeBusOptions,
): FileFnBridgeBus;

export function createNativeBackedFileFnClient(
  bus: FileFnBridgeBus,
): {
  handshake(input: { clientId: string; mode: "native-backed"; baseURL: string }): Promise<{
    bridgeVersion: 1;
    uploadOwner: "native";
    authOwner: "native";
    previewScheme: string;
    capabilities: string[];
  }>;
  listFiles(input?: { cursor?: string; limit?: number }): Promise<FileFnFilePage>;
  getFile(fileId: string): Promise<FileFnFileDetail>;
  deleteFile(fileId: string): Promise<void>;
  listVersions(fileId: string): Promise<{ versions: FileFnVersionSummary[] }>;
  getVersion(fileId: string, versionId: string): Promise<FileFnVersionDetail>;
  downloadURL(fileId: string, options?: { versionId?: string }): Promise<FileFnDownloadDescriptor>;
  listArtifacts(fileId: string): Promise<FileFnArtifactDescriptor[]>;
  downloadArtifact(fileId: string, artifactId: string): Promise<FileFnDownloadDescriptor>;
  resolveRenderable(input: { fileId: string; intent: FileFnRenderIntent; versionId?: string }): Promise<FileFnRenderDescriptor>;
  listPolicies(): Promise<FileFnPolicySummary[]>;
  getStorageQuota(): Promise<FileFnStorageQuota>;
  createGrant(fileId: string, request: FileFnCreateGrantRequest): Promise<FileFnPermissionGrant>;
  listGrants(fileId: string): Promise<FileFnPermissionGrant[]>;
  revokeGrant(fileId: string, permissionId: string): Promise<void>;
  createShareLink(fileId: string, request: FileFnCreateShareLinkRequest): Promise<FileFnShareLink>;
  listShareLinks(fileId: string): Promise<FileFnShareLinkSummary[]>;
  revokeShareLink(fileId: string, token: string): Promise<void>;
  resolveShareDownload(token: string): Promise<FileFnShareDownloadDescriptor>;
  triggerProcessing(fileId: string, request: FileFnTriggerProcessingRequest): Promise<FileFnProcessingStatus>;
  startUpload(input: {
    policy: string;
    assetHandle: string;
    fileId?: string;
    fileName?: string;
    mimeType?: string;
    metadata?: Record<string, unknown>;
    idempotencyKey?: string;
    background?: boolean;
  }): Promise<{ uploadID: string; fileId: string }>;
  getUploadStatus(uploadID: string): Promise<FileFnNativeUploadStatus>;
  abortUpload(uploadID: string): Promise<void>;
  onUploadEvent(handler: (event: FileFnBridgeUploadEvent) => void): () => void;
};
```

## Canonical envelope and error surface

```swift
public struct FileFnEnvelope<Value: Decodable & Sendable>: Decodable, Sendable {
  public let ok: Bool
  public let data: Value?
  public let error: FileFnServerErrorPayload?
  public let warnings: [String]
  public let requestId: String?
}

public struct FileFnServerErrorPayload: Decodable, Sendable, Equatable {
  public let code: String
  public let message: String
  public let details: [String: FileFnJSONValue]
}

public enum FileFnCapability: String, Sendable, Codable {
  case policies
  case quota
  case grants
  case shares
  case processing
}

public enum FileFnClientError: Error, Sendable, Equatable {
  case configurationInvalid(field: String, message: String)
  case invalidResponse(reason: String, requestId: String?)
  case transport(status: Int?, requestId: String?, bodySnippet: String?)
  case server(status: Int, payload: FileFnServerErrorPayload, requestId: String?)
  case capabilityUnavailable(FileFnCapability, status: Int, requestId: String?)
  case fileAccess(reason: String)
  case preprocessingFailed(code: String, message: String)
  case backgroundStateCorrupt(uploadID: String, reason: String)
}
```

## File and render/query surface

```swift
public struct FileFnFileSummary: Codable, Sendable, Equatable {
  public let fileId: String
  public let currentVersionId: String
  public let ownerId: String
  public let tenantId: String?
  public let visibility: String
  public let policy: String
  public let mimeType: String
  public let size: Int64
  public let name: String
  public let metadata: [String: FileFnJSONValue]
  public let createdAt: String
  public let updatedAt: String
}

public struct FileFnFileDetail: Codable, Sendable, Equatable {
  public let fileId: String
  public let currentVersionId: String
  public let ownerId: String
  public let tenantId: String?
  public let visibility: String
  public let mimeType: String
  public let size: Int64
  public let name: String
  public let createdAt: String
  public let updatedAt: String
}

public struct FileFnFilePage: Codable, Sendable, Equatable {
  public let files: [FileFnFileSummary]
  public let nextCursor: String?
}

public struct FileFnVersionSummary: Codable, Sendable, Equatable {
  public let versionId: String
  public let size: Int64
  public let mimeType: String
  public let createdAt: String
}

public struct FileFnVersionDetail: Codable, Sendable, Equatable {
  public let versionId: String
  public let fileId: String
  public let size: Int64
  public let mimeType: String
  public let createdAt: String
}

public struct FileFnDownloadDescriptor: Codable, Sendable, Equatable {
  public let url: URL
  public let headers: [String: String]
}

public struct FileFnArtifactDescriptor: Codable, Sendable, Equatable {
  public let artifactId: String
  public let fileId: String
  public let versionId: String
  public let kind: String
  public let mimeType: String
  public let size: Int64
  public let createdAt: String
}

public enum FileFnRenderIntent: String, Codable, Sendable {
  case thumbnail
  case preview
  case full
  case download
}

public enum FileFnRenderState: String, Codable, Sendable {
  case ready
  case processing
  case pendingLocal
  case unsupported
}

public enum FileFnRenderPlaceholderKind: String, Codable, Sendable {
  case genericFile = "generic-file"
  case pdfProcessing = "pdf-processing"
  case unsupportedPreview = "unsupported-preview"
}

public struct FileFnRenderDescriptor: Codable, Sendable, Equatable {
  public struct Source: Codable, Sendable, Equatable {
    public let mode: String
    public let artifactId: String?
    public let artifactKind: String?
    public let url: URL?
    public let headers: [String: String]?
    public let placeholderKind: FileFnRenderPlaceholderKind?
  }

  public let fileId: String
  public let versionId: String
  public let intent: FileFnRenderIntent
  public let state: FileFnRenderState
  public let mimeType: String
  public let name: String
  public let size: Int64
  public let source: Source
  public let warnings: [String]
}

extension FileFnClient {
  public func listFiles(cursor: String? = nil, limit: Int? = nil) async throws -> FileFnFilePage
  public func getFile(fileId: String) async throws -> FileFnFileDetail
  public func deleteFile(fileId: String) async throws
  public func listVersions(fileId: String) async throws -> [FileFnVersionSummary]
  public func getVersion(fileId: String, versionId: String) async throws -> FileFnVersionDetail
  public func downloadURL(fileId: String, versionId: String? = nil) async throws -> FileFnDownloadDescriptor
  public func listArtifacts(fileId: String) async throws -> [FileFnArtifactDescriptor]
  public func downloadArtifact(fileId: String, artifactId: String) async throws -> FileFnDownloadDescriptor
  public func resolveRenderable(fileId: String, intent: FileFnRenderIntent, versionId: String? = nil) async throws -> FileFnRenderDescriptor
}
```

## Policies, quota, grants, shares, and processing

```swift
public struct FileFnPolicySummary: Codable, Sendable, Equatable {
  public let name: String
  public let maxSizeBytes: Int64?
  public let contentTypes: [String]?
  public let visibility: String?
}

public struct FileFnStorageQuota: Codable, Sendable, Equatable {
  public let current: Int64
  public let limit: Int64
}

public struct FileFnCreateGrantRequest: Codable, Sendable, Equatable {
  public var userId: String?
  public var role: String?
  public var tenantId: String?
  public var canRead: Bool?
  public var canWrite: Bool?
  public var canDelete: Bool?
  public var canShare: Bool?
  public var expiresAt: String?
}

public struct FileFnPermissionGrant: Codable, Sendable, Equatable {
  public let permissionId: String
  public let fileId: String
  public let userId: String?
  public let role: String?
  public let tenantId: String?
  public let canRead: Bool
  public let canWrite: Bool
  public let canDelete: Bool
  public let canShare: Bool
  public let expiresAt: String?
  public let createdAt: String
}

public struct FileFnCreateShareLinkRequest: Codable, Sendable, Equatable {
  public var versionId: String?
  public var expiresAt: String?
  public var requiresAuth: Bool?
  public var maxDownloads: Int?
}

public struct FileFnShareLink: Codable, Sendable, Equatable {
  public let token: String
  public let expiresAt: String?
}

public struct FileFnShareLinkSummary: Codable, Sendable, Equatable {
  public let tokenHashPrefix: String
  public let fileId: String
  public let versionId: String?
  public let expiresAt: String?
  public let requiresAuth: Bool
  public let maxDownloads: Int?
  public let downloads: Int
  public let createdAt: String
  public let revokedAt: String?
}

public struct FileFnShareDownloadDescriptor: Codable, Sendable, Equatable {
  public let url: URL
  public let headers: [String: String]
  public let fileName: String
  public let mimeType: String
}

public struct FileFnTriggerProcessingRequest: Codable, Sendable, Equatable {
  public var versionId: String?
  public var storageKey: String
  public var mimeType: String
  public var size: Int64
  public var fileName: String
}

public struct FileFnProcessingStatus: Codable, Sendable, Equatable {
  public let started: Bool
  public let enqueued: Bool
  public let jobId: String?
}

extension FileFnClient {
  public func listPolicies() async throws -> [FileFnPolicySummary]
  public func getStorageQuota() async throws -> FileFnStorageQuota
  public func createGrant(fileId: String, request: FileFnCreateGrantRequest) async throws -> FileFnPermissionGrant
  public func listGrants(fileId: String) async throws -> [FileFnPermissionGrant]
  public func revokeGrant(fileId: String, permissionId: String) async throws
  public func createShareLink(fileId: String, request: FileFnCreateShareLinkRequest) async throws -> FileFnShareLink
  public func listShareLinks(fileId: String) async throws -> [FileFnShareLinkSummary]
  public func revokeShareLink(fileId: String, token: String) async throws
  public func resolveShareDownload(token: String) async throws -> FileFnShareDownloadDescriptor
  public func triggerProcessing(fileId: String, request: FileFnTriggerProcessingRequest) async throws -> FileFnProcessingStatus
}
```

## Upload, preprocessing, and background coordination

```swift
public enum FileFnUploadSource: Sendable, Equatable {
  case fileURL(URL)
  case data(Data)
}

public protocol FileFnUploadPreprocessor: Sendable {
  func matches(_ context: FileFnUploadContext) async throws -> Bool
  func process(_ context: FileFnUploadContext) async throws -> FileFnPreparedUpload
}

public struct FileFnUploadContext: Sendable, Equatable {
  public let fileId: String
  public let fileName: String
  public let mimeType: String
  public let metadata: [String: FileFnJSONValue]
  public let localFileURL: URL?
}

public struct FileFnPreparedUpload: Sendable, Equatable {
  public let source: FileFnUploadSource
  public let fileName: String
  public let mimeType: String
  public let metadata: [String: FileFnJSONValue]
}

public struct FileFnCreateUploadSessionRequest: Codable, Sendable, Equatable {
  public var policy: String
  public var fileName: String
  public var size: Int64
  public var mimeType: String
  public var fileId: String?
  public var metadata: [String: FileFnJSONValue]
  public var idempotencyKey: String?
}

public struct FileFnUploadSession: Codable, Sendable, Equatable {
  public let uploadSessionId: String
  public let uploadSessionToken: String?
  public let uploadMode: String
  public let chunkSizeBytes: Int64
  public let totalParts: Int
  public let expiresAt: String
  public let warnings: [String]
}

public struct FileFnUploadStatus: Codable, Sendable, Equatable {
  public let uploadSessionId: String
  public let status: String
  public let recordedParts: [Int]
  public let uploadedParts: [Int]
  public let totalParts: Int
  public let chunkSizeBytes: Int64
  public let fileSize: Int64
  public let expiresAt: String?
}

public struct FileFnSignedPart: Codable, Sendable, Equatable {
  public let url: URL
  public let headers: [String: String]
  public let expiresAt: String
}

public struct FileFnUploadResult: Codable, Sendable, Equatable {
  public let fileId: String
  public let versionId: String
}

public enum FileFnUploadEvent: Sendable, Equatable {
  case queued(uploadID: String, fileId: String)
  case sessionCreated(uploadID: String, fileId: String, uploadSessionId: String, totalParts: Int, chunkSizeBytes: Int64)
  case partProgress(uploadID: String, partNumber: Int, bytesSent: Int64, bytesExpected: Int64, aggregateBytesSent: Int64, aggregateBytesExpected: Int64)
  case partCompleted(uploadID: String, partNumber: Int, etag: String)
  case completed(FileFnUploadResult)
  case failed(FileFnClientError)
  case cancelled(uploadID: String)
}

public struct FileFnUploadRequest: Sendable, Equatable {
  public var policy: String
  public var source: FileFnUploadSource
  public var fileName: String?
  public var mimeType: String?
  public var metadata: [String: FileFnJSONValue]
  public var fileId: String?
  public var idempotencyKey: String?
  public var preprocessors: [any FileFnUploadPreprocessor]
}

public struct FileFnBackgroundUploadRequest: Sendable, Equatable {
  public var policy: String
  public var fileURL: URL
  public var fileName: String?
  public var mimeType: String?
  public var metadata: [String: FileFnJSONValue]
  public var fileId: String?
  public var idempotencyKey: String?
  public var preprocessors: [any FileFnUploadPreprocessor]
}

public protocol FileFnSecretStore: Sendable {
  func put(_ value: String, forKey key: String) async throws
  func get(_ key: String) async throws -> String?
  func remove(_ key: String) async throws
}

public protocol FileFnUploadStateStore: Sendable {
  func save(_ snapshot: FileFnBackgroundUploadSnapshot) async throws
  func load(uploadID: String) async throws -> FileFnBackgroundUploadSnapshot?
  func list() async throws -> [FileFnBackgroundUploadSnapshot]
  func remove(uploadID: String) async throws
}

public struct FileFnBackgroundUploadConfiguration: Sendable, Equatable {
  public var sessionIdentifier: String
  public var workingDirectory: URL
  public var retryPolicy: FileFnRetryPolicy
}

public struct FileFnBackgroundUploadSnapshot: Codable, Sendable, Equatable {
  public let uploadID: String
  public let fileId: String
  public let uploadSessionId: String?
  public let totalParts: Int?
  public let completedParts: [Int]
  public let status: String
}

public protocol FileFnUploadTask: Sendable {
  var uploadID: String { get }
  var fileId: String { get }
  func events() -> AsyncThrowingStream<FileFnUploadEvent, Error>
  func result() async throws -> FileFnUploadResult
  func cancel() async throws
}

public actor FileFnForegroundUploader {
  public init(client: FileFnClient)
  public func start(_ request: FileFnUploadRequest) async throws -> any FileFnUploadTask
}

public actor FileFnBackgroundUploader {
  public init(
    client: FileFnClient,
    configuration: FileFnBackgroundUploadConfiguration,
    stateStore: any FileFnUploadStateStore,
    secretStore: any FileFnSecretStore
  )

  public func enqueue(_ request: FileFnBackgroundUploadRequest) async throws -> any FileFnUploadTask
  public func recover() async throws -> [FileFnBackgroundUploadSnapshot]
  public func snapshot(uploadID: String) async throws -> FileFnBackgroundUploadSnapshot?
}

extension FileFnClient {
  public func createUploadSession(_ request: FileFnCreateUploadSessionRequest) async throws -> FileFnUploadSession
  public func getUploadStatus(uploadSessionId: String, uploadSessionToken: String? = nil) async throws -> FileFnUploadStatus
  public func signUploadPart(uploadSessionId: String, partNumber: Int, contentLength: Int64, uploadSessionToken: String? = nil) async throws -> FileFnSignedPart
  public func completeUploadPart(uploadSessionId: String, partNumber: Int, etag: String, size: Int64, uploadSessionToken: String? = nil) async throws
  public func completeUploadSession(uploadSessionId: String, uploadSessionToken: String? = nil) async throws -> FileFnUploadResult
  public func abortUploadSession(uploadSessionId: String, uploadSessionToken: String? = nil) async throws
}
```

## Bridge protocol surface

```typescript
export const FILEFN_BRIDGE_METHODS = [
  "handshake",
  "file.list",
  "file.get",
  "file.delete",
  "version.list",
  "version.get",
  "download.resolve",
  "artifact.list",
  "artifact.download",
  "render.resolve",
  "policy.list",
  "quota.get",
  "grant.create",
  "grant.list",
  "grant.revoke",
  "share.create",
  "share.list",
  "share.revoke",
  "share.download.resolve",
  "processing.trigger",
  "upload.start",
  "upload.status",
  "upload.abort",
  "health.check",
] as const;

export const FILEFN_BRIDGE_EVENT_NAMES = [
  "bridge.ready",
  "bridge.closed",
  "upload.progress",
  "upload.completed",
  "upload.failed",
  "upload.cancelled",
  "health.changed",
] as const;

export interface FileFnBridgeRequestEnvelope {
  protocol: "filefn-bridge/v1";
  id: string;
  method: (typeof FILEFN_BRIDGE_METHODS)[number];
  payload?: unknown;
}

export type FileFnBridgeResponseEnvelope =
  | { protocol: "filefn-bridge/v1"; id: string; ok: true; result: unknown }
  | { protocol: "filefn-bridge/v1"; id: string; ok: false; error: FileFnBridgeError };

export interface FileFnBridgeEventEnvelope {
  protocol: "filefn-bridge/v1";
  event: (typeof FILEFN_BRIDGE_EVENT_NAMES)[number];
  payload: unknown;
}

export interface FileFnBridgeError {
  code:
    | "BRIDGE_PROTOCOL_MISMATCH"
    | "BRIDGE_METHOD_UNSUPPORTED"
    | "BRIDGE_UNAVAILABLE"
    | "BRIDGE_INVALID_SOURCE"
    | "NATIVE_ASSET_NOT_FOUND";
  message: string;
  details?: Record<string, unknown>;
}
```

## SwiftUI support surface

```swift
public struct FileFnImportedAsset: Sendable, Equatable {
  public let fileURL: URL
  public let fileName: String
  public let mimeType: String
}

@MainActor
public final class FileFnUploadObservable: ObservableObject {
  @Published public private(set) var status: String
  @Published public private(set) var aggregateBytesSent: Int64
  @Published public private(set) var aggregateBytesExpected: Int64
  @Published public private(set) var latestError: FileFnClientError?

  public init(task: any FileFnUploadTask)
}

public enum FileFnPhotosPickerLoader {
  public static func load(item: PhotosPickerItem) async throws -> FileFnImportedAsset
}

public enum FileFnFileImporterLoader {
  public static func load(url: URL) async throws -> FileFnImportedAsset
}
```

## HTTP route map consumed by the Swift client

| Method | Path | Capability | Response |
| --- | --- | --- | --- |
| `GET` | `/` | always | `FileFnFilePage` |
| `GET` | `/{fileId}` | always | `FileFnFileDetail` |
| `DELETE` | `/{fileId}` | always | `{ deleted: true }` |
| `GET` | `/{fileId}/download` | always | `FileFnDownloadDescriptor` |
| `GET` | `/{fileId}/render?intent=...&versionId=...` | always | `FileFnRenderDescriptor` |
| `GET` | `/{fileId}/versions` | always | `{ versions: [FileFnVersionSummary] }` |
| `GET` | `/{fileId}/versions/{versionId}` | always | `FileFnVersionDetail` |
| `GET` | `/{fileId}/versions/{versionId}/download` | always | `FileFnDownloadDescriptor` |
| `POST` | `/upload/init` | always | `FileFnUploadSession` |
| `GET` | `/upload/{uploadSessionId}/status` | always | `FileFnUploadStatus` |
| `POST` | `/upload/{uploadSessionId}/parts/{partNumber}/sign` | always | `FileFnSignedPart` |
| `PUT` | `/upload/{uploadSessionId}/parts/{partNumber}` | proxy upload mode only | `{ etag, recorded }` |
| `POST` | `/upload/{uploadSessionId}/parts/{partNumber}/complete` | always | `{ recorded: true }` |
| `POST` | `/upload/{uploadSessionId}/complete` | always | `FileFnUploadResult` |
| `POST` | `/upload/{uploadSessionId}/abort` | always | `{ aborted: true }` |
| `GET` | `/{fileId}/artifacts` | processing mounted | `{ artifacts: [FileFnArtifactDescriptor] }` |
| `GET` | `/{fileId}/artifacts/{artifactId}/download` | processing mounted | `FileFnDownloadDescriptor` |
| `GET` | `/policies` | policies mounted | `{ policies: [FileFnPolicySummary] }` |
| `GET` | `/quota/storage` | quota mounted | `FileFnStorageQuota` |
| `POST` | `/{fileId}/permissions` | grants mounted | `FileFnPermissionGrant` |
| `GET` | `/{fileId}/permissions` | grants mounted | `{ permissions: [FileFnPermissionGrant] }` |
| `DELETE` | `/{fileId}/permissions/{permissionId}` | grants mounted | `{ revoked: true }` |
| `POST` | `/{fileId}/share-links` | shares mounted | `FileFnShareLink` |
| `GET` | `/{fileId}/share-links` | shares mounted | `{ shares: [FileFnShareLinkSummary] }` |
| `DELETE` | `/{fileId}/share-links/{token}` | shares mounted | `{ revoked: true }` |
| `GET` | `/share-links/{token}/download` | shares mounted | `FileFnShareDownloadDescriptor` |
| `POST` | `/{fileId}/process` | processing mounted | `{ processing: FileFnProcessingStatus }` |

## Bridge protocol request/response/event shapes

Handshake request:

```json
{
  "protocol": "filefn-bridge/v1",
  "id": "bridge_req_001",
  "method": "handshake",
  "payload": {
    "clientId": "ios-webview-shell",
    "mode": "native-backed",
    "baseURL": "https://api.example.com/filefn"
  }
}
```

Handshake success result:

```json
{
  "bridgeVersion": 1,
  "uploadOwner": "native",
  "authOwner": "native",
  "previewScheme": "filefn-bridge",
  "capabilities": [
    "files",
    "uploads",
    "render",
    "shares",
    "grants",
    "processing",
    "events",
    "health"
  ]
}
```

Native-backed upload request:

```json
{
  "protocol": "filefn-bridge/v1",
  "id": "bridge_req_002",
  "method": "upload.start",
  "payload": {
    "policy": "public-image",
    "assetHandle": "asset_001",
    "fileId": "file_native_001",
    "background": true,
    "metadata": {
      "source": "webview"
    }
  }
}
```

Native-backed upload success result:

```json
{
  "uploadID": "upload_native_001",
  "fileId": "file_native_001"
}
```

Progress event:

```json
{
  "protocol": "filefn-bridge/v1",
  "event": "upload.progress",
  "payload": {
    "uploadID": "upload_native_001",
    "fileId": "file_native_001",
    "bytesSent": 1048576,
    "bytesExpected": 2097152,
    "status": "in_progress"
  }
}
```

# Data formats / protocol

## Canonical envelopes

Successful JSON routes MUST decode either of these success forms:

```json
{
  "ok": true,
  "data": { "fileId": "file_001" },
  "warnings": [],
  "requestId": "req_001"
}
```

```json
{
  "ok": true,
  "data": { "permissions": [] },
  "requestId": "req_002"
}
```

Error JSON routes MUST decode this shape:

```json
{
  "ok": false,
  "error": {
    "code": "FILEFN_NOT_FOUND",
    "message": "File not found",
    "details": {}
  },
  "requestId": "req_003"
}
```

Rules:

1. The client MUST treat missing `warnings` as `[]`.
2. The client MUST reject `ok: true` responses that omit `data`.
3. The client MUST reject `ok: false` responses that omit `error.code` or `error.message`.
4. Non-JSON success or error bodies for JSON endpoints MUST surface as `FileFnClientError.transport` or `FileFnClientError.invalidResponse`.

## Bridge envelopes

Native-backed WebView requests, responses, and events MUST use the `filefn-bridge/v1` envelopes defined in the Public API section.

Rules:

1. `handshake` MUST be the first request issued by `createNativeBackedFileFnClient`.
2. A bridge response with `ok: false` MUST surface the exact `FileFnBridgeError` payload to JavaScript callers.
3. `bridge.ready` MUST be emitted only after a successful handshake and capability resolution.
4. Native-backed upload responses/events MUST NOT include `uploadSessionToken`, auth headers, signed URL query strings, or absolute local file paths.

## JSON value model

The client MUST ship a `FileFnJSONValue` type that can encode/decode:

- string
- number
- boolean
- null
- array of `FileFnJSONValue`
- object keyed by `String` with `FileFnJSONValue` values

This type is required for metadata, server error details, and future-compatible fields.

## Headers

The Swift client MUST support these headers:

- `Authorization` or any caller-provided auth header set via `FileFnAuthProvider`.
- `x-request-id` when `requestIDProvider` returns a non-empty value.
- `x-idempotency-key` on `POST /upload/init` whenever an idempotency key is available.
- `x-upload-session-token` on upload follow-up calls whenever the session was anonymous.
- `x-filefn-client-version` when `sendClientVersionHeader == true`.

Rules:

1. The client MUST send `x-idempotency-key` as an HTTP header, not only in JSON, because the current FileFn HTTP route reads idempotency from the header.
2. The client MUST preserve caller-provided auth headers when also sending upload-session headers.
3. The client MUST NOT persist auth headers to disk.

## Route-specific request/response shapes

### `GET /`

Request query:

```json
{
  "cursor": "optional opaque string",
  "limit": 20
}
```

Success payload:

```json
{
  "files": [
    {
      "fileId": "file_003",
      "currentVersionId": "ver_003",
      "ownerId": "user_123",
      "tenantId": "org_123",
      "visibility": "private",
      "policy": "public-image",
      "mimeType": "image/png",
      "size": 123,
      "name": "avatar.png",
      "metadata": {},
      "createdAt": "2026-03-20T12:00:00.000Z",
      "updatedAt": "2026-03-20T16:00:00.000Z"
    }
  ],
  "nextCursor": "opaque cursor or omitted"
}
```

### `GET /{fileId}`

Success payload:

```json
{
  "fileId": "file_003",
  "currentVersionId": "ver_003",
  "ownerId": "user_123",
  "tenantId": "org_123",
  "visibility": "private",
  "mimeType": "image/png",
  "size": 123,
  "name": "avatar.png",
  "createdAt": "2026-03-20T12:00:00.000Z",
  "updatedAt": "2026-03-20T16:00:00.000Z"
}
```

### `GET /{fileId}/versions`

Success payload:

```json
{
  "versions": [
    {
      "versionId": "ver_003",
      "size": 123,
      "mimeType": "image/png",
      "createdAt": "2026-03-20T12:00:00.000Z"
    }
  ]
}
```

### `GET /{fileId}/download` and `GET /{fileId}/artifacts/{artifactId}/download`

Success payload:

```json
{
  "url": "https://storage.example.com/download-or-relative-proxy",
  "headers": {
    "x-extra-header": "optional"
  }
}
```

### `GET /{fileId}/render`

Success payload example:

```json
{
  "fileId": "file_pdf_001",
  "versionId": "ver_pdf_001",
  "intent": "preview",
  "state": "processing",
  "mimeType": "application/pdf",
  "name": "spec.pdf",
  "size": 2048,
  "source": {
    "mode": "placeholder",
    "placeholderKind": "pdf-processing"
  },
  "warnings": ["PDF preview artifact is not available yet."]
}
```

### `POST /upload/init`

JSON request body:

```json
{
  "policy": "public-image",
  "fileName": "avatar.png",
  "size": 2097152,
  "mimeType": "image/png",
  "fileId": "file_generated_or_caller_supplied",
  "metadata": { "source": "ios" }
}
```

Success payload:

```json
{
  "uploadSessionId": "upl_001",
  "uploadSessionToken": "upls_live_anon_001",
  "uploadMode": "multipart-signed-url",
  "chunkSizeBytes": 8388608,
  "totalParts": 1,
  "expiresAt": "2026-03-28T07:16:42Z",
  "warnings": []
}
```

### `GET /upload/{uploadSessionId}/status`

Success payload:

```json
{
  "uploadSessionId": "upl_001",
  "status": "in_progress",
  "recordedParts": [1],
  "uploadedParts": [1],
  "totalParts": 3,
  "chunkSizeBytes": 8388608,
  "fileSize": 18000000,
  "expiresAt": "2026-03-28T07:16:42Z"
}
```

### `POST /upload/{uploadSessionId}/parts/{partNumber}/sign`

JSON request body:

```json
{
  "contentLength": 8388608
}
```

Success payload:

```json
{
  "url": "https://storage.example.com/upload/part/1",
  "headers": {
    "content-type": "image/png"
  },
  "expiresAt": "2026-03-27T08:16:42Z"
}
```

### `POST /upload/{uploadSessionId}/parts/{partNumber}/complete`

JSON request body:

```json
{
  "etag": "etag_part_001",
  "size": 8388608
}
```

Success payload:

```json
{
  "recorded": true
}
```

### `POST /upload/{uploadSessionId}/complete`

Success payload:

```json
{
  "fileId": "file_001",
  "versionId": "ver_001"
}
```

### Optional capability routes

Capability routes MAY be absent because `createRouter` only mounts them when the corresponding route family exists. The Swift client MUST therefore distinguish:

1. canonical FileFn errors from mounted routes, and
2. generic 404/405 transport failures from route families that are not mounted at all.

Missing route-family behavior is not an application-level FileFn server error; it is capability unavailability from the client's point of view.

# Semantics

## Configuration and transport

1. `FileFnClient` MUST normalize `baseURL` by removing exactly one trailing slash before path concatenation.
2. `FileFnClient` MUST encode JSON bodies with UTF-8 and set `Content-Type: application/json` on JSON endpoints.
3. `FileFnClient` MUST allow `URLSession` injection for deterministic tests.
4. `FileFnClient` MUST support a configurable retry policy. Default retries MUST apply only to safe or idempotent calls:
   - GET requests
   - DELETE file/share/grant routes
   - upload follow-up routes whose tuple semantics are idempotent (`signPart`, `completePart`, `completeUpload`, `abortUpload`)
   - direct PUT upload-part calls when the same bytes are being resent
5. `POST /upload/init` MUST NOT be retried unless an idempotency key is present.

## Topology selection

1. The repo MUST support three explicit FileFn topologies:
   - direct native Swift mode using `FileFnClient`
   - native-backed WebView mode using `FileFnWKWebViewBridgeHost` plus `@filefn/swift-bridge`
   - web-owned mode using the existing `filefn/client`
2. Native-backed WebView mode MUST fail fast when the bridge is unavailable, the bridge protocol version mismatches, or the host does not advertise native-backed mode.
3. Native-backed WebView mode MUST NOT silently fall back to web-owned mode.
4. When the app truly owns a browser `File` or `Blob`, documentation and examples MUST direct callers to web-owned mode rather than tunneling large bytes over the bridge.

## Capability detection

1. `listPolicies`, `getStorageQuota`, grant methods, share methods, and `triggerProcessing` MUST throw `FileFnClientError.capabilityUnavailable` when the endpoint returns a non-canonical 404/405 response.
2. If the server returns canonical `FILEFN_NOT_FOUND` from one of those routes, the client MUST surface that exact server error instead of reclassifying it as capability unavailability.

## File queries, downloads, versions, and render resolution

1. `listFiles` MUST treat `nextCursor` as an opaque string. The client MUST NOT parse, mutate, or regenerate it.
2. `downloadURL`, `downloadArtifact`, and `resolveShareDownload` MUST return both the URL and any headers required to consume that URL.
3. `resolveRenderable` MUST preserve placeholder and warning semantics:
   - image files MAY resolve to original content or image artifacts
   - PDF preview/thumbnail MAY return `state == processing` with `placeholderKind == pdf-processing`
   - unsupported preview types MUST remain `state == unsupported`
4. The client MUST NOT silently fetch the underlying file bytes when resolving descriptors; resolution returns metadata only.

## Upload orchestration

1. Low-level upload APIs MUST preserve FileFn's server-selected `uploadMode` and `chunkSizeBytes`. The client MUST NOT invent its own chunk size when the session already exists.
2. High-level foreground uploads MUST:
   - generate `fileId` if the caller omitted one
   - generate `idempotencyKey` if the caller omitted one
   - run preprocessors before `createUploadSession`
   - create part boundaries exactly from `chunkSizeBytes` and file size
   - support both proxy uploads and signed uploads
   - emit ordered progress events
3. Anonymous sessions MUST persist `uploadSessionToken` until the upload reaches a terminal state.
4. Completion MUST be tuple-idempotent: repeated `completeUploadPart` and repeated `completeUploadSession` calls MUST be handled as safe replays.
5. Native-backed WebView uploads MUST be started from a native asset handle, not a raw bridged byte payload.
6. `FileFnWKWebViewBridgeHost` MUST reuse the native foreground/background uploaders rather than implementing a second upload state machine for WebView mode.
7. Native-backed upload start/status/abort operations MUST be keyed by an opaque `uploadID` that is distinct from `uploadSessionId` and safe to expose to JavaScript.

## Background uploads

1. Background uploads MUST require a disk-backed source file. If the caller supplies a `Data` source, the API MUST reject it for background mode.
2. Background multipart uploads MUST create stable chunk files under a working directory, enqueue upload tasks from those files, and delete those chunk files only after the corresponding part is durably recorded.
3. Recovery on app relaunch MUST:
   - reattach to the configured background `URLSession`
   - reload persisted snapshots
   - reload any persisted anonymous upload session tokens
   - query `getUploadStatus` for incomplete uploads
   - resume only the missing parts
4. Cancellation MUST abort the FileFn upload session when possible, remove persisted snapshots, remove anonymous session tokens, and delete temporary chunk files.
5. If a native-backed WebView upload was enqueued in background mode, relaunch recovery MUST continue to reconcile and resume it even if the WebView has not been recreated yet.
6. After the WebView reconnects and handshakes successfully, `upload.status` plus subsequent `upload.progress`/terminal events MUST allow the JavaScript side to reattach to the native upload lifecycle without creating a second upload session.

## Preprocessors and HEIC behavior

1. The upload system MUST support pluggable preprocessors shared by foreground and background upload paths.
2. The package MUST ship a built-in HEIC preprocessor for Apple platforms.
3. The default HEIC behavior MUST be:
   - match HEIC/HEIF assets
   - transcode to JPEG
   - update MIME type to `image/jpeg`
   - update the filename extension to `.jpg`
   - preserve caller metadata and add `originalMimeType` if it was not already present
4. The HEIC preprocessor MUST be configurable and disable-able.
5. Native-backed WebView uploads MUST run through the same preprocessing pipeline as direct Swift foreground/background uploads when the resolved native asset matches a configured preprocessor.

## SwiftUI integration

1. `FileFnSwiftUI` MUST remain a thin support target, not a full widget library.
2. `FileFnUploadObservable` MUST consume `FileFnUploadTask` events and publish aggregate progress and terminal error/completion state.
3. `FileFnPhotosPickerLoader` and `FileFnFileImporterLoader` MUST materialize imported assets as local file URLs suitable for the upload APIs.
4. The imported assets produced by SwiftUI helpers MUST be usable both for direct native uploads and for registration in `FileFnNativeAssetRegistry` for native-backed WebView mode.

## Native-backed WebView bridge

1. `filefn/swift-bridge` MUST provide a thin `WKWebView` bus plus a FileFn-compatible native-backed client facade. It MUST NOT reimplement browser `Blob` chunking or OPFS semantics.
2. `handshake` MUST validate:
   - bridge protocol version
   - requested mode equals `native-backed`
   - the host is configured for the same FileFn base URL or documents why base URL is informational only
3. The handshake result MUST declare `uploadOwner == native` and `authOwner == native`.
4. `upload.start` MUST accept `assetHandle`, policy metadata, and an optional `background` flag. It MUST NOT accept arbitrary byte arrays, base64 file payloads, or browser `Blob` objects.
5. `upload.start` MUST return an opaque `uploadID` and `fileId`, but MUST NOT return `uploadSessionToken`.
6. Bridge events MUST be sanitized before delivery to JavaScript.
7. Preview descriptors returned to JavaScript for native assets MUST use bridge-local preview URLs or server-returned URLs only.

## Machine-readable contract

1. The repo MUST publish a deterministic OpenAPI 3.1 JSON artifact describing every Swift-supported FileFn route, envelope, header, and optional capability route family.
2. The OpenAPI artifact MUST be generated or assembled from a checked-in source of truth and MUST be validated in tests.
3. The Swift README/examples MUST point maintainers to that contract artifact as the compatibility reference.

# Invariants

1. Generated client `fileId` values MUST use the prefix `file_` followed by a lowercase UUID-derived hex payload with no dashes.
2. Generated client idempotency keys MUST be stable for a single upload attempt and MUST be sent as `x-idempotency-key`.
3. For a single upload, the event order MUST be monotonic:
   - queued
   - sessionCreated
   - zero or more partProgress / partCompleted events in part order
   - one terminal event (`completed`, `failed`, or `cancelled`)
4. `aggregateBytesSent` MUST never decrease for a single upload ID.
5. `recover()` MUST NOT create duplicate upload sessions for the same persisted upload snapshot.
6. Signed-URL/proxy URL strings from the server MUST be treated as opaque. The client MAY prefix relative URLs with `baseURL`, but MUST NOT rewrite query strings or storage hosts.
7. The contract artifact MUST be deterministic under repeated generation on the same repo state.

# Security

1. The client MUST keep auth injection caller-owned. It MAY request auth headers/cookies, but it MUST NOT introspect or transform token formats.
2. Anonymous upload session tokens MUST be stored in a secret store abstraction. The default Apple-platform implementation SHOULD use Keychain.
3. Persisted background upload snapshots MUST NOT contain auth headers, bearer tokens, or signed URLs.
4. Native-backed bridge events and responses MUST NOT contain auth headers, upload session tokens, or absolute file paths.
5. Bridge-local preview URLs MUST be opaque application-controlled URLs such as a custom scheme or local app asset URL. They MUST NOT embed raw absolute filesystem paths.
6. Logs MUST redact:
  - `Authorization`
  - `Cookie`
  - `x-upload-session-token`
  - signed URL query strings
  - absolute local file paths
7. Temporary files and chunk files SHOULD live under an app-controlled cache or application-support directory and SHOULD be marked as excluded from backup where the platform allows it.
8. The client MUST surface server authorization failures exactly as server errors instead of converting them into generic transport errors.

# Limits/caps

1. Core targets MUST support iOS 16.0+ and macOS 13.0+.
2. `listFiles(limit:)` MAY accept any positive integer from callers, but documentation MUST state that the server defaults to 20 and caps at 100.
3. Upload part numbers MUST start at 1 and end at `totalParts`.
4. Background uploads MUST reject missing or unreadable file URLs before any network call is attempted.
5. The package MUST support zero or more warnings in envelopes.
6. The package MAY support additional server error codes without a breaking change by preserving unknown `code` strings in `FileFnServerErrorPayload`.

# Observability

1. The client SHOULD emit structured log events for request start, request failure, session creation, part completion, recovery, cleanup, and bridge lifecycle events.
2. Log metadata MAY include request IDs, upload IDs, file IDs, part numbers, and retry counts.
3. Logs MUST NOT include secret or machine-specific data.
4. The package SHOULD forward `requestId` from server envelopes into emitted log events and surfaced errors when present.
5. Native-backed WebView mode SHOULD emit `bridge.ready`, `bridge.closed`, and upload terminal events in addition to native logger events.

# Compatibility / versioning strategy

1. The Swift package MUST version independently as a SwiftPM library, but it MUST document the FileFn contract revision it targets.
2. Breaking changes to the supported HTTP contract MUST update:
   - the OpenAPI artifact
   - Swift models and tests
   - README compatibility notes
3. Breaking changes to the native-backed bridge protocol MUST update:
   - `FILEFN_BRIDGE_PROTOCOL`
   - Swift bridge host method/event definitions
   - `filefn/swift-bridge` protocol tests and docs
4. Additive bridge capabilities MAY be introduced by extending the handshake capability list and adding new method names without changing existing semantics.
5. Additive server fields MUST decode without breaking existing clients.
6. Unknown optional JSON object members MUST be ignored unless a specific model field is required by this spec.

# Undefined / Explicitly user-deferred only

None. Any behavior not explicitly specified in this document, `REQUIREMENTS.md`, `TEST_VECTORS.md`, `PLAN.md`, or the phase files is undefined and is not required for implementation.

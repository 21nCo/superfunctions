# TEST_VECTORS

## TV-PKG-001

**Description**

Verify that the repo gains a portable SwiftPM package plus a companion native-backed WebView bridge package without introducing a nested monorepo.

**Input**

```text
Files present:
- filefn/swift/Package.swift
- filefn/swift/README.md
- filefn/swift-bridge/package.json
- filefn/swift-bridge/src/index.ts
- .gitignore
- package.json (optional helper scripts)

Commands:
swift build --package-path filefn/swift
npm --workspace filefn/swift-bridge test -- --runInBand
```

**Expected output**

```text
The package resolves and builds successfully from repo root.
```

**Negative variant(s)**

```text
If filefn/swift/Package.swift or filefn/swift-bridge/package.json is missing, the respective package verification fails before compilation/tests.
If either package is nested inside a second package manager layout, repo/package tooling fails before compilation.
If .gitignore omits `.build/`, repo hygiene checks show new Swift build artifacts as untracked output.
```

## TV-CFG-001

**Description**

Verify request construction, auth injection, request ID propagation, and retry gating.

**Input**

```swift
let config = FileFnClientConfiguration(
  baseURL: URL(string: "https://api.example.test/filefn/")!,
  authProvider: HeaderAuthProvider(["Authorization": "Bearer abc"]),
  defaultHeaders: ["x-extra": "1"],
  retryPolicy: .default,
  requestIDProvider: { "req_swift_001" },
  logger: nil,
  sendClientVersionHeader: true,
  urlSession: mockSession,
  jsonEncoder: .init(),
  jsonDecoder: .init()
)

let request = try await client.makeRequest(
  method: "GET",
  path: "/",
  query: ["limit": "2"],
  requiresUploadSessionToken: false
)
```

**Expected output**

```json
{
  "url": "https://api.example.test/filefn/?limit=2",
  "headers": {
    "Authorization": "Bearer abc",
    "x-extra": "1",
    "x-request-id": "req_swift_001"
  },
  "contentType": "application/json"
}
```

**Negative variant(s)**

```text
Input: baseURL = URL(string: "/relative")!
Expected error: FileFnClientError.configurationInvalid(field: "baseURL", message contains "absolute")

Input: POST /upload/init with no idempotency key and default retry policy
Expected behavior: request is sent once; automatic retry is disabled.
```

## TV-ENV-001

**Description**

Verify canonical envelope decoding and missing-warnings normalization.

**Input**

```json
{
  "ok": true,
  "data": {
    "fileId": "file_001",
    "name": "avatar.png"
  },
  "requestId": "req_env_001"
}
```

**Expected output**

```json
{
  "value": {
    "fileId": "file_001",
    "name": "avatar.png"
  },
  "warnings": [],
  "requestId": "req_env_001"
}
```

**Negative variant(s)**

```json
Input:
{
  "ok": true,
  "requestId": "req_env_missing_data"
}

Expected error:
FileFnClientError.invalidResponse(reason contains "data", requestId: "req_env_missing_data")
```

## TV-ERR-001

**Description**

Verify server-error preservation and capability-unavailable detection.

**Input**

```json
{
  "status": 404,
  "body": {
    "ok": false,
    "error": {
      "code": "FILEFN_NOT_FOUND",
      "message": "File not found",
      "details": {}
    },
    "requestId": "req_err_001"
  }
}
```

**Expected output**

```json
{
  "error": "server",
  "status": 404,
  "code": "FILEFN_NOT_FOUND",
  "requestId": "req_err_001"
}
```

**Negative variant(s)**

```text
Request: GET /quota/storage
Transport response: status 404, content-type text/html, body "<html>not found</html>"
Expected error: FileFnClientError.capabilityUnavailable(.quota, status: 404, requestId: nil)
```

## TV-FILE-001

**Description**

Verify file list, file detail, and delete semantics.

**Input**

```json
{
  "request": "GET /?limit=2",
  "response": {
    "ok": true,
    "data": {
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
          "metadata": { "source": "ios" },
          "createdAt": "2026-03-20T12:00:00.000Z",
          "updatedAt": "2026-03-20T16:00:00.000Z"
        }
      ],
      "nextCursor": "cursor_001"
    },
    "requestId": "req_file_001"
  }
}
```

**Expected output**

```json
{
  "files": [
    {
      "fileId": "file_003",
      "policy": "public-image",
      "metadata": { "source": "ios" }
    }
  ],
  "nextCursor": "cursor_001"
}
```

**Negative variant(s)**

```json
Request: GET /file_missing
Expected error envelope:
{
  "ok": false,
  "error": {
    "code": "FILEFN_NOT_FOUND",
    "message": "File not found"
  }
}

Expected client error: FileFnClientError.server(status: 404, code: "FILEFN_NOT_FOUND", ...)
```

## TV-RENDER-001

**Description**

Verify versions, artifacts, download descriptors, and render placeholders.

**Input**

```json
{
  "request": "GET /file_pdf_001/render?intent=preview&versionId=ver_pdf_001",
  "response": {
    "ok": true,
    "data": {
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
    },
    "requestId": "req_render_001"
  }
}
```

**Expected output**

```json
{
  "state": "processing",
  "source": {
    "mode": "placeholder",
    "placeholderKind": "pdf-processing"
  },
  "warnings": ["PDF preview artifact is not available yet."]
}
```

**Negative variant(s)**

```json
Request: GET /file_missing/render?intent=thumbnail
Expected error: FileFnClientError.server(status: 404, code: "FILEFN_NOT_FOUND", ...)
```

## TV-POL-001

**Description**

Verify policy and quota route handling.

**Input**

```json
{
  "policiesResponse": {
    "ok": true,
    "data": {
      "policies": [
        {
          "name": "public-image",
          "maxSizeBytes": 10485760,
          "contentTypes": ["image/png", "image/jpeg"],
          "visibility": "public"
        }
      ]
    }
  },
  "quotaResponse": {
    "ok": true,
    "data": {
      "current": 5120,
      "limit": 10240
    }
  }
}
```

**Expected output**

```json
{
  "policies": [
    {
      "name": "public-image",
      "maxSizeBytes": 10485760
    }
  ],
  "quota": {
    "current": 5120,
    "limit": 10240
  }
}
```

**Negative variant(s)**

```text
Request: GET /quota/storage
Response: generic HTTP 404 with non-JSON body
Expected error: FileFnClientError.capabilityUnavailable(.quota, ...)
```

## TV-GRANT-001

**Description**

Verify create/list/revoke permission-grant flows.

**Input**

```json
{
  "createRequest": {
    "userId": "user_456",
    "canRead": true,
    "canWrite": true,
    "canDelete": false,
    "canShare": false
  },
  "createResponse": {
    "ok": true,
    "data": {
      "permissionId": "perm_001",
      "fileId": "file_001",
      "userId": "user_456",
      "role": null,
      "tenantId": null,
      "canRead": true,
      "canWrite": true,
      "canDelete": false,
      "canShare": false,
      "expiresAt": null,
      "createdAt": "2026-03-27T07:16:42Z"
    }
  }
}
```

**Expected output**

```json
{
  "permissionId": "perm_001",
  "fileId": "file_001",
  "userId": "user_456",
  "canWrite": true
}
```

**Negative variant(s)**

```json
Response:
{
  "ok": false,
  "error": {
    "code": "FILEFN_FORBIDDEN",
    "message": "Access denied"
  }
}

Expected client error: FileFnClientError.server(status: 403, code: "FILEFN_FORBIDDEN", ...)
```

## TV-SHARE-001

**Description**

Verify share-link creation, listing, and download resolution.

**Input**

```json
{
  "createResponse": {
    "ok": true,
    "data": {
      "token": "share_token_001",
      "expiresAt": "2026-03-28T07:16:42Z"
    }
  },
  "downloadResponse": {
    "ok": true,
    "data": {
      "url": "/proxy/share-links/share_token_001/download",
      "fileName": "avatar.png",
      "mimeType": "image/png"
    }
  }
}
```

**Expected output**

```json
{
  "token": "share_token_001",
  "download": {
    "url": "relative proxy URL resolved against baseURL",
    "fileName": "avatar.png",
    "mimeType": "image/png"
  }
}
```

**Negative variant(s)**

```json
Response:
{
  "ok": false,
  "error": {
    "code": "FILEFN_SHARE_EXPIRED",
    "message": "Share link has expired"
  }
}

Expected client error: FileFnClientError.server(status: 410, code: "FILEFN_SHARE_EXPIRED", ...)
```

## TV-PROC-001

**Description**

Verify processing-trigger request/response behavior.

**Input**

```json
{
  "request": {
    "versionId": "ver_001",
    "storageKey": "tenant/file_001/ver_001.png",
    "mimeType": "image/png",
    "size": 123,
    "fileName": "avatar.png"
  },
  "response": {
    "ok": true,
    "data": {
      "processing": {
        "started": true,
        "enqueued": true,
        "jobId": "job_001"
      }
    }
  }
}
```

**Expected output**

```json
{
  "started": true,
  "enqueued": true,
  "jobId": "job_001"
}
```

**Negative variant(s)**

```json
Response:
{
  "ok": false,
  "error": {
    "code": "FILEFN_PROCESSING_ENQUEUE_FAILED",
    "message": "Failed to enqueue processing"
  }
}

Expected client error: FileFnClientError.server(status: 503, code: "FILEFN_PROCESSING_ENQUEUE_FAILED", ...)
```

## TV-UP-001

**Description**

Verify low-level upload-session protocol behavior, including idempotency and anonymous session tokens.

**Input**

```text
Step 1 request:
POST /upload/init
Headers:
  x-idempotency-key: idem_swift_001
Body:
  { "policy": "public-image", "fileName": "avatar.png", "size": 2097152, "mimeType": "image/png", "fileId": "file_swift_001" }

Step 1 response:
{
  "ok": true,
  "data": {
    "uploadSessionId": "upl_001",
    "uploadSessionToken": "upls_anon_001",
    "uploadMode": "multipart-signed-url",
    "chunkSizeBytes": 8388608,
    "totalParts": 1,
    "expiresAt": "2026-03-28T07:16:42Z"
  }
}
```

**Expected output**

```json
{
  "uploadSessionId": "upl_001",
  "uploadSessionToken": "upls_anon_001",
  "headersUsed": {
    "x-idempotency-key": "idem_swift_001"
  }
}
```

**Negative variant(s)**

```json
Request: GET /upload/upl_001/status without x-upload-session-token
Response:
{
  "ok": false,
  "error": {
    "code": "FILEFN_SESSION_TOKEN_REQUIRED",
    "message": "Upload session token required"
  }
}

Expected client error: FileFnClientError.server(status: 401, code: "FILEFN_SESSION_TOKEN_REQUIRED", ...)
```

## TV-UP-002

**Description**

Verify high-level foreground multipart signed upload flow.

**Input**

```text
Local input:
- source file URL to avatar.png
- no fileId
- no idempotencyKey

Server flow:
1. init -> multipart-signed-url, chunkSizeBytes = 8388608, totalParts = 1
2. sign part 1 -> signed URL + headers
3. PUT part 1 to signed URL -> 200, ETag header
4. complete part 1 -> recorded true
5. complete upload -> { fileId: "file_generated", versionId: "ver_001" }
```

**Expected output**

```json
{
  "events": [
    "queued",
    "sessionCreated",
    "partProgress",
    "partCompleted",
    "completed"
  ],
  "result": {
    "fileId": "file_generated",
    "versionId": "ver_001"
  }
}
```

**Negative variant(s)**

```json
Server response on complete:
{
  "ok": false,
  "error": {
    "code": "FILEFN_UPLOAD_INCOMPLETE",
    "message": "Upload incomplete"
  }
}

Expected client error: FileFnClientError.server(status: 409, code: "FILEFN_UPLOAD_INCOMPLETE", ...)
```

## TV-UP-003

**Description**

Verify high-level proxy upload flow and anonymous token reuse.

**Input**

```text
Local input:
- source Data("hello")
- policy text-upload
- anonymous server context

Server flow:
1. init -> proxy mode + uploadSessionToken
2. PUT /upload/{session}/parts/1 with x-upload-session-token
3. complete part 1
4. complete upload
```

**Expected output**

```json
{
  "uploadMode": "proxy",
  "tokenPersistence": "anonymous upload session token stored until terminal completion",
  "result": {
    "fileId": "file_proxy_001",
    "versionId": "ver_proxy_001"
  }
}
```

**Negative variant(s)**

```json
Request: complete part with wrong x-upload-session-token
Response:
{
  "ok": false,
  "error": {
    "code": "FILEFN_SESSION_TOKEN_INVALID",
    "message": "Invalid upload session token"
  }
}

Expected client error: FileFnClientError.server(status: 403, code: "FILEFN_SESSION_TOKEN_INVALID", ...)
```

## TV-BG-001

**Description**

Verify durable background upload recovery after relaunch.

**Input**

```text
State at T0:
- local file URL exists
- init completed with uploadSessionId upl_bg_001 and uploadSessionToken upls_bg_001
- totalParts = 3
- completedParts persisted = [1]
- chunk files exist for parts 2 and 3

At relaunch:
- FileFnBackgroundUploader.recover()
- GET /upload/upl_bg_001/status returns recordedParts [1]
- uploader resumes parts 2 and 3 only
```

**Expected output**

```json
{
  "recoveredSnapshots": [
    {
      "uploadID": "bg_001",
      "uploadSessionId": "upl_bg_001",
      "completedParts": [1]
    }
  ],
  "resumedParts": [2, 3],
  "terminalResult": {
    "fileId": "file_bg_001",
    "versionId": "ver_bg_001"
  }
}
```

**Negative variant(s)**

```text
State corruption:
- persisted snapshot references missing chunk file for part 2

Expected error:
FileFnClientError.backgroundStateCorrupt(uploadID: "bg_001", reason contains "missing chunk")

Expected side effect:
- snapshot remains marked failed or is cleaned up according to the implementation's documented terminal-failure policy.
```

## TV-BRIDGE-001

**Description**

Verify native-backed WebView bridge handshake semantics and fail-fast behavior.

**Input**

```json
{
  "request": {
    "protocol": "filefn-bridge/v1",
    "id": "bridge_req_001",
    "method": "handshake",
    "payload": {
      "clientId": "ios-webview-shell",
      "mode": "native-backed",
      "baseURL": "https://api.example.test/filefn"
    }
  }
}
```

**Expected output**

```json
{
  "protocol": "filefn-bridge/v1",
  "id": "bridge_req_001",
  "ok": true,
  "result": {
    "bridgeVersion": 1,
    "uploadOwner": "native",
    "authOwner": "native",
    "previewScheme": "filefn-bridge",
    "capabilities": ["files", "uploads", "render", "shares", "grants", "processing", "events", "health"]
  }
}
```

**Negative variant(s)**

```json
Input:
{
  "protocol": "filefn-bridge/v1",
  "id": "bridge_req_002",
  "method": "handshake",
  "payload": {
    "clientId": "ios-webview-shell",
    "mode": "web-owned",
    "baseURL": "https://api.example.test/filefn"
  }
}

Expected error:
{
  "protocol": "filefn-bridge/v1",
  "id": "bridge_req_002",
  "ok": false,
  "error": {
    "code": "BRIDGE_PROTOCOL_MISMATCH",
    "message": "Native-backed mode mismatch"
  }
}

And the JS bridge client throws a stable bridge error instead of silently falling back to browser-owned upload behavior.
```

## TV-BRIDGE-002

**Description**

Verify native-backed upload ownership, asset-handle routing, and no-token leakage into JavaScript.

**Input**

```text
Registered native asset:
- assetHandle = asset_001
- fileURL = local cache file URL
- fileName = avatar.heic
- mimeType = image/heic

Bridge flow:
1. handshake succeeds
2. upload.start({ policy: "public-image", assetHandle: "asset_001", background: true })
3. Swift host resolves asset_001 to the native file URL
4. Swift host runs the same upload pipeline used by FileFnBackgroundUploader
5. Bridge emits upload.progress and upload.completed
```

**Expected output**

```json
{
  "startResult": {
    "uploadID": "upload_native_001",
    "fileId": "file_native_001"
  },
  "observedEvents": [
    {
      "event": "upload.progress",
      "payload": {
        "uploadID": "upload_native_001",
        "bytesSent": 1048576,
        "bytesExpected": 2097152
      }
    },
    {
      "event": "upload.completed",
      "payload": {
        "uploadID": "upload_native_001",
        "result": {
          "fileId": "file_native_001",
          "versionId": "ver_native_001"
        }
      }
    }
  ],
  "bridgePayloadsDoNotContain": [
    "uploadSessionToken",
    "Authorization",
    "/private/var/"
  ]
}
```

**Negative variant(s)**

```json
Input:
{
  "protocol": "filefn-bridge/v1",
  "id": "bridge_req_003",
  "method": "upload.start",
  "payload": {
    "policy": "public-image",
    "blob": "base64:AAAA"
  }
}

Expected error:
{
  "protocol": "filefn-bridge/v1",
  "id": "bridge_req_003",
  "ok": false,
  "error": {
    "code": "BRIDGE_INVALID_SOURCE",
    "message": "Native-backed uploads require assetHandle"
  }
}
```

## TV-SEC-001

**Description**

Verify secret handling, bridge redaction, and preview URL sanitization.

**Input**

```json
{
  "logEvent": {
    "headers": {
      "Authorization": "Bearer secret_auth",
      "x-upload-session-token": "upls_secret_001"
    },
    "signedURL": "https://storage.example.com/upload?X-Amz-Signature=secret",
    "filePath": "/private/var/mobile/Containers/Data/Application/UUID/tmp/avatar.png",
    "bridgeEvent": {
      "event": "upload.progress",
      "payload": {
        "Authorization": "Bearer bridge_secret",
        "uploadSessionToken": "upls_bridge_001",
        "previewURL": "filefn-bridge://asset/asset_001/preview",
        "sourcePath": "/private/var/mobile/Containers/Data/Application/UUID/tmp/avatar.png"
      }
    }
  }
}
```

**Expected output**

```json
{
  "loggedMetadata": {
    "Authorization": "[REDACTED]",
    "x-upload-session-token": "[REDACTED]",
    "signedURL": "https://storage.example.com/upload?[REDACTED_QUERY]",
    "filePath": "avatar.png"
  },
  "bridgePayload": {
    "Authorization": "[REDACTED]",
    "uploadSessionToken": "[REDACTED]",
    "previewURL": "filefn-bridge://asset/asset_001/preview",
    "sourcePath": "avatar.png"
  }
}
```

**Negative variant(s)**

```text
If a log sink or bridge event sink receives the raw bearer token, raw upload session token, signed URL query string, or absolute file path, the test fails.
```

## TV-HEIC-001

**Description**

Verify built-in HEIC preprocessing.

**Input**

```text
Local asset:
- fileURL: photo.HEIC
- mimeType: image/heic
- metadata: { "album": "camera-roll" }
```

**Expected output**

```json
{
  "preparedUpload": {
    "fileName": "photo.jpg",
    "mimeType": "image/jpeg",
    "metadata": {
      "album": "camera-roll",
      "originalMimeType": "image/heic"
    }
  }
}
```

**Negative variant(s)**

```text
If the HEIC asset cannot be transcoded, the uploader throws FileFnClientError.preprocessingFailed(code: "FILEFN_HEIC_CONVERSION_FAILED", ...), and no upload session is created.
```

## TV-UI-001

**Description**

Verify SwiftUI helper behavior for direct uploads and native-backed WebView asset registration.

**Input**

```text
1. A mock FileFnUploadTask emits:
   queued -> sessionCreated -> partProgress(50/100) -> completed
2. A PhotosPickerItem resolves to a temporary imported file named avatar.heic with MIME image/heic
3. The imported file is registered in FileFnNativeAssetRegistry as asset_001
```

**Expected output**

```json
{
  "observable": {
    "status": "completed",
    "aggregateBytesSent": 100,
    "aggregateBytesExpected": 100,
    "latestError": null
  },
  "importedAsset": {
    "fileName": "avatar.heic",
    "mimeType": "image/heic",
    "fileURL": "local temporary file URL"
  },
  "registeredAsset": {
    "assetHandle": "asset_001",
    "previewURL": "filefn-bridge://asset/asset_001/preview"
  }
}
```

**Negative variant(s)**

```text
If the picker item cannot supply data or a file representation, the loader throws FileFnClientError.fileAccess(reason contains "import").
If native asset registration is attempted with an unreadable file URL, registration fails before any bridge upload is started.
```

## TV-CONTRACT-001

**Description**

Verify the deterministic OpenAPI contract artifact.

**Input**

```text
Artifact path:
filefn/server/contracts/filefn-client-v1.openapi.json

Validation command:
npm test -- --run filefn/server/tests/client-contract.test.ts
```

**Expected output**

```json
{
  "openapi": "3.1.0",
  "paths": {
    "/upload/init": {},
    "/{fileId}/render": {},
    "/{fileId}/share-links": {},
    "/share-links/{token}/download": {}
  }
}
```

**Negative variant(s)**

```text
If the artifact omits `x-idempotency-key`, `x-upload-session-token`, or one of the mounted route families supported by the Swift client, the contract test fails with a deterministic diff.
```

## TV-TEST-001

**Description**

Verify local unit/integration test execution.

**Input**

```text
Commands:
swift test --package-path filefn/swift
swift test --package-path filefn/swift --filter FileFnWebViewBridgeHostTests
npm --workspace filefn/swift-bridge test

With demo server running:
FILEFN_BASE_URL=http://127.0.0.1:3001/filefn swift test --package-path filefn/swift --filter FileFnIntegrationTests
```

**Expected output**

```text
All unit and integration tests pass from repo root.
```

**Negative variant(s)**

```text
If the package lacks tests for background recovery, bridge handshake/native-backed upload behavior, envelope decoding, or integration against the demo server, the verification matrix is incomplete and the requirement is not satisfied.
```

## TV-DOC-001

**Description**

Verify documentation completeness and portability.

**Input**

```text
File:
filefn/swift/README.md
filefn/swift-bridge/README.md

Expected sections:
- Installation
- Configuration
- Foreground upload
- Background upload recovery
- Native-backed WebView mode
- SwiftUI helpers
- Capability routes
- Contract artifact
- Local verification commands
```

**Expected output**

```text
READMEs include all required sections and only repo-relative commands/paths.
```

**Negative variant(s)**

```text
If the READMEs reference absolute filesystem paths, CocoaPods, or Carthage, omit native-backed WebView guidance, or omit the contract artifact and verification commands, the documentation requirement fails.
```

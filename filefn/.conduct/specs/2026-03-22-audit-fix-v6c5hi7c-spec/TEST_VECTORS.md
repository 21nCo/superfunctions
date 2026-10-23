# TEST_VECTORS.md

## TV-BUILD-001
- Description: All touched FileFn and Nucleus verification surfaces are green.
- Input:
```json
{
  "commands": [
    "npm --prefix filefn/server test -- --run",
    "npm --prefix filefn/server run typecheck",
    "npm --prefix filefn/server run build",
    "npm --prefix filefn/client test -- --run",
    "npm --prefix filefn/client run typecheck",
    "npm --prefix filefn/client run build",
    "npm --prefix filefn/processing test -- --run",
    "npm --prefix filefn/viewer test -- --run",
    "python3 -m pytest filefn/python/tests",
    "npm --prefix /Users/serro/Documents/dev/n/nucleus/tests test"
  ]
}
```
- Expected output:
```json
{
  "result": "all_commands_exit_0"
}
```
- Negative variant(s):
  - If any package is unbuildable or missing tests, the phase fails and the bundle is not complete.

## TV-API-001
- Description: Render and artifact routes use canonical envelopes.
- Input:
```json
{
  "request": "GET /file_123/render?intent=thumbnail",
  "headers": {
    "x-request-id": "req_api_001"
  }
}
```
- Expected output:
```json
{
  "ok": true,
  "data": {
    "fileId": "file_123",
    "intent": "thumbnail",
    "state": "ready"
  },
  "requestId": "req_api_001"
}
```
- Negative variant(s):
  - Unknown file returns `ok:false` with `FILEFN_NOT_FOUND` and the same `requestId`.

## TV-AUTH-001
- Description: Anonymous init replay returns the original token and continuation remains bound.
- Input:
```json
{
  "init": {
    "policy": "nucleus-durable-default",
    "fileName": "note.pdf",
    "size": 1234,
    "mimeType": "application/pdf",
    "idempotencyKey": "idem_anon_001"
  },
  "context": {
    "principalId": null,
    "tenantId": null
  }
}
```
- Expected output:
```json
{
  "first": {
    "uploadSessionToken": "same-token"
  },
  "replay": {
    "uploadSessionToken": "same-token"
  }
}
```
- Negative variant(s):
  - Replaying the same key with a different payload returns `FILEFN_IDEMPOTENCY_CONFLICT`.
  - Continuing the upload with a missing or wrong token returns `FILEFN_INVALID_UPLOAD_SESSION_TOKEN`.

## TV-AUTH-002
- Description: Replace completion re-checks write authorization and render access is bound.
- Input:
```json
{
  "session": {
    "fileId": "file_existing"
  },
  "initContext": {
    "principalId": "user_1"
  },
  "completeContext": {
    "principalId": "user_1",
    "canWriteNow": false
  }
}
```
- Expected output:
```json
{
  "error": {
    "code": "FILEFN_FORBIDDEN"
  }
}
```
- Negative variant(s):
  - If completion succeeds after write access was revoked, the implementation fails this vector.

## TV-UPLOAD-001
- Description: Upload resume, completion replay, and GC behave deterministically.
- Input:
```json
{
  "uploadSessionId": "up_001",
  "recordedParts": [1, 2],
  "completeTwice": true,
  "gcExpiredAborted": true
}
```
- Expected output:
```json
{
  "status": {
    "recordedParts": [1, 2]
  },
  "completeReplay": {
    "sameFileId": true,
    "sameVersionId": true
  },
  "gc": {
    "temporaryStateRemoved": true
  }
}
```
- Negative variant(s):
  - Incomplete completion returns `FILEFN_UPLOAD_INCOMPLETE`.
  - GC MUST NOT remove completed sessions prematurely.

## TV-UPLOAD-002
- Description: Unsupported upload mode combinations fail cleanly and proxy remains valid.
- Input:
```json
{
  "storageCapabilities": {
    "multipart": false,
    "signedUploadUrls": false,
    "proxyStreamingUpload": false
  }
}
```
- Expected output:
```json
{
  "error": {
    "code": "FILEFN_NO_SUPPORTED_UPLOAD_MODE"
  }
}
```
- Negative variant(s):
  - Returning bare `signed-url` fails this vector.

## TV-FILE-001
- Description: Deterministic list and version-aware get/download parity.
- Input:
```json
{
  "files": [
    { "fileId": "file_b", "updatedAt": "2026-03-22T00:00:00Z" },
    { "fileId": "file_a", "updatedAt": "2026-03-22T00:00:00Z" }
  ],
  "getFile": {
    "fileId": "file_a",
    "versionId": "ver_old"
  }
}
```
- Expected output:
```json
{
  "listOrder": ["file_a", "file_b"],
  "getFileVersionId": "ver_old"
}
```
- Negative variant(s):
  - Returning current-version metadata for `versionId=ver_old` fails.
  - Returning non-readable files fails.

## TV-FILE-002
- Description: Downloads and render descriptors return usable HTTP descriptors.
- Input:
```json
{
  "request": [
    "GET /file_123/download",
    "GET /file_123/artifacts/art_123/download",
    "GET /file_123/render?intent=preview"
  ]
}
```
- Expected output:
```json
{
  "allUrlsAreHttpOrRelativeHttp": true,
  "noProxyScheme": true
}
```
- Negative variant(s):
  - Any `proxy://...` response fails.

## TV-FILE-003
- Description: Delete cascades metadata and preserves shared physical storage until last reference removal.
- Input:
```json
{
  "fileIds": ["file_1", "file_2"],
  "sharedStorageKey": "durable/shared/key"
}
```
- Expected output:
```json
{
  "deleteFile1": {
    "file1RowsRemoved": true,
    "sharedStorageStillExists": true
  },
  "deleteFile2": {
    "sharedStorageDeleted": true
  }
}
```
- Negative variant(s):
  - Deleting the shared storage object after deleting only `file_1` fails.

## TV-META-001
- Description: Upload/import metadata persists.
- Input:
```json
{
  "uploadMetadata": {
    "source": "nucleus",
    "isMeta": true
  }
}
```
- Expected output:
```json
{
  "fileRecord": {
    "metadata": {
      "source": "nucleus",
      "isMeta": true
    }
  }
}
```
- Negative variant(s):
  - Persisting `{}` instead of the supplied metadata fails.

## TV-STORAGE-001
- Description: Logical storage targets route to different physical adapters/buckets.
- Input:
```json
{
  "policies": [
    { "id": "durable", "storageTarget": "durable" },
    { "id": "temporary", "storageTarget": "temporary" }
  ],
  "targets": ["durable", "temporary"]
}
```
- Expected output:
```json
{
  "durableFile": {
    "resolvedTarget": "durable"
  },
  "temporaryFile": {
    "resolvedTarget": "temporary"
  }
}
```
- Negative variant(s):
  - Unknown logical targets fail with a stable configuration error.
  - FileFn core branching directly on bucket names fails this vector.

## TV-RATE-001
- Description: Route-category rate limits cover render/artifact control-plane routes.
- Input:
```json
{
  "category": "render",
  "maxRequests": 1,
  "requests": 2
}
```
- Expected output:
```json
{
  "secondResponse": {
    "error": {
      "code": "FILEFN_RATE_LIMITED"
    },
    "details": {
      "resetAt": "2026-03-22T11:41:39Z"
    }
  }
}
```
- Negative variant(s):
  - Missing ISO8601 `resetAt` fails.

## TV-PROCESS-001
- Description: Upload completion triggers processing on both TS and Python.
- Input:
```json
{
  "fileId": "file_proc_1",
  "versionId": "ver_proc_1",
  "processors": ["thumbnail"]
}
```
- Expected output:
```json
{
  "processingTriggered": true,
  "artifactsCreated": 1
}
```
- Negative variant(s):
  - TypeScript path that completes upload without triggering processing fails.

## TV-PROCESS-002
- Description: PDF preview artifacts and image thumbnail artifacts use canonical kinds.
- Input:
```json
{
  "files": [
    { "mimeType": "image/jpeg" },
    { "mimeType": "application/pdf" }
  ]
}
```
- Expected output:
```json
{
  "imageArtifactsContain": ["thumbnail-small", "thumbnail-medium", "thumbnail-large"],
  "pdfArtifactsContain": ["pdf-preview-page-1-small", "pdf-preview-page-1-medium", "pdf-preview-page-1-large"]
}
```
- Negative variant(s):
  - Emitting non-canonical artifact names for these reserved representations fails.

## TV-OBS-001
- Description: Secret redaction preserves safe identifiers and removes secret-bearing values.
- Input:
```json
{
  "logContext": {
    "fileId": "file_123",
    "requestId": "req_123",
    "uploadSessionToken": "secret_token",
    "signedUrl": "https://example.com/file?sig=secret"
  }
}
```
- Expected output:
```json
{
  "fileId": "file_123",
  "requestId": "req_123",
  "uploadSessionToken": "[REDACTED]",
  "signedUrl": "[REDACTED]"
}
```
- Negative variant(s):
  - Redacting `fileId` or `requestId` fails.

## TV-CLIENT-001
- Description: Client-generated file IDs survive offline sync and final remote completion.
- Input:
```json
{
  "generatedFileId": "file_local_001",
  "offline": true,
  "syncLater": true
}
```
- Expected output:
```json
{
  "pendingFileId": "file_local_001",
  "completedFileId": "file_local_001"
}
```
- Negative variant(s):
  - Completing the upload with a different remote `fileId` fails.

## TV-CLIENT-002
- Description: OPFS pending uploads support immediate local preview.
- Input:
```json
{
  "fileId": "file_local_img",
  "mimeType": "image/jpeg",
  "offline": true,
  "intent": "thumbnail"
}
```
- Expected output:
```json
{
  "descriptor": {
    "state": "pending-local",
    "source": {
      "mode": "local-object-url"
    }
  }
}
```
- Negative variant(s):
  - Returning no usable preview for an unsynced local image fails.

## TV-CLIENT-003
- Description: HEIC preprocessor converts browser uploads deterministically.
- Input:
```json
{
  "fileName": "photo.heic",
  "mimeType": "image/heic",
  "preprocessor": "heic"
}
```
- Expected output:
```json
{
  "fileName": "photo.jpg",
  "mimeType": "image/jpeg"
}
```
- Negative variant(s):
  - Failed conversion returns a stable FileFn error code and does not silently upload the raw HEIC when policy forbids it.

## TV-VIEW-001
- Description: Render descriptor API and viewer resolver return a ready remote source.
- Input:
```json
{
  "fileId": "file_pdf_1",
  "intent": "preview"
}
```
- Expected output:
```json
{
  "descriptor": {
    "intent": "preview",
    "state": "ready",
    "source": {
      "mode": "artifact",
      "artifactKind": "pdf-preview-page-1-large"
    }
  }
}
```
- Negative variant(s):
  - If preview intent returns no primary source and no deterministic placeholder, the vector fails.

## TV-VIEW-002
- Description: Viewer prefers local pending source when requested and available.
- Input:
```json
{
  "fileId": "file_local_pdf_1",
  "intent": "preview",
  "preferLocal": true,
  "pendingLocalExists": true
}
```
- Expected output:
```json
{
  "viewerSource": {
    "state": "pending-local"
  }
}
```
- Negative variant(s):
  - Ignoring an available local pending source when `preferLocal=true` fails.

## TV-PY-001
- Description: Python exports/config include the new routed storage and processing surfaces.
- Input:
```json
{
  "imports": [
    "create_file_fn",
    "FileFnConfig",
    "create_routed_storage_adapter"
  ]
}
```
- Expected output:
```json
{
  "importsSuccessful": true
}
```
- Negative variant(s):
  - Missing documented exports fail.

## TV-PY-002
- Description: Python server/storage semantics match TS for new and carried-forward behaviors.
- Input:
```json
{
  "cases": [
    "version-aware-get",
    "delete-cascade",
    "render-descriptor-binding",
    "storage-target-routing"
  ]
}
```
- Expected output:
```json
{
  "allCasesMatchTsSemantics": true
}
```
- Negative variant(s):
  - Returning current-file metadata when a historical `versionId` is requested fails.

## TV-PY-003
- Description: Python test suite executes the new parity scenarios.
- Input:
```json
{
  "command": "python3 -m pytest filefn/python/tests"
}
```
- Expected output:
```json
{
  "result": "exit_0",
  "containsNewParityTests": true
}
```
- Negative variant(s):
  - Import-collection failure or zero new parity coverage fails.

## TV-POLICY-001
- Description: Nucleus-aligned policy set enforces MIME types, size cap, storage target, and render profile.
- Input:
```json
{
  "policy": "nucleus-durable-default",
  "file": {
    "mimeType": "application/pdf",
    "size": 104857600
  }
}
```
- Expected output:
```json
{
  "allowed": true,
  "storageTarget": "durable",
  "renderProfile": "nucleus"
}
```
- Negative variant(s):
  - `size=104857601` returns a policy max-size error.
  - Unsupported MIME type returns a policy content-type error.

## TV-MIG-001
- Description: Dry-run migration manifests are deterministic and support in-place adoption.
- Input:
```json
{
  "legacyManifestRow": {
    "legacyFileResourceId": "file:image_legacy_1",
    "bucket": "tidyfiles.us-east-1",
    "key": "user_1/image/file.png"
  },
  "mode": "dry-run"
}
```
- Expected output:
```json
{
  "targetFileId": "deterministic",
  "requiresByteCopy": false
}
```
- Negative variant(s):
  - Ambiguous ownership or cross-tenant conflict returns `FILEFN_MIGRATION_CONFLICT`.

## TV-MIG-002
- Description: Rewrite manifest supports temporary dual-read and deterministic rollback metadata.
- Input:
```json
{
  "rewrite": {
    "legacyFileResourceId": "file:image_legacy_1",
    "targetFileId": "file_legacy_7w9m2p"
  }
}
```
- Expected output:
```json
{
  "dualReadResolvesLegacyAndNative": true,
  "rollbackManifestGenerated": true
}
```
- Negative variant(s):
  - Missing rollback manifest or non-deterministic rewrite mapping fails.

## TV-NUCLEUS-001
- Description: Nucleus write/read paths use FileFn-native IDs and viewer resolution.
- Input:
```json
{
  "flows": [
    "avatar-upload",
    "cover-upload",
    "memotron-capture",
    "markdown-temp-upload",
    "embed-download",
    "file-view"
  ]
}
```
- Expected output:
```json
{
  "allFlowsPersistFileFnIds": true,
  "viewerResolvesSources": true
}
```
- Negative variant(s):
  - Any flow that still requires a legacy Nucleus `file:` resource on new writes fails.

## TV-NUCLEUS-002
- Description: Final-state Nucleus no longer depends on legacy file upload/render code.
- Input:
```json
{
  "steadyState": true
}
```
- Expected output:
```json
{
  "legacyUploadFileV2FlowRemoved": true,
  "legacySignedUrlRefreshRemoved": true
}
```
- Negative variant(s):
  - Keeping the old code as a permanent fallback fails.

## TV-DEMO-001
- Description: Example/demo smoke covers upload, render resolution, download, delete, and migration dry-run.
- Input:
```json
{
  "smoke": [
    "upload-image",
    "resolve-thumbnail",
    "upload-pdf",
    "resolve-preview",
    "download-original",
    "delete-file",
    "migration-dry-run"
  ]
}
```
- Expected output:
```json
{
  "allSmokeStepsPass": true
}
```
- Negative variant(s):
  - Passing upload/list/download but failing render/migration smoke fails this vector.

# Phase goal

Implement low-level upload-session APIs and the high-level foreground uploader with proxy and signed upload support so later native-backed WebView mode can reuse the same engine.

# In scope / Out of scope

- **In scope**: upload-session models/methods, idempotency-header handling, anonymous-session-token propagation, chunking/materialization helpers, foreground event streaming, and upload tests.
- **Out of scope**: background recovery/persistence, WebView bridge dispatch, SwiftUI helpers, and the contract artifact/docs.

# Deliverables

- `filefn/swift/Sources/FileFnClient/Models/FileFnUploadModels.swift`
- `filefn/swift/Sources/FileFnClient/Upload/FileFnUploadSource.swift`
- `filefn/swift/Sources/FileFnClient/Upload/FileFnUploadTask.swift`
- `filefn/swift/Sources/FileFnClient/Upload/FileFnForegroundUploader.swift`
- `filefn/swift/Sources/FileFnClient/Upload/FileFnChunker.swift`
- `filefn/swift/Sources/FileFnClient/Upload/FileFnTemporaryFileMaterializer.swift`
- `filefn/swift/Sources/FileFnClient/FileFnClient+Uploads.swift`
- `filefn/swift/Tests/FileFnClientTests/FileFnUploadSessionTests.swift`
- `filefn/swift/Tests/FileFnClientTests/FileFnForegroundUploaderTests.swift`

# Requirements covered

- UP-001
- UP-002
- CFG-001
- ENV-001
- ERR-001

# Implementation tasks

1. Implement upload-session request/response models and endpoint methods.
2. Ensure `createUploadSession` sends `x-idempotency-key` when supplied.
3. Implement local `fileId` and idempotency-key generation for foreground uploads when omitted.
4. Implement upload chunking based on server-provided `chunkSizeBytes`.
5. Implement both signed and proxy part-upload flows.
6. Implement ordered foreground upload event streaming plus aggregate progress.
7. Persist anonymous upload session tokens in memory for the lifetime of the foreground task.
8. Keep the uploader surface reusable by the future `FileFnWebViewBridgeHost` rather than coupling it to SwiftUI/UI-specific code.
9. Add tests for low-level session/token semantics, multipart signed uploads, proxy uploads, idempotent completion, and monotonic event order.

# Verification steps

- `swift test --package-path filefn/swift --filter FileFnUploadSessionTests`
  - Expected outcome: low-level upload-session semantics and error handling tests pass.
- `swift test --package-path filefn/swift --filter FileFnForegroundUploaderTests`
  - Expected outcome: signed/proxy upload orchestration and event-stream tests pass.

# Stop condition

Report the low-level upload methods, the high-level foreground upload API shape, and the passing upload test commands before starting Phase 04.

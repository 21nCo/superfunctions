# Phase goal

Implement the background uploader with durable state, token persistence, relaunch recovery, and cleanup semantics that native-backed WebView mode can later observe safely.

# In scope / Out of scope

- **In scope**: background upload configuration, persistent snapshot store, secret store abstraction/default, chunk-file lifecycle, recovery, reconciliation, and cancellation cleanup.
- **Out of scope**: WebView bridge dispatch, SwiftUI helper wrappers, contract artifact/docs finalization, and HEIC-specific preprocessing.

# Deliverables

- `filefn/swift/Sources/FileFnClient/Upload/FileFnBackgroundUploadConfiguration.swift`
- `filefn/swift/Sources/FileFnClient/Upload/FileFnBackgroundUploadSnapshot.swift`
- `filefn/swift/Sources/FileFnClient/Upload/FileFnUploadStateStore.swift`
- `filefn/swift/Sources/FileFnClient/Upload/FileFnFileSystemUploadStateStore.swift`
- `filefn/swift/Sources/FileFnClient/Upload/FileFnSecretStore.swift`
- `filefn/swift/Sources/FileFnClient/Upload/FileFnKeychainSecretStore.swift`
- `filefn/swift/Sources/FileFnClient/Upload/FileFnBackgroundUploader.swift`
- `filefn/swift/Tests/FileFnClientTests/FileFnBackgroundUploaderTests.swift`
- `filefn/swift/Tests/FileFnClientTests/FileFnSecretRedactionTests.swift`

# Requirements covered

- BG-001
- SEC-001
- UP-001
- UP-002

# Implementation tasks

1. Define persisted snapshot and secret-store abstractions with Apple-platform defaults.
2. Implement background-uploader enqueue flow for disk-backed file URLs only.
3. Implement chunk-file creation and cleanup rules.
4. Persist anonymous upload session tokens outside snapshot payloads.
5. Implement relaunch recovery that reattaches, reloads state, calls `getUploadStatus`, and resumes only missing parts.
6. Ensure recovered uploads remain authoritative even if no WebView has reconnected yet.
7. Implement cancellation and terminal cleanup.
8. Add tests for relaunch recovery, missing-chunk corruption, token removal, and log redaction.

# Verification steps

- `swift test --package-path filefn/swift --filter FileFnBackgroundUploaderTests`
  - Expected outcome: recovery, reconciliation, and cleanup tests pass.
- `swift test --package-path filefn/swift --filter FileFnSecretRedactionTests`
  - Expected outcome: secret-store and redaction tests pass.

# Stop condition

Report the recovery model, persisted-state boundaries, and the exact cleanup guarantees before starting Phase 05.

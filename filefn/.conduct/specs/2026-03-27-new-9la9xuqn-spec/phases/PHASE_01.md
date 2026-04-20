# Phase goal

Implement the read/query surface for files, versions, downloads, artifacts, and render descriptors with precise envelope/error handling.

# In scope / Out of scope

- **In scope**: file list/detail/delete, versions, artifact listing/download, direct download descriptors, render resolution, relative URL handling, and associated models/tests.
- **Out of scope**: grant/share/policy/quota/processing routes, uploads, background recovery, and SwiftUI helper code.

# Deliverables

- `filefn/swift/Sources/FileFnClient/Models/FileFnFileSummary.swift`
- `filefn/swift/Sources/FileFnClient/Models/FileFnFileDetail.swift`
- `filefn/swift/Sources/FileFnClient/Models/FileFnVersion.swift`
- `filefn/swift/Sources/FileFnClient/Models/FileFnDownloadDescriptor.swift`
- `filefn/swift/Sources/FileFnClient/Models/FileFnArtifactDescriptor.swift`
- `filefn/swift/Sources/FileFnClient/Models/FileFnRenderDescriptor.swift`
- `filefn/swift/Sources/FileFnClient/Internal/FileFnRequestExecutor.swift`
- `filefn/swift/Sources/FileFnClient/FileFnClient+Files.swift`
- `filefn/swift/Tests/FileFnClientTests/FileFnFileRouteTests.swift`
- `filefn/swift/Tests/FileFnClientTests/FileFnRenderRouteTests.swift`

# Requirements covered

- FILE-001
- RENDER-001
- CFG-001
- ENV-001
- ERR-001

# Implementation tasks

1. Implement a reusable request executor that combines base URL, query items, headers, auth injection, request IDs, and envelope decoding.
2. Implement file summary/detail/version/artifact/render/download models exactly matching the current server payloads.
3. Add `listFiles`, `getFile`, `deleteFile`, `listVersions`, `getVersion`, `downloadURL`, `listArtifacts`, `downloadArtifact`, and `resolveRenderable`.
4. Resolve relative proxy URLs against `baseURL` without mutating signed URL query strings.
5. Ensure opaque cursors are treated as pass-through strings only.
6. Add tests for file list/detail success, delete success, missing file errors, render placeholder handling, and relative download/artifact URL resolution.

# Verification steps

- `swift test --package-path filefn/swift --filter FileFnFileRouteTests`
  - Expected outcome: file list/detail/delete/version tests pass.
- `swift test --package-path filefn/swift --filter FileFnRenderRouteTests`
  - Expected outcome: render/artifact/download descriptor tests pass.

# Stop condition

Report the implemented read/query methods, the model asymmetries preserved from the server contract, and the passing test commands before starting Phase 02.

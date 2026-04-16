# Phase goal

Implement preprocessors, built-in HEIC conversion, and the thin SwiftUI helper target.

# In scope / Out of scope

- **In scope**: upload preprocessor protocol, built-in HEIC converter, SwiftUI observable upload wrapper, PhotosPicker loader, file-import loader, and helper semantics that feed direct uploads or native asset registration.
- **Out of scope**: OpenAPI contract publication and final README/integration docs polish.

# Deliverables

- `filefn/swift/Sources/FileFnClient/Upload/FileFnUploadPreprocessor.swift`
- `filefn/swift/Sources/FileFnClient/Upload/FileFnHEICPreprocessor.swift`
- `filefn/swift/Sources/FileFnSwiftUI/FileFnUploadObservable.swift`
- `filefn/swift/Sources/FileFnSwiftUI/FileFnPhotosPickerLoader.swift`
- `filefn/swift/Sources/FileFnSwiftUI/FileFnFileImporterLoader.swift`
- `filefn/swift/Tests/FileFnClientTests/FileFnHEICPreprocessorTests.swift`
- `filefn/swift/Tests/FileFnSwiftUITests/FileFnUploadObservableTests.swift`
- `filefn/swift/Tests/FileFnSwiftUITests/FileFnAssetLoaderTests.swift`

# Requirements covered

- HEIC-001
- UI-001
- UP-002
- BRIDGE-002

# Implementation tasks

1. Define the preprocessor protocol and prepared-upload model shared by foreground/background uploaders.
2. Implement the built-in HEIC preprocessor with configurable enable/disable and quality settings.
3. Integrate preprocessor execution into foreground, background, and native-backed bridge upload code paths.
4. Implement the SwiftUI observable wrapper over `FileFnUploadTask`.
5. Implement asset loaders for `PhotosPickerItem` and imported file URLs.
6. Ensure loaded assets can be passed directly to uploads or registered in `FileFnNativeAssetRegistry`.
7. Add tests for HEIC success, HEIC conversion failure, upload observable state updates, and asset-import failure cases.

# Verification steps

- `swift test --package-path filefn/swift --filter FileFnHEICPreprocessorTests`
  - Expected outcome: HEIC conversion tests pass.
- `swift test --package-path filefn/swift --filter FileFnUploadObservableTests`
  - Expected outcome: observable state-bridging tests pass.
- `swift test --package-path filefn/swift --filter FileFnAssetLoaderTests`
  - Expected outcome: PhotosPicker/file-import loader tests pass.

# Stop condition

Report the default HEIC behavior, how SwiftUI apps observe progress, how imported assets feed direct uploads or native asset registration, and the passing helper/preprocessor tests before starting Phase 07.

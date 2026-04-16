# Phase goal

Implement optional capability-route families for policies, quota, grants, shares, and processing with correct capability-unavailable semantics.

# In scope / Out of scope

- **In scope**: policy list, quota usage, create/list/revoke grants, create/list/revoke shares, share-download resolution, processing trigger, and capability-unavailable classification.
- **Out of scope**: uploads, background recovery, HEIC preprocessing, SwiftUI helpers, and the contract artifact itself.

# Deliverables

- `filefn/swift/Sources/FileFnClient/Models/FileFnPolicySummary.swift`
- `filefn/swift/Sources/FileFnClient/Models/FileFnStorageQuota.swift`
- `filefn/swift/Sources/FileFnClient/Models/FileFnPermissionGrant.swift`
- `filefn/swift/Sources/FileFnClient/Models/FileFnShareLink.swift`
- `filefn/swift/Sources/FileFnClient/Models/FileFnProcessingStatus.swift`
- `filefn/swift/Sources/FileFnClient/FileFnClient+Capabilities.swift`
- `filefn/swift/Tests/FileFnClientTests/FileFnCapabilityRouteTests.swift`

# Requirements covered

- POL-001
- GRANT-001
- SHARE-001
- PROC-001
- ERR-001

# Implementation tasks

1. Implement models and request bodies for policies, quota, grants, shares, and processing.
2. Add endpoint methods for every optional route family listed in the spec.
3. Implement route-family classification so generic non-canonical 404/405 responses become `capabilityUnavailable`.
4. Preserve canonical FileFn errors from mounted routes without reclassification.
5. Add tests for mounted success responses, mounted canonical failures, and non-canonical missing-route failures.

# Verification steps

- `swift test --package-path filefn/swift --filter FileFnCapabilityRouteTests`
  - Expected outcome: policy/quota/grant/share/processing and capability-unavailable tests pass.

# Stop condition

Report the optional route methods now supported and the exact distinction between mounted-route server errors and route-family absence before starting Phase 03.

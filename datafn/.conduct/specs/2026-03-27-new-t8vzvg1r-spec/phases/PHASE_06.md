# Phase Goal
Implement native-backed CloudKit mode for personal multi-device sync and enforce same-store backend exclusivity.

# In Scope / Out Of Scope
- In scope:
  - `NSPersistentCloudKitContainer` private-database backend.
  - Same-store exclusivity checks.
  - Health/status reporting for CloudKit availability.
  - Remote-only resource rejection in CloudKit mode.
- Out of scope:
  - CloudKit shared/public database support.
  - Cross-user collaboration semantics.

# Deliverables
- `datafn/swift/Sources/DatafnCloudKitSync/DatafnCloudKitSyncEngine.swift`
- `datafn/swift/Sources/DatafnCloudKitSync/DatafnCloudKitHealth.swift`
- `datafn/swift/Sources/DatafnAppleRuntime/BackendExclusivityGuard.swift`
- `datafn/swift/Tests/DatafnCloudKitSyncTests/CloudKitModeTests.swift`
- `datafn/swift/Tests/DatafnCloudKitSyncTests/BackendExclusivityTests.swift`
- `datafn/client/__tests__/native-backed-icloud-mode.test.ts`

# Requirements Covered
- API-001
- REM-001
- CLD-001
- CLD-002
- OBS-001

# Implementation Tasks
- [ ] Implement `NSPersistentCloudKitContainer` private-database initialization.
- [ ] Surface CloudKit account and backend availability through health reporting.
- [ ] Enforce one backend per namespace store.
- [ ] Reject remote-only resources explicitly in CloudKit mode.
- [ ] Add TS integration tests for native-backed iCloud configuration and rejection cases.

# Verification Steps
- `swift test --package-path datafn/swift`
  - Expected: CloudKit-mode and backend-exclusivity tests pass.
- `npm --prefix datafn/client test`
  - Expected: native-backed iCloud-mode tests pass.

# Stop Condition
Report the exact exclusivity guard, CloudKit health states, and passing iCloud-mode tests before starting Phase 07.

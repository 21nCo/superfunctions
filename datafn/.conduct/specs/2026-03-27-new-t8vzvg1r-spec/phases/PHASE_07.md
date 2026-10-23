# Phase Goal
Add SwiftUI Observation bindings that stay synchronized with the shared native store used by embedded WebView clients.

# In Scope / Out Of Scope
- In scope:
  - Observation-based query state objects.
  - Shared-store invalidation handling.
  - SwiftUI-side tests proving WebView-originated changes propagate.
- Out of scope:
  - New persistence or sync behavior.

# Deliverables
- `datafn/swift/Sources/DatafnSwiftUI/DatafnObservedQuery.swift`
- `datafn/swift/Sources/DatafnSwiftUI/DatafnObservedMutationState.swift`
- `datafn/swift/Tests/DatafnSwiftUITests/ObservedQueryTests.swift`
- `datafn/swift/Tests/DatafnSwiftUITests/SharedStorePropagationTests.swift`

# Requirements Covered
- SWUI-001
- EVT-001

# Implementation Tasks
- [ ] Implement Observation wrappers over the native runtime/query subscriptions.
- [ ] Ensure updates are driven by the same store and event stream used by the bridge host.
- [ ] Add tests proving WebView-side writes become visible to SwiftUI observers.
- [ ] Add tests proving CloudKit/server-sync changes also refresh SwiftUI state.

# Verification Steps
- `swift test --package-path datafn/swift`
  - Expected: SwiftUI observation tests pass.

# Stop Condition
Report the SwiftUI observable types, their update triggers, and passing shared-store observer tests before starting Phase 08.

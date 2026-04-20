# Phase Goal
Ship example hosts, docs, and end-to-end verification proving the same app works in browser-owned mode, embedded native-backed DataFn-server mode, and embedded native-backed CloudKit mode.

# In Scope / Out Of Scope
- In scope:
  - Apple reference host app.
  - Example web app configuration matrix.
  - README and docs updates.
  - End-to-end verification commands.
- Out of scope:
  - Additional platforms beyond this spec baseline.

# Deliverables
- `datafn/examples/apple-webview-host/*`
- `datafn/examples/todo-app/*` updates or a new dual-mode example app
- `datafn/client/README.md`
- `datafn/docs/content/docs/documentation/client/setup.mdx`
- `datafn/docs/content/docs/documentation/sync/overview.mdx`
- `datafn/docs/content/docs/reference/client/config.mdx`
- `datafn/docs/content/docs/reference/client/storage.mdx`
- `datafn/docs/content/docs/reference/client/transport.mdx`
- `datafn/swift-bridge/README.md`
- `datafn/swift/README.md`

# Requirements Covered
- API-001
- API-002
- API-003
- CLD-001
- COMP-001

# Implementation Tasks
- [ ] Add an Apple host example showing the same web app in native-backed DataFn-server mode.
- [ ] Add an Apple host example or configuration path showing CloudKit mode.
- [ ] Update client and bridge documentation with browser-owned vs native-backed configuration examples.
- [ ] Document that native-backed mode forbids IndexedDB fallback.
- [ ] Add end-to-end verification scripts or test instructions for all three supported topologies.

# Verification Steps
- `npm --prefix datafn/swift-bridge test`
  - Expected: bridge package tests still pass.
- `npm --prefix datafn/client test`
  - Expected: browser-owned and native-backed tests pass.
- `swift test --package-path datafn/swift`
  - Expected: Swift runtime, sync, CloudKit, and SwiftUI tests pass.
- `xcodebuild -project datafn/examples/apple-webview-host/DatafnAppleHost.xcodeproj -scheme DatafnAppleHost -destination 'platform=iOS Simulator,name=iPhone 16' test`
  - Expected: example host integration tests pass.

# Stop Condition
Report the example app topology matrix, the final verification command set, and any documented operational caveats before declaring the spec fully executable.

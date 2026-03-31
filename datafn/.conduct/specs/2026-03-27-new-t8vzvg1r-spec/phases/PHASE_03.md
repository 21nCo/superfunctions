# Phase Goal
Scaffold the Swift package and implement runtime schema loading plus namespace-aware Core Data model generation.

# In Scope / Out Of Scope
- In scope:
  - Swift package structure.
  - Runtime configuration types.
  - Runtime schema parsing and model generation.
  - Namespace-aware store-location strategy.
- Out of scope:
  - Concrete bridge request handling.
  - Sync backends.

# Deliverables
- `datafn/swift/Package.swift`
- `datafn/swift/Sources/DatafnAppleRuntime/DatafnAppleRuntime.swift`
- `datafn/swift/Sources/DatafnAppleRuntime/DatafnAppleRuntimeConfiguration.swift`
- `datafn/swift/Sources/DatafnCoreDataStore/CoreDataModelBuilder.swift`
- `datafn/swift/Sources/DatafnCoreDataStore/NamespaceStoreLocator.swift`
- `datafn/swift/Tests/DatafnAppleRuntimeTests/RuntimeConfigurationTests.swift`
- `datafn/swift/Tests/DatafnCoreDataStoreTests/CoreDataModelBuilderTests.swift`

# Requirements Covered
- PKG-001
- API-003
- STO-001
- STO-002

# Implementation Tasks
- [ ] Create the Swift package with the required targets and test targets.
- [ ] Define the runtime configuration and backend selection enums.
- [ ] Implement schema parsing from runtime JSON.
- [ ] Build the Core Data model generator for resources, joins, kv, meta, and changelog entities.
- [ ] Implement deterministic namespace-to-store path mapping.
- [ ] Add tests for schema loading, namespace isolation, and generated entity shape.

# Verification Steps
- `swift test --package-path datafn/swift`
  - Expected: runtime configuration and model-builder tests pass.

# Stop Condition
Report the generated entity families, the namespace-to-store mapping rule, and passing Swift model-builder tests before starting Phase 04.

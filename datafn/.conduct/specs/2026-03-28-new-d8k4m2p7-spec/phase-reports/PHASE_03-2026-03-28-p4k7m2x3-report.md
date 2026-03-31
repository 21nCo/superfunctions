# Metadata
- Timestamp: 2026-03-28T08:33:23Z
- agent_name: unknown-agent
- model: GPT-5 Codex
- launcher: Codex Desktop
- workspace: repo root
- OS: Darwin arm64
- shell: zsh
- git: detached HEAD at `50929162a8547f6f55db27bdc51c47289c0bc2af`, dirty `dirty`

# Phase
- PHASE_03

# Status
- PASS

# Requirements Summary
- Requirements delivered:
  - `DREB-001`
  - `DPST-001`
  - `DERR-001`

## DREB-001
- Status: PASS
- Acceptance criteria evidence:
  - `datafn/swift/Sources/DatafnAppleRuntime/DatafnAppleRuntime.swift` now computes a deterministic SHA-256 digest from backend kind, schema hash, and normalized `indices.search` resource/field definitions.
  - Startup compares persisted metadata from Core Data against the current digest and schema hash before accepting the existing SearchFn state.
  - Mismatches set persisted `searchStatus` to `rebuilding`, delete the existing SearchFn root, rebuild the index from Core Data records, and only then persist `ready`.
  - Rebuild failures are wrapped as `SEARCH_INDEX_REBUILD_FAILED` and respect `failIfUnavailable`.
- Test status:
  - `datafn/swift/Tests/DatafnSearchRebuildTests/DatafnSearchRebuildTests.swift` verifies digest mismatch rebuilds stale search state from Core Data and records `["rebuilding", "ready"]` transitions.
  - The same suite verifies rebuild failure throws when `failIfUnavailable = true` and is suppressed when `false`.
  - Verified by `swift test --package-path datafn/swift --filter DatafnSearchRebuildTests` passing.

## DPST-001
- Status: PASS
- Acceptance criteria evidence:
  - Default native search root remains `<namespace support directory>/SearchFn`, resolved through `DatafnSearchFnBackendFactory` and now persisted through runtime metadata/snapshots.
  - Search metadata is stored in `df_namespace_metadata` as derived local state separate from `datafn.sqlite` record storage semantics.
  - CloudKit mode uses the same support-directory SearchFn root, keeping the index separate from the CloudKit-backed Core Data store file.
- Test status:
  - `datafn/swift/Tests/DatafnSearchRebuildTests/DatafnSearchRebuildTests.swift` verifies the resolved root ends at `Support/SearchFn`, differs from `datafn.sqlite`, and remains separate in CloudKit mode.
  - Verified by `swift test --package-path datafn/swift --filter DatafnSearchRebuildTests` passing.

## DERR-001
- Status: PASS
- Acceptance criteria evidence:
  - Rebuild failures now surface `SEARCH_INDEX_REBUILD_FAILED` with `details.path = "search.rebuild"`.
  - Suppressed rebuild failures leave runtime search unavailable, and later runtime search calls deterministically surface `NATIVE_SEARCH_UNAVAILABLE`.
  - Existing invalid/native-unavailable error surfaces from earlier phases remain unchanged.
- Test status:
  - `datafn/swift/Tests/DatafnSearchRebuildTests/DatafnSearchRebuildTests.swift` covers both the hard-fail and soft-fail rebuild paths.
  - Verified by `swift test --package-path datafn/swift --filter DatafnSearchRebuildTests` passing.

# Deliverables Summary
- Files changed/added:
  - `datafn/swift/Package.swift`
  - `datafn/swift/Sources/DatafnAppleRuntime/DatafnAppleRuntime.swift`
  - `datafn/swift/Sources/DatafnAppleRuntime/DatafnTestingFixtures.swift`
  - `datafn/swift/Sources/DatafnCoreDataStore/CoreDataModelBuilder.swift`
  - `datafn/swift/Sources/DatafnCoreDataStore/DatafnCoreDataStore.swift`
  - `datafn/swift/Tests/DatafnSearchRebuildTests/DatafnSearchRebuildTests.swift`
  - `datafn/.conduct/specs/2026-03-28-new-d8k4m2p7-spec/phase-reports/PHASE_03-2026-03-28-p4k7m2x3-report.md`
- Files deleted/modified:
  - `datafn/.conduct/specs/2026-03-28-new-d8k4m2p7-spec/logs.csv`

# Verification Summary
- Phase verification steps executed:
  - `swift test --package-path datafn/swift --filter DatafnSearchRebuildTests` -> PASS
- Test execution results:
  - The rebuild-specific target built and passed after adding the new metadata/rebuild flow.
  - Covered behaviors:
    - digest mismatch detection
    - persisted search metadata updates
    - clear-and-rebuild from Core Data
    - `failIfUnavailable = true` hard failure
    - `failIfUnavailable = false` soft failure with runtime search unavailable
    - CloudKit-local search root separation
  - Existing linker warnings about duplicate Command Line Tools `-rpath` entries were present but non-failing.

# Notes
- Search metadata now lives in `df_namespace_metadata` as `searchBackendKind`, `searchSchemaHash`, `searchConfigDigest`, and `searchStatus`.
- The rebuild path intentionally recreates SearchFn state by deleting the derived search root and reindexing from authoritative Core Data records.
- Rebuild scope is limited to startup/bootstrap; this phase intentionally does not implement mutation/sync/CloudKit event-driven index maintenance.
- Search document extraction mirrors the existing JavaScript semantics by stringifying strings, numbers, booleans, and JSON objects for indexed fields.
- The runtime snapshot now exposes search digest/status/testing transitions so later phases can assert lifecycle behavior without machine-specific paths.
- No new TODOs or deferrals were introduced in the touched files.
- This is not the final phase for the spec, so `datafn/.conduct/tracker.csv` was intentionally left unchanged.

# Ready For Next Phase?
- Yes. Phase 03 landed deterministic placement, persisted metadata, and bootstrap rebuild orchestration, so Phase 04 can focus on live index updates from local writes and sync events.

# Blockers
- None.

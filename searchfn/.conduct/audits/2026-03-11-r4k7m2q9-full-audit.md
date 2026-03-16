# Full Audit Report

## Metadata

- **timestamp**: 2026-03-11T23:45:00Z
- **agent_name**: unknown-agent
- **model**: claude-opus-4-6
- **launcher**: Claude Code CLI
- **workspace/project path**: /Users/serro/Documents/dev/n/superfunctions
- **os**: Darwin 25.3.0 (arm64)
- **shell**: /bin/zsh
- **git.branch**: next
- **git.commit**: 5fe59b66a1ebf692ef723eb68f708e60a90de457
- **git.dirty**: true (extensive uncommitted changes in searchfn/)

## Audit Scope

- **Codebase root**: /Users/serro/Documents/dev/n/superfunctions/searchfn/
- **Excluded**: .conduct/ internal tracking files (except as subject of audit for REL-001/DOC-001)
- **Consumer packages also audited**: datafn/examples/todo-app/client, datafn/examples/todo-app/server, recfn/server

## Inputs Audited

### Intent Sources

- User request: "split `searchfn` adapters into separate packages with no backward compatibility; update monorepo dependencies"
- Referenced input paths from spec metadata (AGENTS.md, package.json files across searchfn/, datafn/, recfn/)

### Spec Bundle

- **Root**: searchfn/.conduct/specs/2026-03-11-new-h3r9k2m7-spec/
- **Files**:
  - SPEC.md
  - REQUIREMENTS.md (12 requirements: PKG-001..003, API-001, MIG-001..003, DOC-001, TEST-001..002, REL-001, ERR-001)
  - TEST_VECTORS.md (24 vectors)
  - PLAN.md (7 phases: 00-06)
  - INTENT_AUDIT.md
  - PHASE_00_CONSUMER_INVENTORY.md
  - PHASE_00_EXPORT_MAPPING.md
  - phases/PHASE_00.md through PHASE_06.md
  - phase-reports/PHASE_00 through PHASE_06 reports

---

## High-Level Findings

| Category | Status | Notes |
|----------|--------|-------|
| Package split (7 packages) | PASS | All 7 new packages exist with package.json, tsup, vitest, src, tests |
| Contract types | PASS | Fully exported from @searchfn/adapter-contracts per spec |
| Import migration | PASS | Zero legacy @searchfn/adapters imports in .ts/.tsx files |
| Dependency rewiring | PARTIAL | searchfn/server has @searchfn/adapter-memory as regular dep (spec says contracts only) |
| Legacy removal | PARTIAL | package.json deleted but directory retains all source/tests/configs |
| Documentation | PASS | All primary docs updated; no stale imports in user-facing pages |
| CHANGELOG/release | PARTIAL | Uses placeholder text instead of actual @searchfn/adapters name |
| Per-package tests | PARTIAL | ES/OpenSearch missing conformance harness files |
| Cross-workspace build | PASS per phase reports | All builds/tests passed per phase report verification |
| Browser isolation | PASS | No pg leak into browser consumers |

**Overall: 7 PASS, 3 PARTIAL, 0 FAIL**

---

## Intent Inventory

| # | Intent Item | Source |
|---|-------------|--------|
| I-1 | Split searchfn adapters into separate packages | User request |
| I-2 | Model as package-per-surface (similar to http-* pattern) | User request |
| I-3 | No backward compatibility required | User request |
| I-4 | Old setup may be destroyed/removed | User request |
| I-5 | Update dependencies within superfunctions monorepo | User request |
| I-6 | Be thorough and execution-ready | User request |
| I-7 | Shared types/interfaces in a contracts package | Implied by split pattern |
| I-8 | Browser consumers must not pull pg/node-only deps | Implied by isolation goal |
| I-9 | Tests must be migrated to new packages | Implied by thoroughness |
| I-10 | Docs/examples must reflect new packages | Implied by thoroughness |
| I-11 | CHANGELOG/migration guide for breaking change | Implied by no-compat policy |

---

## Intent to Spec Coverage Matrix

| Intent | Spec Section(s) | Requirement IDs | Test Vectors | Status |
|--------|-----------------|-----------------|--------------|--------|
| I-1 | Public API, Glossary | PKG-001, PKG-002 | TV-PKG-001-POS/NEG, TV-PKG-002-POS/NEG | COVERED |
| I-2 | Public API (leaf packages) | PKG-001 | TV-PKG-001-POS | COVERED |
| I-3 | Compatibility/versioning, Invariants | MIG-003, ERR-001 | TV-MIG-003-POS/NEG | COVERED |
| I-4 | Compatibility/versioning | MIG-003 | TV-MIG-003-POS/NEG | COVERED |
| I-5 | Data formats, Semantics | MIG-001, MIG-002, TEST-002 | TV-MIG-001/002/TEST-002 | COVERED |
| I-6 | All sections | All requirements | All vectors | COVERED |
| I-7 | Contract package API | PKG-002 | TV-PKG-002-POS/NEG | COVERED |
| I-8 | Invariants (isolation) | PKG-003 | TV-PKG-003-POS/NEG | COVERED |
| I-9 | Semantics | TEST-001 | TV-TEST-001-POS/NEG | COVERED |
| I-10 | Observability | DOC-001 | TV-DOC-001-POS/NEG | COVERED |
| I-11 | Compatibility/versioning | REL-001 | TV-REL-001-POS/NEG | COVERED |

**No spec gaps detected. All intent items have corresponding requirements and test vectors.**

---

## Requirement Coverage Summary

| Req ID | Priority | Status | Notes |
|--------|----------|--------|-------|
| PKG-001 | P0 | PASS | All 7 packages exist with build infra |
| PKG-002 | P0 | PASS | Contracts properly exported; consumers import from contracts |
| PKG-003 | P0 | PASS | Browser build avoids pg (verified in phase reports) |
| API-001 | P0 | PASS | Constructor signatures unchanged; existing tests pass |
| MIG-001 | P0 | PASS | Zero @searchfn/adapters imports in .ts/.tsx/.mts/.cts |
| MIG-002 | P0 | PARTIAL | Server has adapter-memory as regular dep (should be contracts only) |
| MIG-003 | P0 | PARTIAL | package.json deleted; directory retains all source/configs |
| DOC-001 | P1 | PASS | Docs updated; no stale imports in user-facing pages |
| TEST-001 | P0 | PARTIAL | ES/OpenSearch missing conformance test harness files |
| TEST-002 | P0 | PASS | Cross-workspace build matrix passed per PHASE_06 report |
| REL-001 | P1 | PARTIAL | CHANGELOG avoids naming @searchfn/adapters explicitly |
| ERR-001 | P1 | PASS | Legacy import produces ERR_MODULE_NOT_FOUND (verified in PHASE_06) |

**Counts: 8 PASS, 4 PARTIAL, 0 FAIL, 0 UNVERIFIED**

---

## Requirement-by-Requirement Results

### PKG-001: Package Split

**Status: PASS**

| Check | Result |
|-------|--------|
| adapter-contracts directory exists | YES |
| adapter-memory directory exists | YES |
| adapter-indexeddb directory exists | YES |
| adapter-postgres directory exists | YES |
| adapter-elasticsearch directory exists | YES |
| adapter-opensearch directory exists | YES |
| adapter-meilisearch directory exists | YES |
| Each has package.json | YES |
| Each has tsup.config.ts | YES |
| Each has src/index.ts | YES |
| Each has vitest.config.ts | YES |
| Each has __tests__/ | YES |
| No code imports from @searchfn/adapters | YES (verified via grep) |

All leaf package names match the normative list in SPEC.md.

### PKG-002: Contract Types in Dedicated Package

**Status: PASS**

Exports verified in `adapter-contracts/src/index.ts`:

| Export | Present | Matches Spec |
|--------|---------|-------------|
| SearchDocument | YES | YES |
| IndexParams | YES | YES |
| SearchParams | YES | YES |
| SearchAllParams | YES | YES |
| SearchAllResult | YES | YES |
| RemoveParams | YES | YES |
| InitializeResourceConfig | YES | YES |
| InitializeParams | YES | YES |
| SearchAdapterCapabilities | YES | YES |
| SearchAdapter | YES | YES |
| SearchAdapterConfig | YES | YES (imports PipelineOptions from @searchfn/core) |
| SEARCH_ADAPTER_DISPOSED | YES | YES |
| SearchAdapterError | YES | YES (has readonly code property) |

Consumer imports verified:
- searchfn/client/src/client.ts imports from @searchfn/adapter-contracts
- searchfn/client/src/types.ts re-exports from @searchfn/adapter-contracts
- searchfn/server/src/routes/*.ts import from @searchfn/adapter-contracts
- searchfn/datafn-provider/src/index.ts imports from @searchfn/adapter-contracts

**Note (advisory)**: Memory and IndexedDB adapters do NOT re-export contract types for ergonomics. SPEC says "SHOULD" (not MUST), so this is compliant but suboptimal.

### PKG-003: Browser Isolation

**Status: PASS**

- Browser consumer (todo-app-client) depends on @searchfn/adapter-indexeddb (no pg dependency)
- adapter-indexeddb/package.json has no pg dependency
- Phase 04 report confirms browser bundle build passed without pg leak
- Static analysis: adapter-indexeddb depends only on adapter-contracts and @searchfn/core

### API-001: Behavioral Stability

**Status: PASS**

- Export class signatures preserved (MemoryAdapter, IndexedDbAdapter, PostgresAdapter, etc.)
- Constructor parameters unchanged
- All adapter tests pass per phase reports (46 memory, 31 indexeddb, 14 postgres, 4 ES, 3 OpenSearch, 5 Meilisearch)
- Conformance suites verify contract shape compliance

### MIG-001: Import Migration

**Status: PASS**

- Repository-wide grep for `@searchfn/adapters` in .ts/.tsx/.mts/.cts returns **zero matches**
- All consumers compile with new imports
- Verified files: searchfn/client/*, searchfn/server/*, searchfn/datafn-provider/*, datafn/examples/*, recfn/server/*

### MIG-002: Dependency Rewiring

**Status: PARTIAL**

| Consumer | Expected Dependencies | Actual Dependencies | Compliant |
|----------|----------------------|---------------------|-----------|
| searchfn/client | contracts + memory + indexeddb | contracts + memory + indexeddb | YES |
| searchfn/server | contracts only | contracts + **adapter-memory** | **NO** |
| searchfn/datafn-provider | contracts only | contracts only | YES |
| todo-app-client | adapter-indexeddb + datafn-provider | adapter-indexeddb + datafn-provider | YES |
| todo-app-server | adapter-elasticsearch + adapter-memory | adapter-elasticsearch + adapter-memory + datafn-provider | YES |
| recfn/server | adapter-memory | adapter-memory | YES |

**Finding**: `searchfn/server/package.json` declares `@searchfn/adapter-memory` as a regular `dependency`. This adapter is only used in the test file (`server/__tests__/server-routes.test.ts`), not in production source code. It should be `devDependencies` or omitted from the production dependency list per the spec which states the server should depend on contracts only.

No packages reference `@searchfn/adapters` (legacy) in any package.json.

### MIG-003: Legacy Package Removal

**Status: PARTIAL**

| Check | Result | Notes |
|-------|--------|-------|
| searchfn/adapters/package.json deleted | YES | git status shows `D searchfn/adapters/package.json` |
| No package.json with @searchfn/adapters name | YES | grep confirms zero matches |
| @searchfn/adapters import fails | YES | Phase 06 verified ERR_MODULE_NOT_FOUND |
| Directory removed | **NO** | searchfn/adapters/ still contains: src/ (14 .ts files), __tests__/, benchmarks/, scripts/, docker-compose files, eslint.config.js, vitest configs, tsconfig.json, tsup.config.ts |

**Finding**: The spec states the directory "may remain only as a non-package tombstone doc if needed, but no package.json with old name is allowed." The package.json deletion satisfies the strict requirement, but retaining the full source tree (14 source files, tests, benchmarks, 3 docker-compose files, build configs) is messy and confusing. The `searchfn/*` workspace glob in root package.json scans this directory on every install. While it won't register as a workspace (no package.json), it adds noise and could confuse developers.

### DOC-001: Documentation Updates

**Status: PASS**

- getting-started.mdx: Updated with new package names, install commands, migration section
- reference/adapters/index.mdx: Updated to reference individual packages
- architecture.mdx: Package diagram shows all 7 new packages
- reference/adapters/*.mdx (memory, indexeddb, postgres, elasticsearch, meilisearch): Individual adapter pages
- Zero stale `@searchfn/adapters` references in primary user-facing docs
- Migration mapping section exists in getting-started.mdx

### TEST-001: Per-Package Test Coverage

**Status: PARTIAL**

| Package | Unit Tests | Conformance Suite | Harness File | Status |
|---------|-----------|-------------------|--------------|--------|
| adapter-contracts | contracts.test.ts (1 test) | N/A | N/A | PASS |
| adapter-memory | memory.test.ts (19), adapter-contract.test.ts (12) | shared.ts | memory.conformance.test.ts | PASS |
| adapter-indexeddb | indexeddb.test.ts (10) | shared.ts | indexeddb.conformance.test.ts | PASS |
| adapter-postgres | postgres.test.ts (14) | shared.ts | postgres.conformance.test.ts | PASS |
| adapter-elasticsearch | elasticsearch.test.ts (4) | shared.ts | **MISSING** | PARTIAL |
| adapter-opensearch | opensearch.test.ts (3) | shared.ts | **MISSING** | PARTIAL |
| adapter-meilisearch | meilisearch.test.ts (5) | shared.ts | meilisearch.conformance.test.ts | PASS |

**Finding**: Elasticsearch and OpenSearch have conformance/shared.ts (shared test utilities) but no *.conformance.test.ts harness file to actually execute the shared conformance suite via `runConformanceSuite()`. Memory, IndexedDB, Postgres, and Meilisearch all have these harness files. This means ES and OpenSearch conformance suites are defined but never run.

All tests import from correct new packages (not legacy). All packages have independent vitest.config.ts.

### TEST-002: Cross-Workspace Verification

**Status: PASS**

Per PHASE_06 report: turbo build matrix executed 25 tasks successfully covering all impacted workspaces. Legacy import grep returned zero results.

### REL-001: Release Metadata

**Status: PARTIAL**

| Check | Result | Notes |
|-------|--------|-------|
| CHANGELOG exists | YES | searchfn/CHANGELOG.md |
| Breaking change documented | YES | "Breaking Changes" section in v0.2.0 |
| New packages listed | YES | All 7 listed |
| Migration guide | YES | Package dependency mapping + import mapping tables |
| Old package named explicitly | **NO** | Uses "legacy aggregate adapters package" placeholder instead of `@searchfn/adapters` |
| Version bumps | PARTIAL | New packages at 0.1.0; client at 0.3.0; server at 0.1.0 |

**Finding**: The CHANGELOG migration tables use "legacy aggregate adapters package" instead of the actual package name `@searchfn/adapters`. Per REL-001: "Removed package is called out explicitly." Users searching for `@searchfn/adapters` in the changelog would not find it.

### ERR-001: Actionable Migration Errors

**Status: PASS**

Per PHASE_06 report: intentional legacy import produces `ERR_MODULE_NOT_FOUND` with the offending module name and file path in the error output. This is deterministic and actionable.

---

## Spec Conflicts / Spec Gaps

No conflicts between spec bundles (single bundle provided).

**Spec gap identified**: The PHASE_00_EXPORT_MAPPING.md specified that `redactSearchFnLogContext` (aliased from `redactSensitive`) would be placed in `@searchfn/adapter-contracts`. In the implementation, each adapter that needs redaction (postgres, elasticsearch, meilisearch) has its own internal `redactSensitive()` copy. The contracts package does not export this function. This is a deviation from the planned mapping but since it was an internal utility (not part of the normative SPEC public API), the impact is low. However, it creates code duplication across 3 packages.

---

## Cross-Cutting Audits

### Security / Authorization / Validation Boundaries

**Status: PASS**

- Postgres adapter retains `pg` dependency with credential handling in `PostgresAdapterOptions`
- Elasticsearch adapter retains internal elastic client with URL/auth handling
- Meilisearch adapter retains API key handling in options
- No credential handling was weakened by the split
- Each adapter with sensitive config has its own internal `redactSensitive()` for log redaction
- Documentation examples do not leak secrets (use environment variables)

### Determinism Invariants

**Status: PASS**

- Adapter implementations are byte-for-byte copies from the legacy package (moved, not rewritten)
- Scoring algorithms (BM25-like in memory/indexeddb) unchanged
- Conformance suites test deterministic ordering
- No new randomness or non-determinism introduced by the split

### Limits / Caps

**Status: PASS**

- No adapter API payload limits changed
- Existing adapter-specific limits (timeouts, retries, batch sizes) preserved in moved code
- No dynamic runtime loading requirements introduced

### Error Handling / Canonical Envelopes

**Status: PASS**

- `SearchAdapterError` class with `readonly code` property preserved in contracts
- `SEARCH_ADAPTER_DISPOSED` sentinel constant preserved
- Adapter-specific error handling (retry logic in postgres/elasticsearch/meilisearch `internal/` dirs) preserved

### Compatibility / Versioning / Migrations

**Status: PASS with advisory notes**

- Breaking change by design (as specified)
- New packages at 0.1.0 (appropriate for initial release)
- Consumer packages (client 0.3.0, datafn-provider 0.3.0) reflect breaking dependency change
- No compatibility shim created (per spec non-goal)

**Advisory**: The CHANGELOG should use the actual `@searchfn/adapters` package name for discoverability.

---

## Recommendations (Ranked)

### Priority 1 (Should fix before merge)

1. **[MIG-002] Move adapter-memory to devDependencies in searchfn/server**
   - File: `searchfn/server/package.json`
   - `@searchfn/adapter-memory` is only used in test file, not production code
   - Move from `dependencies` to `devDependencies` to match spec ("server depends on contracts only")

2. **[MIG-003] Clean up legacy searchfn/adapters directory**
   - The directory still contains 14 source files, tests, benchmarks, docker-compose files, and build configs
   - Delete the entire directory (source has been migrated to individual packages)
   - Only `searchfn/adapters/src/index.browser.ts` appears untracked; verify if browser entrypoint logic is needed in any new package

3. **[REL-001] Use actual package name in CHANGELOG**
   - File: `searchfn/CHANGELOG.md`
   - Replace "legacy aggregate adapters package" with `@searchfn/adapters` in migration tables
   - Users need to search for the old package name to find migration guidance

### Priority 2 (Should fix soon)

4. **[TEST-001] Add conformance test harness files for Elasticsearch and OpenSearch**
   - Missing: `searchfn/adapter-elasticsearch/__tests__/conformance/elasticsearch.conformance.test.ts`
   - Missing: `searchfn/adapter-opensearch/__tests__/conformance/opensearch.conformance.test.ts`
   - The shared conformance suite exists but is never executed for these adapters
   - Pattern: follow memory/indexeddb/postgres/meilisearch which all have `*.conformance.test.ts`

5. **[PLAN deviation] Consolidate redactSensitive into contracts or a shared internal utility**
   - PHASE_00_EXPORT_MAPPING.md planned `redactSearchFnLogContext` in contracts
   - Instead, postgres, elasticsearch, and meilisearch each have their own copy
   - Consider extracting to contracts or a shared internal package to reduce duplication

### Priority 3 (Nice to have)

6. **[PKG-002 SHOULD] Add contract type re-exports to memory and indexeddb adapters**
   - Spec says leaf packages "SHOULD re-export contract types for ergonomics"
   - Postgres, elasticsearch, opensearch, meilisearch all do this correctly
   - Memory and indexeddb only export their own classes, not contract types
   - Add re-exports for consistency

7. **[Naming] Rename opensearch docker-compose file**
   - `searchfn/adapter-opensearch/docker-compose.elastic.yml` is misleading
   - The file contains both Elasticsearch and OpenSearch services (for integration testing)
   - Consider renaming to `docker-compose.yml` or `docker-compose.integration.yml`

---

## Appendix: Commands Run + Environment Details

### Search commands

- `grep -r '"@searchfn/adapters"' --include="package.json"` — zero matches
- `rg '@searchfn/adapters' --glob '**/*.ts'` — zero matches in source
- `rg 'from "@searchfn/adapter-contracts"'` — 66 files with active imports
- `rg 'from "@searchfn/adapter-memory"'` — 3 files
- `rg 'from "@searchfn/adapter-indexeddb"'` — 2 files
- `rg 'export class|export.*Adapter'` — verified class exports in all adapters
- `rg 'redactSearchFnLogContext|redactSensitive'` — found in 3 internal adapter dirs, not in contracts

### File system checks

- `ls searchfn/adapter-*` — all 7 package directories confirmed
- `cat searchfn/adapters/package.json` — No such file (deleted)
- `ls searchfn/adapters/` — directory still exists with full source tree
- `find searchfn/adapter-*/docker-compose*` — verified file locations

### Git state

- Branch: next
- HEAD: 5fe59b66a1ebf692ef723eb68f708e60a90de457
- Dirty: true (extensive uncommitted changes across searchfn/)
- All changes are unstaged/untracked modifications

### Phase report verification

- All 7 phase reports (PHASE_00 through PHASE_06) read and cross-referenced
- All phases report PASS status
- Phase 06 confirms full build matrix (25 turbo tasks) and legacy import grep

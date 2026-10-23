# Metadata
- Timestamp (UTC): 2026-03-07T18:02:07Z
- Agent name: unknown-agent
- Model: gpt-5-codex
- Launcher: Codex Desktop
- Workspace/project absolute path: /Users/serro/Documents/dev/n/superfunctions
- OS + shell: Darwin 25.3.0 arm64 / /bin/zsh
- Repo metadata:
  - Branch: heads/next
  - Commit: 635bf2853807d9d76dba07a460dd0594f57d9147
  - Dirty status: dirty workspace (199 changed entries during execution)
- Issue file path: N/A (ad-hoc user request in session; no pre-created issue markdown)

# Issue summary
Update DataFn docs to include a thorough Capabilities concept and propagate capability-first semantics across relevant docs. Remove legacy/backward/fallback/deprecation traces from docs and codebase language so the project reads as clean current-state behavior (no migration-era framing).

# Status
PASS

# Requirements summary
## Requirements addressed
1. Add/expand Capabilities documentation under Concepts and link throughout relevant docs.
2. Align docs with current behavior from `datafn/.conduct` guidance and recent capability changes.
3. Remove legacy/backward/fallback/deprecation phrasing from docs.
4. Remove similar legacy/deprecation/backward/fallback traces from source and user-facing code paths where safe.
5. Verify builds and focused tests after cleanup.

## Requirement-by-requirement results
1. Capabilities docs integration
- Status: PASS
- Evidence:
  - Added concepts page: `datafn/docs/content/docs/documentation/concepts/capabilities.mdx`.
  - Added concepts nav entry in `datafn/docs/content/docs/documentation/concepts/meta.json`.
  - Updated core documentation and DFQL/reference pages to capability-first language and examples.
- Test status: PASS (`cd datafn/docs && npm run build`).

2. `.conduct` alignment and behavior clarity
- Status: PASS
- Evidence:
  - Updated docs to explicitly describe capability-managed readonly field ownership/stripping behavior and capability-scoped semantics.
  - Removed migration/legacy framing from concepts and related docs while keeping current behavior explanations.
- Test status: PASS (docs build + grep checks).

3. Docs legacy trace cleanup
- Status: PASS
- Evidence:
  - Removed remaining legacy/fallback wording in:
    - `documentation/advanced/change-tracking.mdx`
    - `documentation/storage/indexeddb.mdx`
    - `reference/server/execution.mdx`
    - `dfql/schema/system-fields.mdx` (final wording cleanup)
  - Final grep check on docs returned clean for target terms.
- Test status: PASS (`docs-clean`).

4. Source/codebase trace cleanup (safe, behavior-preserving)
- Status: PASS
- Evidence:
  - Removed deprecation warnings/JSDoc and legacy/backward/fallback wording in client/server/core/svelte/python non-test source.
  - Renamed neutral protocol/store symbols for clarity:
    - `PullRequestLegacy` -> `PullRequestGlobalCursor`
    - `PullResultLegacy` -> `PullResultGlobalCursor`
    - `FallbackSequenceStore` -> `ChainedSequenceStore`
    - `fallbackToIndividual` runtime handling -> `retryIndividual`
  - Updated corresponding docs/README exports and targeted tests for renamed symbols.
- Test status: PASS (builds + targeted tests).

5. Verification
- Status: PASS
- Evidence:
  - Package builds all passed (docs/core/client/server/svelte).
  - Targeted client/server tests for renamed behavior paths passed.
  - Non-test code + docs grep for target legacy terms returned clean.

# Implementation summary
## Files changed/added
### Added
- `datafn/docs/content/docs/documentation/concepts/capabilities.mdx`
- `datafn/.conduct/issue-completions/2026-03-07-t9k2m4x8-completion.md`

### Documentation updates (capabilities integration + cleanup)
- `datafn/docs/content/docs/dfql/index.mdx`
- `datafn/docs/content/docs/dfql/mutations.mdx`
- `datafn/docs/content/docs/dfql/schema/index.mdx`
- `datafn/docs/content/docs/dfql/schema/relations.mdx`
- `datafn/docs/content/docs/dfql/schema/resources.mdx`
- `datafn/docs/content/docs/dfql/schema/system-fields.mdx`
- `datafn/docs/content/docs/documentation/advanced/change-tracking.mdx`
- `datafn/docs/content/docs/documentation/advanced/security.mdx`
- `datafn/docs/content/docs/documentation/client/frameworks.mdx`
- `datafn/docs/content/docs/documentation/client/mutations.mdx`
- `datafn/docs/content/docs/documentation/client/tables.mdx`
- `datafn/docs/content/docs/documentation/concepts/meta.json`
- `datafn/docs/content/docs/documentation/concepts/multi-tenancy.mdx`
- `datafn/docs/content/docs/documentation/concepts/overview.mdx`
- `datafn/docs/content/docs/documentation/database/drizzle.mdx`
- `datafn/docs/content/docs/documentation/index.mdx`
- `datafn/docs/content/docs/documentation/plugins/overview.mdx`
- `datafn/docs/content/docs/documentation/plugins/soft-delete.mdx`
- `datafn/docs/content/docs/documentation/server/authorization.mdx`
- `datafn/docs/content/docs/documentation/server/rate-limiting.mdx`
- `datafn/docs/content/docs/documentation/server/routes.mdx`
- `datafn/docs/content/docs/documentation/server/setup.mdx`
- `datafn/docs/content/docs/documentation/server/validation.mdx`
- `datafn/docs/content/docs/documentation/storage/indexeddb.mdx`
- `datafn/docs/content/docs/documentation/sync/cross-tab.mdx`
- `datafn/docs/content/docs/reference/client/mutation.mdx`
- `datafn/docs/content/docs/reference/client/svelte.mdx`
- `datafn/docs/content/docs/reference/core/errors.mdx`
- `datafn/docs/content/docs/reference/core/schema.mdx`
- `datafn/docs/content/docs/reference/core/types.mdx`
- `datafn/docs/content/docs/reference/server/execution.mdx`
- `datafn/docs/content/docs/reference/server/routes.mdx`

### Source cleanup + naming normalization
- `datafn/client/src/errors.ts`
- `datafn/client/src/index.ts`
- `datafn/client/src/plugins/softDelete.ts`
- `datafn/svelte/src/toSvelteStore.ts`
- `datafn/client/src/offline/relations.ts`
- `datafn/server/src/routes/query.ts`
- `datafn/core/src/kv.ts`
- `datafn/client/src/signals/querySignal.ts`
- `datafn/client/src/plugins/clientSearch.ts`
- `datafn/server/src/http/json.ts`
- `datafn/client/src/offline/query.ts`
- `datafn/client/src/kv.ts`
- `datafn/client/src/client.ts`
- `datafn/server/src/execution/transact.ts`
- `datafn/server/src/execution/sync/reconcile.ts`
- `datafn/server/src/execution/mutation/relations.ts`
- `datafn/server/src/logging.ts`
- `datafn/client/src/tables/table.ts`
- `datafn/client/src/query.ts`
- `datafn/server/src/server.ts`
- `datafn/server/src/middleware/rate-limit.ts`
- `datafn/python/datafn/envelope.py`
- `datafn/python/datafn/transaction.py`
- `datafn/client/src/sync/apply.ts`
- `datafn/server/src/execution/sync/pull.ts`
- `datafn/client/src/sync/engine.ts`
- `datafn/client/src/mutate.ts`
- `datafn/server/src/execution/query/select.ts`
- `datafn/client/src/adapters/indexedDbStorage.ts`
- `datafn/server/src/execution/sync/sequence-store.ts`
- `datafn/server/src/execution/sync/change-tracking.ts`
- `datafn/server/src/index.ts`
- `datafn/SECURITY.md`
- `datafn/core/README.md`
- `datafn/server/README.md`
- `datafn/cli/README.md`

### Test updates for renamed symbols/behavior wording
- `datafn/client/src/__tests__/plugins/softDelete-deprecation.test.ts`
- `datafn/client/__tests__/mutate.test.ts`
- `datafn/server/__tests__/sync-bounded.test.ts`
- `datafn/server/__tests__/secondary-db.test.ts`
- `datafn/server/__tests__/data-integrity-high.test.ts`

## Files deleted/modified
- No files deleted in this cleanup scope.

## Key changes
- Added a dedicated Capabilities Concepts page and threaded capability-first semantics across DFQL/documentation/reference sections.
- Removed migration-era/legacy framing text from docs and user-facing source comments/messages.
- Removed explicit client deprecation warning output for soft-delete plugin construction.
- Renamed global-cursor sync and sequence-store class names to neutral current terminology while preserving behavior.
- Updated readme/export docs to reflect `ChainedSequenceStore` and related naming changes.
- Finalized wording cleanup for the specific phrase reported by user on `/docs/dfql/schema/system-fields`.

# Verification summary
## Verification steps executed
- `cd datafn/docs && npm run build` -> PASS
- `cd datafn/core && npm run build` -> PASS
- `cd datafn/client && npm run build` -> PASS
- `cd datafn/server && npm run build` -> PASS
- `cd datafn/svelte && npm run build` -> PASS
- `cd datafn/client && npm test -- mutate.test.ts src/__tests__/plugins/softDelete-deprecation.test.ts` -> PASS
- `cd datafn/server && npm test -- secondary-db.test.ts sync-bounded.test.ts data-integrity-high.test.ts` -> PASS
- `rg` checks for `legacy|deprecated|deprecation|backward compatibility|compatibility|fallback`:
  - `datafn/docs/content/docs` -> clean
  - `datafn/client/src datafn/server/src datafn/core/src datafn/svelte/src datafn/python/datafn` (excluding tests) -> clean

## Test execution results
- Builds: docs/core/client/server/svelte all successful.
- Targeted tests: client and server targeted suites successful.
- Non-test/docs cleanup grep: successful (no matches).

## Manual verification
- Confirmed the user-reported sentence in `dfql/schema/system-fields` was replaced with clean capability-first wording.
- Confirmed docs page content and navigation include `Capabilities` under Concepts.

# Notes
- Execution happened in a pre-existing dirty workspace; this report captures session-intent changes and verification for the requested docs/code cleanup scope.
- Remaining `legacy/fallback/deprecated` hits in repository are in test-only naming/comments outside the non-test cleanup criterion unless explicitly included.

# Blockers
- None.

# Metadata
- Timestamp (UTC): 2026-03-07T19:20:31Z
- Agent name: unknown-agent
- Model: gpt-5-codex
- Launcher: Codex Desktop
- Workspace/project absolute path: /Users/serro/Documents/dev/n/superfunctions
- OS + shell: Darwin 25.3.0 arm64 / /bin/zsh
- Repo metadata:
  - Branch: heads/next
  - Commit: 635bf2853807d9d76dba07a460dd0594f57d9147
  - Dirty status: dirty
- Issue file path: .conduct/issues/2026-03-08-k8m3x7r2-issue.md

# Issue summary
Remove the soft-delete plugin implementation and API surface from DataFn, remove its corresponding documentation surface, and align requirement text with capability-first lifecycle behavior.

# Status
PASS

# Requirements summary
## Requirements addressed
1. Remove soft-delete plugin from client public API and implementation.
2. Remove plugin-focused tests that enforce continued plugin support.
3. Remove soft-delete plugin docs page and all docs cross-links/examples to it.
4. Keep capability-based lifecycle (`trash`/`restore`) as the documented path.
5. Align requirement text to explicit plugin removal direction.
6. Verify via builds, targeted tests, and repository scans.

## Requirement-by-requirement results
1. Remove soft-delete plugin from API and implementation
- Status: PASS
- Evidence:
  - Removed export block from `datafn/client/src/index.ts`.
  - Deleted `datafn/client/src/plugins/softDelete.ts`.
  - Removed plugin-specific mention in client schema-validation comment in `datafn/client/src/client.ts`.
- Test status: PASS (`cd datafn/client && npm run build`).

2. Remove plugin-focused tests
- Status: PASS
- Evidence:
  - Deleted `datafn/client/src/__tests__/plugins/softDelete-deprecation.test.ts`.
  - Deleted `datafn/client/__tests__/plugins/softDelete.test.ts`.
- Test status: PASS (`cd datafn/client && npm test -- __tests__/export.test.ts src/__tests__/capability-methods.test.ts __tests__/mutate.test.ts`).

3. Remove soft-delete docs and links
- Status: PASS
- Evidence:
  - Deleted `datafn/docs/content/docs/documentation/plugins/soft-delete.mdx`.
  - Updated `datafn/docs/content/docs/documentation/plugins/meta.json` to remove `soft-delete` page entry.
  - Updated `datafn/docs/content/docs/documentation/plugins/overview.mdx` to remove soft-delete examples and link.
  - Updated `datafn/docs/content/docs/documentation/plugins/custom-plugins.mdx` to remove soft-delete registration example.
  - Updated `datafn/docs/content/docs/documentation/concepts/capabilities.mdx` to remove related soft-delete plugin link.
- Test status: PASS (`cd datafn/docs && npm run build`).

4. Capability-first docs remain the single path
- Status: PASS
- Evidence:
  - Plugin page/link references removed from active docs.
  - Capabilities docs still describe `trash`/`restore` and hard delete semantics.
- Test status: PASS (docs build + reference scan).

5. Requirement alignment
- Status: PASS
- Evidence:
  - Updated `datafn/.conduct/specs/2026-03-06-new-k4m7x9r3-spec/REQUIREMENTS.md` CL-009 statement/rationale/acceptance criteria from deprecate-and-keep to remove-and-converge.
- Test status: PASS (documentation artifact update; no runtime impact).

6. Verification and no stale references
- Status: PASS
- Evidence:
  - Reference scan returned no active matches for plugin API/docs routes outside historical `.conduct` artifacts.
- Test status: PASS (`rg -n "createSoftDeletePlugin|soft-delete|plugins/softDelete|plugins/soft-delete|\\brestore\\(client\\.table" datafn --glob '!datafn/.conduct/**' -S`).

# Implementation summary
## Files changed/added
### Modified
- `datafn/client/src/index.ts`
- `datafn/client/src/client.ts`
- `datafn/docs/content/docs/documentation/plugins/meta.json`
- `datafn/docs/content/docs/documentation/plugins/overview.mdx`
- `datafn/docs/content/docs/documentation/plugins/custom-plugins.mdx`
- `datafn/docs/content/docs/documentation/concepts/capabilities.mdx`
- `datafn/.conduct/specs/2026-03-06-new-k4m7x9r3-spec/REQUIREMENTS.md`
- `.conduct/issue-completions/2026-03-08-n4p7k2m9-completion.md`

### Deleted
- `datafn/client/src/plugins/softDelete.ts`
- `datafn/client/src/__tests__/plugins/softDelete-deprecation.test.ts`
- `datafn/client/__tests__/plugins/softDelete.test.ts`
- `datafn/docs/content/docs/documentation/plugins/soft-delete.mdx`

## Files deleted/modified
- See lists above.

## Key changes
- Removed plugin API exports and implementation.
- Removed plugin-specific tests that enforced continued support.
- Removed docs page and all direct docs references to soft-delete plugin.
- Updated CL-009 requirement text to match current capability-first direction.

# Verification summary
## Verification steps executed
- `cd datafn/client && npm run build` -> PASS
- `cd datafn/docs && npm run build` -> PASS
- `cd datafn/client && npm test -- __tests__/export.test.ts src/__tests__/capability-methods.test.ts __tests__/mutate.test.ts` -> PASS
- `rg -n "createSoftDeletePlugin|soft-delete|plugins/softDelete|plugins/soft-delete|\brestore\(client\.table" datafn --glob '!datafn/.conduct/**' -S` -> PASS (no matches)

## Test execution results
- Client build: PASS
- Docs build: PASS
- Targeted client tests: 3 files passed, 35 tests passed, 0 failed
- Reference scan: no active plugin/docs references outside `.conduct`

## Manual verification
- Confirmed deleted files are absent from filesystem and removed from docs navigation surface.
- Confirmed plugin overview and custom plugin docs no longer show soft-delete plugin usage.

# Notes
- Workspace was pre-existing dirty; only issue-relevant files listed above were modified/deleted for this execution.
- Historical mentions may remain in `.conduct` artifacts by design.
- One remaining `softDelete` string exists in `datafn/core/src/__tests__/schema-capabilities.test.ts` as an invalid capability-name test case, not plugin functionality.

# Blockers
- None.

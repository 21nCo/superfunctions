# Metadata
- Timestamp (UTC): 2026-03-07T05:38:17Z
- Agent name: unknown-agent
- Model: gpt-5-codex
- Launcher: Codex Desktop
- Workspace/project absolute path: /Users/serro/Documents/dev/n/superfunctions
- OS + shell: Darwin 25.3.0 arm64 / /bin/zsh
- Repo metadata:
  - Branch: heads/next
  - Commit: 635bf2853807d9d76dba07a460dd0594f57d9147
  - Dirty status: 134 changed entries (workspace already dirty before execution)
- Issue file path: /Users/serro/Documents/dev/n/superfunctions/datafn/.conduct/issues/2026-03-07-y8m4k2p7-issue.md

# Issue summary
`/datafn/push` rejected mutations containing capability-managed readonly fields; client local-first writes could persist partial optimistic records; and client outbound payloads could include server-owned capability fields.

# Status
PASS

# Requirements summary
## Requirements addressed
1. Always strip readonly capability fields in `/datafn/push` before validation/execution.
2. Strip only when capability is enabled for the target resource.
3. Inject capability-managed optimistic fields (`timestamps`, `audit`) in client local-first/offline writes.
4. Ensure client outbound mutation/push payloads do not include readonly capability-managed fields.
5. Update docs to state server-owned capability field behavior and guidance for user-managed alternatives.
6. Add/update tests covering parity and non-capability stripping behavior.

## Requirement-by-requirement results
1. Server push stripping parity
- Status: PASS
- Evidence:
  - Implemented pre-validation mutation normalization in `datafn/server/src/routes/sync.ts` using capability resolution + `stripReadonlyCapabilityFields`.
  - Verified by test `push insert strips client-provided readonly capability fields before validation` in `datafn/server/src/execution/sync/__tests__/push-capabilities.test.ts`.
- Test status: PASS (`npx vitest run src/execution/sync/__tests__/push-capabilities.test.ts`, 6/6 tests).

2. Strip only when capability enabled
- Status: PASS
- Evidence:
  - Stripping path resolves resource capabilities before field removal.
  - Added test `does not strip similarly named fields when capability is not enabled` proving `createdAt` remains writable when declared as a normal field without capability.
- Test status: PASS (`npx vitest run src/execution/sync/__tests__/push-capabilities.test.ts`, 6/6 tests).

3. Client optimistic capability injection
- Status: PASS
- Evidence:
  - Added `injectCapabilityFieldsForOptimisticRecord` in `datafn/client/src/capability-fields.ts`.
  - Applied in local-first debounced merge path (`datafn/client/src/mutate.ts`) and offline/local write path (`datafn/client/src/offline/mutate.ts`) with timestamp + actor injection.
  - Added test `local-first injects capability fields optimistically but strips them from changelog mutations`.
- Test status: PASS (`npx vitest run src/__tests__/capability-methods.test.ts`, 7/7 tests).

4. Client outbound sanitization
- Status: PASS
- Evidence:
  - Added `sanitizeCapabilityReadonlyFields` utility and applied before remote mutation and changelog persistence.
  - Added test `strips readonly capability fields from outbound mutation payloads` asserting transport payload excludes `createdAt/updatedAt/createdBy/updatedBy`.
- Test status: PASS (`npx vitest run src/__tests__/capability-methods.test.ts`, 7/7 tests).

5. Documentation update
- Status: PASS
- Evidence:
  - Updated `datafn/docs/content/docs/dfql/schema/system-fields.mdx` to state capability-managed fields are stripped/ignored and to use alternate names or disable capability for app-controlled semantics.
- Test status: N/A (docs change).

6. Regression safety via focused tests
- Status: PASS
- Evidence:
  - Server push capability suite extended and passing.
  - Client capability methods suite extended and passing.
- Test status: PASS.

# Implementation summary
## Files changed/added
- Added: `datafn/client/src/capability-fields.ts`
- Modified: `datafn/client/src/mutate.ts`
- Modified: `datafn/client/src/offline/mutate.ts`
- Modified: `datafn/server/src/routes/sync.ts`
- Modified: `datafn/client/src/__tests__/capability-methods.test.ts`
- Modified: `datafn/server/src/execution/sync/__tests__/push-capabilities.test.ts`
- Modified: `datafn/docs/content/docs/dfql/schema/system-fields.mdx`
- Modified (issue execution context): `datafn/.conduct/issues/2026-03-07-y8m4k2p7-issue.md`

## Files deleted/modified
- No files deleted.

## Key changes
- Introduced client capability normalization utilities for:
  - readonly capability field stripping for outbound mutations
  - optimistic capability field injection for local-first/offline apply
- Ensured changelog stores sanitized mutations (prevents invalid push payloads).
- Brought `/datafn/push` validation behavior in line with `/datafn/mutation` for record operations.
- Added explicit tests for both positive and negative capability-strip behavior.
- Updated documentation guidance for capability-managed fields.

# Verification summary
## Verification steps executed
- `cd datafn/server && npx vitest run src/execution/sync/__tests__/push-capabilities.test.ts` -> PASS (6 tests)
- `cd datafn/client && npx vitest run src/__tests__/capability-methods.test.ts` -> PASS (7 tests)
- `cd datafn/client && npx tsc --noEmit` -> PASS
- `cd datafn/server && npx tsc --noEmit` -> FAIL (pre-existing baseline errors unrelated to this issue):
  - `src/execution/query/pushdown.ts(85,6) TS7006`
  - `src/validation/authz.ts(399,6) TS7006`
  - `src/validation/mutation.ts(159,6) TS7006`

## Test execution results
- Server focused suite: 1 file, 6 tests passed, 0 failed.
- Client focused suite: 1 file, 7 tests passed, 0 failed.
- No failures in changed-path tests.

## Manual verification
- Verified code paths now sanitize readonly capability fields before push validation and before outbound mutation transport.
- Verified optimistic local writes now receive capability-injected fields for timestamps/audit paths.

# Notes
- The server TypeScript compile errors are pre-existing and outside this issue’s modified code paths.
- No public API signature was changed.
- No TODOs or deferred placeholders were introduced.
- Changes were limited to issue scope: push parity, client sanitization/injection, tests, and docs.

# Blockers
- None.

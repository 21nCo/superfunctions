# Issue Completion: McpFn Push Blockers

## Metadata

- **Timestamp**: 2026-08-11T15:19:16Z
- **Agent**: unknown-agent
- **Model**: GPT-5 (Codex)
- **Launcher**: Codex Desktop
- **Workspace**: repo root
- **OS / shell**: Darwin arm64, zsh
- **Git branch**: codex/mcpfn
- **Git commit at completion**: 721eefdd
- **Dirty status**: dirty working tree containing the complete uncommitted McpFn change set
- **Issue source**: user request to fix all McpFn push blockers without pushing

## Issue Summary

Bring the uncommitted McpFn change set onto the latest `sf-next/next` base and remove all identified correctness, integration, release-gate, and CI-routing blockers while leaving the branch unpushed.

## Status

PASS

## Requirements Summary

1. The worktree must be based on the current `sf-next/next` commit.
   - **Status**: PASS
   - **Evidence**: after `git fetch sf-next next`, both `HEAD` and `sf-next/next` resolved to `721eefdd9cd716894e5329123a9e2fb615783611`.
   - **Test status**: base comparison passed immediately before the final release gate.

2. OAuth resource-server validation must reject tokens that are not explicitly bound to the configured resource.
   - **Status**: PASS
   - **Evidence**: `mcpfn/auth/tests/auth.test.ts` covers missing and incorrect resource claims; `mcpfn/testing/tests/auth.test.ts` exercises the reusable missing-resource scenario.
   - **Test status**: auth tests passed, 3 tests; reusable auth tests passed, 8 tests; Playwright auth flow passed.

3. McpFn tools must expose valid public schemas and results without leaking storage-internal DTO fields.
   - **Status**: PASS
   - **Evidence**: MemoryFn declares public output schemas and projects add/search results; tests reject tenant, embedding, identifier, tag, and internal-metadata leakage.
   - **Test status**: `memoryfn/typescript/tests/mcp.test.ts` passed.

4. DataFn-generated MCP input schemas must match runtime inputs, including JSON arrays, epoch dates, nullable fields, defaults, and create allowlists.
   - **Status**: PASS
   - **Evidence**: `mcpfn/datafn/tests/adapter.test.ts` covers all listed schema cases and rejects incomplete create allowlists.
   - **Test status**: DataFn adapter tests passed, 4 tests; DataFn server typecheck, full test suite, and build passed in the release gate.

5. CLI misuse must return a non-zero exit code.
   - **Status**: PASS
   - **Evidence**: empty invocation and unknown commands return exit code 2; regression coverage is in `mcpfn/cli/tests/cli.test.ts`.
   - **Test status**: CLI tests passed, 3 tests; manifest, validate, diff, and scenario commands passed in the release gate.

6. Existing LangFn, MemoryFn, and ProbeFn integrations must preserve protocol behavior after adopting McpFn.
   - **Status**: PASS
   - **Evidence**: LangFn handles structured and text-only tool results; ProbeFn publishes the same server instructions in its runtime and manifest; MemoryFn publishes sanitized structured results.
   - **Test status**: LangFn passed 12 files / 53 tests; MemoryFn MCP test passed; ProbeFn MCP suite passed 6 tests.

7. Release and CI routing must test both McpFn-specific and repository-global JavaScript changes conservatively.
   - **Status**: PASS
   - **Evidence**: global files no longer fall into the McpFn-only CI support boundary; the root release gate includes official protocol conformance, package imports, package dry-runs, examples, downstream integrations, and documentation inventory.
   - **Test status**: direct CI-boundary assertion passed; full `gate:mcpfn-release` returned `ok: true` with every step successful.

8. The completed work must remain local.
   - **Status**: PASS
   - **Evidence**: no commit, push, pull request, or staging operation was performed.
   - **Test status**: final Git status remains dirty on `codex/mcpfn`.

## Implementation Summary

### Files modified

- `.github/workflows/ci.yml`
- `README.md`
- `datafn/server/src/index.ts`
- `datafn/server/src/server.ts`
- `langfn/typescript/package.json`
- `langfn/typescript/src/mcp/client.ts`
- `langfn/typescript/src/mcp/server.ts`
- `langfn/typescript/src/mcp/sse.ts`
- `langfn/typescript/src/mcp/stdio.ts`
- `langfn/typescript/src/mcp/types.ts`
- `langfn/typescript/tests/mcp-and-eval.test.ts`
- `langfn/typescript/tests/release-gate.test.ts`
- `langfn/typescript/tsconfig.json`
- `langfn/typescript/tsup.config.ts`
- `memoryfn/typescript/package.json`
- `memoryfn/typescript/src/mcp/server.ts`
- `package-lock.json`
- `package.json`
- `probefn/packages/mcp-server/package.json`
- `probefn/packages/mcp-server/src/server.ts`
- `probefn/packages/mcp-server/test/mcp-server.test.ts`
- `release-packages.json`
- `scripts/ci-plan.mjs`
- `.conduct/logs.csv`
- `.conduct/tracker.csv`

### Files added

- `.conduct/issue-completions/2026-08-11-q7m2x9k4-completion.md`
- `datafn/server/src/__tests__/executor.test.ts`
- `datafn/server/src/executor.ts`
- `mcpfn/ARCHITECTURE.md`
- `mcpfn/MIGRATION.md`
- `mcpfn/README.md`
- `mcpfn/TESTING.md`
- `mcpfn/auth/README.md`
- `mcpfn/auth/package.json`
- `mcpfn/auth/src/enterprise.ts`
- `mcpfn/auth/src/index.ts`
- `mcpfn/auth/src/resource-server.ts`
- `mcpfn/auth/tests/auth.test.ts`
- `mcpfn/auth/tsconfig.json`
- `mcpfn/auth/tsup.config.ts`
- `mcpfn/auth/vitest.config.ts`
- `mcpfn/cli/README.md`
- `mcpfn/cli/package.json`
- `mcpfn/cli/src/bin.ts`
- `mcpfn/cli/src/index.ts`
- `mcpfn/cli/src/load.ts`
- `mcpfn/cli/tests/cli.test.ts`
- `mcpfn/cli/tsconfig.json`
- `mcpfn/cli/tsup.config.ts`
- `mcpfn/cli/vitest.config.ts`
- `mcpfn/core/README.md`
- `mcpfn/core/package.json`
- `mcpfn/core/src/apps.ts`
- `mcpfn/core/src/canonical.ts`
- `mcpfn/core/src/diff.ts`
- `mcpfn/core/src/errors.ts`
- `mcpfn/core/src/index.ts`
- `mcpfn/core/src/manifest.ts`
- `mcpfn/core/src/registry.ts`
- `mcpfn/core/src/results.ts`
- `mcpfn/core/src/server.ts`
- `mcpfn/core/src/types.ts`
- `mcpfn/core/tests/manifest-diff.test.ts`
- `mcpfn/core/tests/protocol.test.ts`
- `mcpfn/core/tests/server.test.ts`
- `mcpfn/core/tsconfig.json`
- `mcpfn/core/tsup.config.ts`
- `mcpfn/core/vitest.config.ts`
- `mcpfn/datafn/README.md`
- `mcpfn/datafn/package.json`
- `mcpfn/datafn/src/adapter.ts`
- `mcpfn/datafn/src/index.ts`
- `mcpfn/datafn/src/types.ts`
- `mcpfn/datafn/tests/adapter.test.ts`
- `mcpfn/datafn/tsconfig.json`
- `mcpfn/datafn/tsup.config.ts`
- `mcpfn/datafn/vitest.config.ts`
- `mcpfn/examples/calculator-http-server.ts`
- `mcpfn/examples/calculator-scenarios.ts`
- `mcpfn/examples/calculator-server.ts`
- `mcpfn/examples/calculator.manifest.json`
- `mcpfn/examples/conformance-http-server.ts`
- `mcpfn/testing/README.md`
- `mcpfn/testing/package.json`
- `mcpfn/testing/playwright.config.ts`
- `mcpfn/testing/playwright/auth-flow.spec.ts`
- `mcpfn/testing/src/assertions.ts`
- `mcpfn/testing/src/auth-core.ts`
- `mcpfn/testing/src/auth.ts`
- `mcpfn/testing/src/client.ts`
- `mcpfn/testing/src/conformance.ts`
- `mcpfn/testing/src/host-profiles.ts`
- `mcpfn/testing/src/index.ts`
- `mcpfn/testing/src/mock-oauth-server.ts`
- `mcpfn/testing/src/playwright.ts`
- `mcpfn/testing/src/scenarios.ts`
- `mcpfn/testing/tests/auth.test.ts`
- `mcpfn/testing/tests/mock-oauth-server.test.ts`
- `mcpfn/testing/tests/playwright-helpers.test.ts`
- `mcpfn/testing/tests/testing.test.ts`
- `mcpfn/testing/tsconfig.json`
- `mcpfn/testing/tsup.config.ts`
- `mcpfn/testing/vitest.config.ts`
- `memoryfn/typescript/tests/mcp.test.ts`
- `scripts/gate-mcpfn-release.mjs`
- `scripts/test-mcpfn-conformance.mjs`

No files were deleted.

### Key changes

- Added the McpFn core, auth, testing, DataFn adapter, CLI, examples, documentation, package registration, release gate, and official conformance runner.
- Added protocol-safe coded-error conversion, compatibility-diff metadata, web `authInfo` propagation, OAuth resource binding, and reusable auth regression coverage.
- Integrated McpFn into DataFn, LangFn, MemoryFn, and ProbeFn with downstream regression tests.
- Added conservative CI routing and package/release inventory coverage.
- Projected MemoryFn results into explicit public schemas instead of returning internal storage objects.
- Made CLI usage failures observable through exit status 2.

## Verification Summary

Executed and passed from the repository root:

```bash
npm run typecheck --workspace @mcpfn/core
npm run test --workspace @mcpfn/core
npm run typecheck --workspace @mcpfn/auth
npm run test --workspace @mcpfn/auth
npm run typecheck --workspace @mcpfn/testing
npm run test --workspace @mcpfn/testing
npm run test:playwright --workspace @mcpfn/testing
npm run typecheck --workspace @mcpfn/datafn
npm run test --workspace @mcpfn/datafn
npm run typecheck --workspace @mcpfn/cli
npm run test --workspace @mcpfn/cli
npm --prefix langfn/typescript run typecheck
npm --prefix langfn/typescript run test -- --run
npm --prefix memoryfn/typescript run test -- --run tests/mcp.test.ts
npm run typecheck --workspace @probefn/mcp-server
npm run test --workspace @probefn/mcp-server -- --run test/mcp-server.test.ts
npm ci --dry-run --ignore-scripts
npm run gate:mcpfn-release
git diff --check
git fetch sf-next next
```

Release-gate result:

- Full gate: PASS, `ok: true`.
- All 43 gate steps passed, including package typechecks/tests/builds, Playwright, DataFn server integration, CLI examples, official conformance, downstream consumers, ESM/CJS loading, package dry-runs, and documentation inventory.
- Focused suites: core 16 tests; auth 3 tests; reusable auth 8 tests; DataFn adapter 4 tests; CLI 3 tests; LangFn 53 tests; MemoryFn MCP 1 test; ProbeFn MCP 6 tests.
- `git diff --check`: PASS.
- Lockfile dry-run: PASS.
- Direct probes: missing OAuth resource returned 401; empty/unknown CLI invocations returned 2; global CI paths retained generic JavaScript CI.

The first full-gate attempt exposed a local `better-sqlite3` ABI mismatch. Rebuilding that dependency under the bundled Node 24.14.0 runtime resolved the environment mismatch; the unchanged code then passed the complete gate.

## Notes

- The issue was supplied as a description, so the tracker identifier is `2026-08-11-mcpfn-push-blockers-issue`.
- The branch and all working-tree changes remain local and uncommitted as requested.
- A pre-sync safety stash remains available as a recovery point and was not altered.
- The npm audit output reported existing repository dependency advisories; it was not used as evidence of an McpFn test or release failure.

## Blockers

None.

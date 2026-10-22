# ProbeFn Turbo dependency graph

2026-10-22. The hosted JavaScript failure in run 39745919767/job 119714702741
reported cycles involving browser-runner, core, session-reporter, analyzers,
visual-baselines and dev-server. Those cycles are absent at the ProbeFn checkpoint
`d24e60a3d2e6a938fc8d55e082dc12ea7c5027aa`.

## Existing architectural fix

Commit `e9d073d6fd9a6e8a6ecd0275927e53fa932b2734` moved integration-test
ownership to the root-owned ProbeFn workspace harness. Test-only reverse package
edges moved into that harness, while runtime dependencies remain in the source
packages. Package-local test/typecheck scripts moved to the harness; the nested
pnpm workspace/lock and Turbo configuration were removed. Commit
`0e8d2a1146b8174c4b07e84e17840d581b0f7bae` gives the harness its unambiguous
`@probefn/workspace` name. These are prerequisites for branches still carrying
the older cyclic manifests; deleting runtime dependencies is not a valid fix.

The runtime direction is contracts/storage and analyzers below session-reporter,
then core, then browser-runner. Dev-server owns CLI orchestration and depends on
browser-runner, core and visual-baselines. The integration harness depends on all
of these without any reverse runtime dependency on the harness.

An AST inspection of static imports/exports and dynamic import expressions in
all nine ProbeFn package source directories found one missing declaration:
`session-reporter/src/report-json.ts` imports `iterateEventSinkFamily` from
`@probefn/storage`. This import was added by streaming checkpoint `a5e4445fde`.
The reporter manifest and its exact root lock entry now declare that required
runtime edge. Storage depends only on contracts, so this adds no cycle.

## Validation

- Actual Turbo 2.6.1 `run build --dry=json` accepts the entire root graph before
  and after the reporter edge correction. The final task graph contains
  `@probefn/session-reporter#build -> @probefn/storage#build`.
- Actual Turbo `run typecheck --filter=@probefn/workspace` succeeds on Node
  22.23.3, including the MCP CJS/ESM/declaration prerequisite build.
- The full Turbo test harness executed 177 tests: 166 passed, 3 failed and 8
  skipped. Two browser fixture failures use ports 4178 and 4183, occupied by
  independently verified unrelated DevFn fixture processes. The attach test
  reported EADDRINUSE at port 4175, and MCP setup exceeded its 10-second hook
  timeout. Unrelated processes were not stopped. This run is not a green full
  acceptance result and those fixture/setup limitations remain separate.
- Actual Turbo `run test --filter=@probefn/workspace -- packages/session-reporter/test`
  passes all 9 reporter/streaming tests in 2 files. `git diff --check` passes.
  No new runtime behavior or provider integration is claimed here.

Logs: `/tmp/probe-turbo-after.json`, `/tmp/probe-turbo-typecheck.log`,
`/tmp/probe-turbo-tests.log`, `/tmp/probe-turbo-report-tests.log`.
The Turbo executable came from the existing main checkout installation; it
reported version 2.6.1 and warned that this scoped node_modules has no local Turbo
binary. No dependency install or broad lock regeneration was performed.

## Shared integration and isolated fixture ports

The ordinary merge of Shared `9a93c4970f4c3045a0734af7baf4a4d73f1c373a`
preserves the root-owned Probe harness and both reporter/visual-baselines runtime
storage dependencies. The root graph retains the Shared docs/React dependency
corrections and Next 15.5.28 with its sharp 0.35.5 dependency.

Browser action/trace fixtures now bind port zero and use the readiness output's
actual address. The attach fixture also binds port zero and reads its actual
address. This removes collisions with unrelated services without stopping them;
no product readiness deadline or test assertion changed.

Normal npm 11 scoped `ci --workspace=@probefn/workspace
--include-workspace-root=false --no-audit --no-fund` installed 394 packages on
Node 22.22.0 without force or peer-resolution bypasses. npm warned that several
esbuild versions and msw were absent from its allowScripts list; no approval
configuration was changed. The subsequent real MCP build succeeded.

Actual Turbo 2.6.1 root build dry-run accepts 301 tasks with docs-theme and storage
runtime edges intact. Actual Turbo Probe typecheck passes, including the MCP
CJS/ESM/declaration prerequisite. The first full run during concurrent sibling
builds hit default browser/MCP setup deadlines (162 pass, 1 fail, 14 skipped).
All 18 affected cases passed separately with diagnostic 30s/60s limits; then the
full Turbo harness passed **177 tests in 35 files with the original default
limits unchanged** (54.47s Vitest, 57.03s Turbo). Reporter, native Chromium, MCP,
process ownership, SQLite storage, and design cases are included. This is local
acceptance evidence, not hosted CI or cross-browser certification.

Logs: `/tmp/probe-shared-ci-install.log`, `/tmp/probe-shared-turbo-build.json`,
`/tmp/probe-shared-turbo-types.log`, `/tmp/probe-shared-turbo-full.log`,
`/tmp/probe-native-diagnostic.log`, `/tmp/probe-design-diagnostic.log`,
`/tmp/probe-shared-turbo-full-rerun.log`.

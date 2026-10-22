# Shared integration checkpoint

2026-10-22. Clean checkpoint `cd6cdd519` ordinarily merged Shared
`c0ce24b30ef7935e79a400ed27fcc8ffac1b5d42` as
`f1e5a0c627b74792c556c8893d584ffe984b5702`. The root lock merged without
conflict or regeneration. No TestFn runtime source changes were made.

Bounded validation on Node 22.22.0:

- Normal npm 11 `ci --dry-run --workspace=@testfn/core
  --include-workspace-root=false --no-audit --no-fund` passes without force or
  peer-resolution bypasses. Install-script approval warnings remain; approval
  configuration was not changed. This is install planning, not fresh installation.
- Actual Turbo 2.6.1 root build dry-run accepts 300 tasks and the core's shared DB
  build dependency. It does not execute all root builds.
- Core `typecheck` and `build` pass with current installed dependencies. The build
  emits the native IndexedDB browser bundle and parses the emitted output as ES5.
- `git diff --check` passes. Generated build outputs remain ignored.

Only graph/install planning, core types and build were checked in this bounded
integration. No unit/full suite, admin, Python, native database, browser engine,
provider or packed-consumer acceptance was rerun. Earlier evidence remains
historical and is not a result at this merged head. Historical IndexedDB engine
minimums, native Safari, hosted workflow execution, unpublished package delivery
and the original remaining readiness gates are not closed by compilation or ES5
syntax parsing. No publication, deployment or base-branch merge occurred.

Logs: `/tmp/test-shared-ci-dry.log`, `/tmp/test-shared-graph.json`,
`/tmp/test-shared-types.log`, `/tmp/test-shared-build.log`.

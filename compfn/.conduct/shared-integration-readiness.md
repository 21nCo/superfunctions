# Shared integration checkpoint

2026-10-22. Clean CompFn checkpoint `fc7078939` was ordinarily merged with Shared
`c0ce24b30ef7935e79a400ed27fcc8ffac1b5d42` as `66ee1019e1b38c2dee27715ca2161c12e7236371`.
The root manifest and lock merged without conflicts or regeneration. No CompFn
runtime source changes, provider calls, deployment or base-branch merge occurred.

Validation:

- Normal npm 11 scoped `ci --dry-run --workspace=compfn
  --include-workspace-root=false --no-audit --no-fund` succeeds, without force or
  peer-resolution bypasses. This checks lock/install planning, not a fresh native
  package installation. npm reports uncovered install scripts for better-sqlite3,
  esbuild and msw; script approval configuration was not changed.
- Materializing the tracked root `turbo.json` in this sparse checkout allows the
  actual Turbo 2.6.1 root build dry-run to pass: 301 tasks, with CompFn depending
  on shared DB and HTTP builds. It does not execute all root builds.
- Core/CLI and admin typechecks pass on Node 22.22.0. The admin suite passes all
  8 tests in 2 files.
- The initial Node 22 core run has 126 passing and 3 failing tests because the
  existing better-sqlite3 binary uses Node 20 ABI 115 rather than ABI 127. No
  application assertion or timeout was changed. Using the installed dependency
  environment's documented Node 20.20.0, all 129 core tests in 16 files pass,
  including native evidence immutability and multi-process persistent CLI tests.
  Core and CLI builds also pass on Node 20.20.0.

The AuthFn/SecFn interfaces remain host-provided bridge contracts, not their
public SDK clients. Injected-client tests do not establish actual deployed
AuthFn/SecFn acceptance. Those integration/provider gates, hosted CI and broader
original readiness requirements remain open. This checkpoint does not turn
normal dry-run success into clean native-install evidence.

Logs: `/tmp/comp-shared-ci-dry.log`, `/tmp/comp-shared-graph.json`,
`/tmp/comp-shared-types.log`, `/tmp/comp-shared-tests.log`,
`/tmp/comp-shared-tests-node20.log`, `/tmp/comp-shared-build.log`.

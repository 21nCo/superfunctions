# ProbeFn root-workspace and runtime checkpoint

2026-10-19 UTC. Branch starts at shared prerequisite d8d443a5c; this is partial progress toward the original ProbeFn specification.

The root npm workspace now owns the ProbeFn integration-test harness. Test-only cross-package dependencies moved into that harness, removing cycles such as core -> browser-runner -> core while retaining runtime dependencies. Private source packages remain private TypeScript entry points. The nested pnpm lock/workspace and Turbo config are removed; one root lock and Turbo DAG are used. Package-local test/typecheck scripts are replaced by the harness commands documented in README. The MCP dependency resolves the actual local @mcpfn/core 0.0.6 workspace, built as a Turbo prerequisite.

Tests run sequentially because fixtures share local artifacts and ports. Analyzer fixtures allocate available ports rather than colliding with another local service. The MCP schema constructor lives in an independent module so CLI import order cannot call an uninitialized circular server export. Accessibility snapshots use the supported Playwright API. Test artifacts are ignored. The vector runner invokes npm commands; its aggregate fixture vector is no longer marked passed by an empty callback, and only passes after the entire unfiltered suite succeeds.

Validation:

- Root lock regenerated with npm11; clean scoped npm10 installation passes (395 packages), plus local MCP CJS/ESM/declaration build.
- Node22.23.3 unified TypeScript check passes for apps, packages, tests and vector script, using the existing strict base options.
- Turbo2 dry-run accepts the root dependency graph and schedules MCP build before ProbeFn tests/typecheck. This is graph evidence, not a claim that all repository packages build.
- Full Vitest suite: **58 tests in17 files pass**, using actual matching Playwright Chromium1200. CLI, MCP stdio, browser actions/semantic targeting, design analysis, visual baselines, storage and reporting run locally.
- Filtered vite-hangs vector command passes two session vectors through the migrated npm subprocess path; the aggregate vector is correctly absent from filtered output. The full vector matrix was not rerun.

Initial runs exposed absent Chromium1200 and fixture servers left behind when browser setup failed. Only servers whose working directory matched this task checkout were stopped; another service occupying4202 was preserved, and analyzer ports were made dynamic. The matching browser was installed. The first full rerun then exposed the circular schema import; the final58-test run above follows both fixes. Tests still need broader failure-path cleanup hardening; a failed setup can leave fixture processes. A directory-named npm workspace selector also selected nested packages and returned nonzero for missing scripts after the successful harness command. The harness is now named @probefn/workspace; commands use that unambiguous name.

Remaining original gates: full spec/vector acceptance, Firefox/WebKit, complete lifecycle/failure cleanup, packed/private distribution strategy, full admin integration, shared adapter/provider coverage, security/performance/accessibility and hosted/runtime deployment acceptance. There is no Python implementation in this package. No full production-readiness claim, deployment or release.

Final harness selector validation: clean npm10 scoped ci, MCP build, npm run typecheck --workspace=@probefn/workspace, scoped Turbo dry-run and npm run test:vectors --workspace=@probefn/workspace -- --fixture vite-hangs all exit0. The filtered vector reports2passed/0failed. This resolves the earlier npm directory-selector exit failure.

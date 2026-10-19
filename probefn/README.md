# probefn

Probefn is the Superfunctions browser evidence function for coding agents and humans who need to:

- drive local web apps through Playwright-backed automation
- inspect runtime evidence instead of guessing root causes
- review design quality and responsive behavior
- detect and explain visual regressions
- persist reusable local auth profiles

The implementation spec for this repository lives under `.conduct/specs/2026-04-15-new-384qfawh-spec/`.

## Local-First Guarantees

Core operation does not require a hosted Probefn service. Session orchestration, artifacts, design audits, baseline storage, report export, and auth profiles all live in the repository workspace.

## Super Console Administration

`@probefn/admin` mounts an explicitly configured repository and `ArtifactStore`
at one exact installation/workspace/project/environment scope. Its REST, MCP,
console, and TypeScript projections expose only the public local runtime APIs:

- read, initialize, and transition a known session
- capture event baselines and compute deltas
- capture a checkpoint through a configured, already-authorized live source
- export redacted JSON or Markdown reports
- project repository-relative run and checkpoint paths

The admin package intentionally does not advertise session enumeration, browser
startup/cancellation, visual-baseline approval, flows, auth-profile mutation, or
cloud control-plane operations because the current ProbeFn core has no matching
scoped administration API for those features. Evidence capture and report export
require confirmation and audit; bindings that overlap one artifact store are
rejected to prevent cross-environment access.

## Workspace commands

ProbeFn uses the root Superfunctions npm lock and Turbo graph. The `probefn`
workspace owns integration tests and their cross-package development dependencies;
private runtime packages keep an acyclic production dependency graph. Run
`npx turbo run test typecheck --filter=probefn` from the repository root, or
`npm test --workspace=probefn -- packages/contracts/test` for a focused suite.
The MCP dependency must be built first (`npm run build --workspace=@mcpfn/core`)
when invoking tests directly instead of through Turbo. Install the matching
browser using `npm exec --workspace=probefn -- playwright install chromium`.
Private runtime packages still expose TypeScript source; this is not a published
npm package build or full browser support guarantee.

## Quick Start

```bash
npm ci # from the Superfunctions repository root
npm run test:vectors --workspace=probefn
npm run --silent probefn --workspace=probefn -- session start --config test/fixtures/vite-healthy/probefn.config.ts --mode mixed --browser chromium --json
npm run --silent probefn --workspace=probefn -- checkpoint create --session sess_healthy --name landing --json
npm run --silent probefn --workspace=probefn -- audit design --session sess_healthy --checkpoint chk_landing --json
```

## Docs

- [Getting Started](docs/getting-started.md)
- [Agent Consumption](docs/agent-consumption.md)
- [Artifacts](docs/artifacts.md)
- [Baselines](docs/baselines.md)

## Key Commands

```bash
npm run --silent probefn --workspace=probefn -- session start --config test/fixtures/vite-healthy/probefn.config.ts --mode mixed --browser chromium --json
npm run --silent probefn --workspace=probefn -- page find --session sess_healthy --query "Save button" --json
npm run --silent probefn --workspace=probefn -- checkpoint create --session sess_healthy --name landing --include-trace --include-styles --json
npm run --silent probefn --workspace=probefn -- report export --session sess_healthy --format json
npm run --silent probefn --workspace=probefn -- run flow --session sess_console_error --file test/fixtures/vite-console-error/flows/trigger-error.yaml --json
npm run --silent probefn --workspace=probefn -- auth profile save --session sess_auth --profile customer-admin --json
npm run --silent probefn --workspace=probefn -- mcp serve --stdio
```

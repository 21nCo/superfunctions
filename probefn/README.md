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

## Quick Start

```bash
pnpm install
pnpm test:vectors
pnpm probefn session start --config test/fixtures/vite-healthy/probefn.config.ts --mode mixed --browser chromium --json
pnpm probefn checkpoint create --session sess_healthy --name landing --json
pnpm probefn audit design --session sess_healthy --checkpoint chk_landing --json
```

## Docs

- [Getting Started](docs/getting-started.md)
- [Agent Consumption](docs/agent-consumption.md)
- [Artifacts](docs/artifacts.md)
- [Baselines](docs/baselines.md)

## Key Commands

```bash
pnpm probefn session start --config test/fixtures/vite-healthy/probefn.config.ts --mode mixed --browser chromium --json
pnpm probefn page find --session sess_healthy --query "Save button" --json
pnpm probefn checkpoint create --session sess_healthy --name landing --include-trace --include-styles --json
pnpm probefn report export --session sess_healthy --format json
pnpm probefn run flow --session sess_console_error --file test/fixtures/vite-console-error/flows/trigger-error.yaml --json
pnpm probefn auth profile save --session sess_auth --profile customer-admin --json
pnpm probefn mcp serve --stdio
```

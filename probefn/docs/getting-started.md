# Getting Started

Probefn is a local-first browser evidence framework for coding agents and humans who need deterministic browser automation, runtime debugging evidence, design audits, and visual regression checks without shipping artifacts to a remote service.

## Prerequisites

- Node.js `>=22.0.0` is recommended by the workspace.
- `pnpm` `10.x`
- A local checkout of the repository.

## Install

From the repository root:

```bash
pnpm install
```

## Run The Golden Vectors

Use the repo-root vector suite to verify the local framework contract:

```bash
pnpm test:vectors
```

To focus on a specific local fixture:

```bash
pnpm test:vectors -- --fixture vite-healthy
pnpm test:vectors -- --fixture vite-auth
```

## Start A Local Session

All core workflows are local-first. Sessions start from a repository-relative config file, write artifacts under `.artifacts/`, and do not require cloud auth, remote storage, or hosted orchestration.

```bash
pnpm probefn session start \
  --config test/fixtures/vite-healthy/probefn.config.ts \
  --mode mixed \
  --browser chromium \
  --json
```

The healthy fixture returns deterministic fixture identifiers:

- session: `sess_healthy`
- run: `run_healthy`

## Core Session Lifecycle

```bash
pnpm probefn session start --config test/fixtures/vite-healthy/probefn.config.ts --mode mixed --browser chromium --json
pnpm probefn checkpoint create --session sess_healthy --name landing --json
pnpm probefn audit design --session sess_healthy --checkpoint chk_landing --json
pnpm probefn report export --session sess_healthy --format json
```

For visual regressions:

```bash
pnpm probefn baseline record --session sess_healthy --checkpoint chk_landing --key home.desktop.chromium.light.1440x900.utc --json
pnpm probefn baseline compare --session sess_healthy --checkpoint chk_landing --key home.desktop.chromium.light.1440x900.utc --json
```

## Fixture Configs

The repository ships local configs for the key deterministic scenarios used by the spec:

- `test/fixtures/vite-healthy/probefn.config.ts`
- `test/fixtures/vite-overflow/probefn.config.ts`
- `test/fixtures/vite-token-drift/probefn.config.ts`
- `test/fixtures/vite-regression/probefn.config.ts`
- `test/fixtures/vite-console-error/probefn.config.ts`
- `test/fixtures/vite-auth/probefn.config.ts`

Each config uses only repository-relative paths and local fixture servers.

## Full Repo Verification

Before shipping changes, run:

```bash
pnpm test:vectors
pnpm turbo run test typecheck
```

Those commands verify the golden vectors plus the workspace package tests and typechecking from the repository root.

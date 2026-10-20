# CiFn

> Self-hosted CI/CD for the superfunctions ecosystem — like CircleCI or GitHub Actions, but you own it.

CiFn runs pipelines (build → test → deploy) on your own infrastructure, using the superfunctions ecosystem: **flowfn** for queues, **filefn** for artifacts, **secfn** for secrets, **logfn** for observability, **testfn** for tests, **hostfn** for deployments, and **plugfn** for webhooks.

## Components

| Component | Path | Description |
|---|---|---|
| Control Plane | `typescript/control-plane/` | HTTP API, pipeline parser, run store, job dispatch |
| Runner | `typescript/runner/` | Job executor, step handlers, log redaction |
| CLI | `typescript/cli/` | `cifn run`, `cifn status`, `cifn logs` |
| Dashboard | `typescript/dashboard/` | Web UI for run list, detail, logs, artifacts |
| Pipeline Schema | `schemas/` | JSON Schema for pipeline validation |

## Deployment

See [deploy/README.md](deploy/README.md) for full deployment instructions including:

- **Docker Compose** (local smoke test and production profiles)
- **hostfn** deployment with secfn-backed secrets
- Environment variable reference
- Runner registration
- Troubleshooting guide

### Quick Start

```bash
cd cifn/deploy
cp env.example .env
# Edit .env with your values
docker compose up --build
```

## Pipeline Example

```yaml
name: build-and-test
on:
  push:
    branches: [main]
  workflow_dispatch: {}
jobs:
  build:
    runs-on: default
    steps:
      - uses: checkout
      - run: npm ci
      - run: npm run build
      - uses: artifact/upload
        with:
          name: dist
          path: dist/
  test:
    runs-on: default
    needs: [build]
    steps:
      - uses: checkout
      - uses: testfn/run
        with:
          framework: vitest
          testPattern: "./tests/**/*.test.ts"
          reporter: json
  deploy:
    runs-on: hostfn-runner
    needs: [test]
    if: github.ref == 'refs/heads/main'
    steps:
      - uses: hostfn/deploy
        with:
          environment: production
          ci: true
```

## Specification

See [SPEC.md](SPEC.md) for the full technical specification.

## License

MIT

## Durable control-plane records (SQLite)

The control-plane server defaults to memory storage. To persist run/job/step state,
runner authentication, artifact references and encrypted log-redaction values,
set `CIFN_STORE_ADAPTER=sqlite`, `CIFN_SQLITE_PATH` to a persistent filesystem path,
and `CIFN_STORE_ENCRYPTION_KEY` to a canonical base64-encoded 32-byte deployment key.
`CIFN_STORE_NAMESPACE` is optional and defaults to `default`.
SQLite mode requires Node 20+ and the optional `better-sqlite3`/`kysely` packages.
Keep the key backed up separately; no key is generated or saved by CiFn, and an
invalid configuration fails startup rather than falling back to memory.

New runs atomically persist prepared jobs and dispatch intents with their records.
The built server republishes unclaimed intents after transport failure or restart;
duplicate messages can produce only one durable assignment. The remote shell
runner acknowledges claims, saves a private metadata journal, executes real shell
steps and reports idempotent completion. Completion atomically releases dependent
jobs. Started work without a saved result is never silently re-executed.

Run the built runner with `CIFN_CONTROL_PLANE_URL`, `CIFN_RUNNER_ID`,
`CIFN_RUNNER_SECRET` and a persistent `CIFN_RUNNER_STATE_DIR`. This remote path
supports shell steps; Docker and provider steps remain unsupported remotely.
Execution leases/reassignment, cancellation delivery, remote logs/artifacts and
durable notifications remain open. See the [remote execution contract](.conduct/remote-execution-readiness.md),
[dispatch contract](.conduct/durable-dispatch-readiness.md), and
[storage contract](.conduct/durable-storage-readiness.md) for validation and migration
requirements. These checkpoints do not establish full production readiness.


### Remote shell cancellation

With the durable SQLite control plane, `POST /api/v1/runs/:runId/cancel` is
observed by the remote runner during shell execution. The runner stops its owned
POSIX process group, escalates resistant descendants from SIGTERM to SIGKILL,
and reports a stopped receipt only after confirming the group is gone. Later
steps are skipped. Network outages do not count as cancellation; started work
without a durable result remains uncertain after a runner crash and is never
automatically replayed. See [cancellation contract and limits](.conduct/cancellation-readiness.md).

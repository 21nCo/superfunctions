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

New runs atomically persist prepared root-job dispatch intents with their records.
The built server republishes unclaimed intents after transport failure or restart;
duplicate messages can produce only one durable assignment. Already claimed jobs
are never silently reassigned. Remote completion, execution leases, dependency
scheduling and notification outboxes remain required before durable end-to-end
execution can be claimed. See the [dispatch contract](.conduct/durable-dispatch-readiness.md)
and [storage contract](.conduct/durable-storage-readiness.md) for validation,
migration and remaining requirements.

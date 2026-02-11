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

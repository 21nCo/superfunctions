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
durable notifications are described below; hosted email delivery remains unverified. See the [remote execution contract](.conduct/remote-execution-readiness.md),
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


### Durable webhook notifications

With SQLite storage, set `CIFN_NOTIFY_ON_RUN_COMPLETE=true` and
`CIFN_NOTIFICATION_WEBHOOK_URL` to opt in. Completion and cancellation-intent
events commit with the terminal run state and retry across restart using a stable
`Idempotency-Key`; receivers must deduplicate retries. Cancellation events do not
assert that subprocesses stopped. See the
[notification outbox contract](.conduct/notification-outbox-readiness.md).


### Durable SendFn email notifications

With SQLite storage, configure an existing SendFn instance's authenticated email endpoint:

```sh
CIFN_NOTIFY_ON_RUN_COMPLETE=true
CIFN_NOTIFICATION_EMAIL_TO=owner@example.com
CIFN_SENDFN_EMAIL_URL=https://send.example.com/email
CIFN_SENDFN_ADMIN_KEY=<SendFn admin key>
CIFN_SENDFN_USER_ID=ci-notifications
```

Choose email or `CIFN_NOTIFICATION_WEBHOOK_URL`, not both. CiFn posts the same
idempotency key on every attempt. A SendFn `pending` transaction remains pending;
`failed`, `bounced`, or `complained` requires reconciliation. Only a matching
`sent`/`delivered` transaction with a provider receipt is acknowledged. `sent`
means provider acceptance, not inbox delivery. Use a SendFn provider with durable
idempotency for safe recovery from ambiguous requests.

The endpoint, recipient, user and admin key are snapshotted in encrypted run
state. Configuration changes affect newly accepted runs; rotate old credentials
only after draining or reconciling existing intents. No automatic credential
migration or resend with a new identity occurs. See the
[email contract and validation limits](.conduct/email-notification-readiness.md).

### Remote shell secret snapshots

Newly accepted jobs capture referenced secrets once in encrypted prepared state.
Remote shell `${{ secrets.NAME }}` expressions use that acceptance-time snapshot,
including after restart or provider rotation. Missing secrets reject acceptance;
explicitly stored empty strings remain valid. Updated control planes and runners
should be deployed together. Historical jobs without named snapshots fail closed
for step expressions instead of fetching current values. Commands are source
substitution, not shell escaping: use environment variables for arbitrary data.
See [secret snapshot behavior and validation](.conduct/secret-snapshot-readiness.md)
for redaction, compatibility and remaining remote integration requirements.


### Live remote shell logs

Remote shell runners persist and send complete stdout/stderr lines while the step
is running. Each stream buffers split UTF-8 and incomplete lines; configured
literal secrets (including multiline components) are redacted before LogFn or
private-spool persistence. Interrupted trailing fragments are withheld and log
status records truncation. Output without a newline becomes visible after normal
step completion. Cross-stream arrival order is not a total ordering guarantee.

A single spool instance owns appends and acknowledgements during execution. A
250 ms timer attempts delivery without overlapping requests; network failures
retain packets for replay and do not turn shell success into log success. The
existing packet/job byte and event limits still apply. Finalization waits for
the active bounded request before sealing and reporting the execution result.
This is a polling interval, not a delivery-latency SLA.

Known literal redaction is not arbitrary secret discovery. A crashed runner
with uncertain execution ownership still requires reconciliation before automatic
spool recovery; pending status alone does not prove a running transfer. External
LogFn forwarding and the broader provider/deployment requirements remain open.
See [live log evidence](.conduct/live-log-readiness.md).

### TestFn dependency and module integration

CiFn uses the current TestFn core0.0.4 prerequisite and its tinyglobby discovery
implementation. Control-plane IDs use Node's cryptographic `randomUUID()`;
control-plane/runner no longer require the separate UUID package.

`executeTestFnRunAsync(options)` is the supported public helper in both CJS and
ESM consumers. The pipeline runner already awaits this path. The legacy
synchronous `executeTestFnRun` cannot synchronously complete framework execution;
it now returns an explicit failure before importing TestFn, changing directories,
or launching work. Migrate callers to `await executeTestFnRunAsync(...)`.

Install a maintained compatible test framework in the consumer project. Optional
framework versions have their own security posture; an audit of CiFn's default
production closure does not clear every historical peer version or the entire
monorepo development graph. See [dependency checkpoint evidence](.conduct/dependency-readiness.md) for exact
versions, audit scope and remaining original readiness requirements.

`executeTestFnRunAsync` resolves `workspace` once before asynchronous work and
passes it to TestFn's explicit `cwd` configuration. Concurrent calls for different
workspaces do not change the host process directory. Framework discovery, local
CLI selection and execution use that workspace; JSON report paths remain tied to
it even if unrelated host code changes cwd. This requires the accompanying
TestFn core0.0.4 workspace implementation. It does not sandbox test code or
isolate simultaneous writes into the same workspace.

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
supports shell and checkout steps. Image jobs require the explicit host-owned async Docker executor; other provider steps remain unsupported remotely. See the container lifecycle below for native evidence and remaining transport/recovery limits.
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

## Durable remote step status

Updated remote shell runners persist each step transition before sending it to the authenticated control-plane claim endpoint. Run details can show an earlier step as `success` while a later step is still `running`. A lost acknowledgement replays the same sequence and digest; control-plane updates are durable before acknowledgement. Step timestamps are control-plane acceptance times, including delayed delivery after an outage.

Each claim retains at most 200 step events (two per configured step) in a private, atomically written journal capped at 128 KiB. Transport failure retains events; local persistence failure or an authenticated protocol conflict stops further execution without fabricating a terminal result. Whole-job completion waits for its pending step events. Restart readers can replay events without changing execution ownership or rerunning a shell.

Deploy the updated control plane before updated runners: an older server lacking the step endpoint cannot support this protocol. Stop/drain old writers when relying on the new guarantees; old runners can still report aggregate completion without intermediate events. No new database schema is required: event receipts live in the existing encrypted, revision-controlled run record.

Cancellation remains terminal. Previously accepted duplicate events are acknowledged, but new events arriving after cancellation or completion are rejected and retained locally. A `running` step records admitted execution intent, not proof that a process is currently alive. Unknown execution results still require reconciliation. Per-claim journal bounds are not an aggregate runner-disk retention policy; claim/history cleanup remains a separate operational requirement. The Python SDK already consumes these step states through its existing `Run`/`Step` models; it is not a remote executor.

See [.conduct/step-status-readiness.md](.conduct/step-status-readiness.md) for the acceptance evidence and remaining scope.

### Durable control-plane lifecycle events

SQLite storage records new run creation and subsequent run/job/step status changes
atomically with the state change. Runner registration and accepted heartbeats are
recorded with the runner update. API errors and pipeline validation failures are
committed to a namespace error ledger before the error response is returned. Only
allowlisted codes, route templates, method and status are retained, never raw
paths, query strings, headers, bodies or parser/provider messages. To deliver these events through LogFn's console
sink in the built server, set `CIFN_LIFECYCLE_LOGS=console` (default `off`). This
requires `CIFN_STORE_ADAPTER=sqlite`. Existing job-log HTTP queries continue reading
CiFn's durable log storage; LogFn is a logger/sink library, not an HTTP query server.

Programmatic hosts can construct `LogFnLifecycleDispatcher(store, sink)` with an
actual `@logfn/core` `Sink`, call `tick(cursor)` and carry the returned cursor until
it wraps, then repeat. Each tick scans at most ten stored owners and admits one event per
run, runner or namespace error owner. Reset saved dispatch cursors on upgrade. Call `close()` to stop admission and join in-flight sink work. A sink must
provide its own I/O deadline; arbitrary sinks cannot be forcibly cancelled.

Events carry stable `ctx.eventId` values. A delivered receipt means the sink and
its flush resolved, not that an external service durably stored the event. Any
sink failure, expired claim or missing crash-time receipt parks the event as
`unknown`; later events in that owner wait. Inspect `getLifecycleRecords(runId)` and
use privileged `reconcileLifecycle(runId, eventId, 'delivered' | 'retry', now)` only
after investigating. Explicit retry can duplicate an already accepted effect.

Hosts must maintain retention using `pruneLifecycle(runId, completedBefore, limit)`
(`limit` at most 100). Only delivered records older than the supplied cutoff are
removed; unknown/pending/in-flight records stay pinned and sequence IDs never
reset. At 25,000 retained records or 8 MiB per run (including reserved receipt metadata), a new lifecycle-producing state
transition rejects until maintenance frees capacity. These bounds also apply per runner and to the namespace error ledger.
The latter additionally accepts `CIFN_API_TELEMETRY_MAX_EVENTS` (integer 1–25,000,
default 25,000); the chosen value is persisted and mismatched reopen configuration
fails. Pipeline validation failure admits its parse and API records atomically.
At capacity, required API error telemetry cannot be admitted, so the response is
sanitized `503 UNAVAILABLE`; successful API requests remain available. Heartbeat
admission fails if its runner ledger is full, so schedule dispatch and maintenance.
Aggregate database/runner/run-history capacity remains a deployment responsibility.

Use typed owners `{kind:'runner', id:runnerId}` or `{kind:'api', id:'errors'}` with
`getTelemetryRecords`, `reconcileTelemetry`, and `pruneTelemetry`; the existing
run-only methods remain available. These privileged methods are not public HTTP
routes. Runner HTTP/storage projections never expose delivery claims or receipts.
The built Node server also records bounded-body failures before they reach routing,
using the fixed `unmatched` route. Custom Node hosts should pass their durable store
as the optional second argument to the internal transport factory when using it;
other transports must admit their own pre-router failures. Memory storage retains
its existing development-only behavior without a durable telemetry guarantee.

Drain older control-plane writers before relying on lifecycle coverage. Existing
runs are not retroactively backfilled: only subsequent committed transitions are
recorded. Apply the owned `cifn_state_telemetry(namespace,id)` index before using
custom database adapters (built-in SQLite creates it on open). The bounded owner
scan uses this index; no automatic historical backfill or retention scheduler is
provided. Remote
step output already uses the real LogFn pipeline and its private durable sink;
configurable external forwarding of that output remains separate unfinished work.

### Forwarding admitted step output through LogFn

`CIFN_STEP_OUTPUT_LOGS=console` enables the built SQLite server's actual LogFn
console sink for admitted, redacted stdout/stderr lines (default `off`). This is
independent of `CIFN_LIFECYCLE_LOGS`. No standalone LogFn HTTP query server is
assumed. Programmatic hosts may use `LogFnStepOutputDispatcher(store, sink)` with
an actual `@logfn/core` sink, traverse `tick(cursor)` pages and call `close()` to
join admitted I/O. Each page considers at most ten runs and claims at most one
line per run. A host must keep traversing/wrapping pages for progress.

Delivery retains one compact checkpoint per job log ledger: a delivered prefix
and at most one in-flight or unknown claim. No extra copy of log output is stored.
The stable `ctx.eventId` identifies the run/dispatch/line ordinal; output context
contains the redacted job key and fixed step key, never runner credentials or raw
claim tokens. The delivered prefix cannot be pruned independently of the payload:
that would permit replay. Its fixed size is the receipt compaction policy. Global
run/database history retention remains host-owned; there is no hidden automatic
removal of unresolved claims.

A delivered receipt means the sink and flush resolved. Sink errors, lost receipts
or expired leases park `unknown`, blocking subsequent lines in that job. Inspect
`getStepOutputStatus(runId, dispatchId)` and use privileged
`reconcileStepOutput(runId, dispatchId, eventId, 'delivered' | 'retry' | 'undelivered', now)`
after investigation. Explicit retry may duplicate an accepted effect; `undelivered`
is valid only after payload expiry. These are host APIs, not public HTTP routes.

All existing log expiry paths still remove the bytes. A constant-sized tombstone
retains delivered/expired-undelivered counts and any unresolved event identity.
Expired output cannot be retried (`retry` returns false); ambiguity must be
explicitly resolved. Historical payloads expired before this upgrade report
`historicalCountUnavailable`, rather than inventing delivery counts. Drain old
writers before upgrade; existing unexpired packets are eligible, without historical
sink claims. No shell status is inferred and no command is rerun.

The dispatcher rejects new sink invocation after claim/payload expiry. Already
started arbitrary sink I/O cannot be forcibly cancelled: hosts must supply bounded
transports, and `close()` waits for their settlement. Storage payload expiry does
not revoke bytes already handed to a sink or an in-flight caller. API log reads
continue using CiFn's authoritative durable ledger, separately from sink receipts.

### Explicit execution adjudication

A `.started` marker, stale heartbeat or missing completion receipt does not prove
that a shell stopped. Automatic recovery still refuses to rerun that execution.
Trusted hosts can call `inspectExecution(runId, dispatchId)` to obtain the current
execution identity, redacted job/step state and a relevant-state fingerprint,
without the claim token, script, environment or secret list.

After independently establishing that the owner stopped and deciding the actual
result, a privileged operator can call `adjudicateExecution` with:

- The exact `executionId` and `expectedFingerprint` from inspection.
- An opaque `decisionId`, `actorId`, and explicit `ownerStopped: true`.
- `evidence: {kind, referenceId, digest, observedAt}`: a fixed evidence category,
  bounded opaque reference, SHA-256 digest and epoch-millisecond observation time.
- `action: 'complete'` and the exact terminal job/step `result`, or
  `action: 'cancel-stopped'` only for an already cancelled run.

Evidence categories are `observed-owner-exit`, `durable-exit-receipt` and
`operator-investigation`. The package does not fetch evidence or verify a digest
against an external process supervisor. This is an explicit trusted operator
assertion, not autonomous execution recovery. No process is killed, reassigned or
rerun by either API. No operator HTTP endpoint is exposed; the host must enforce
its own operator authorization before invoking this privileged library API.

The immutable encrypted receipt, completion, dependent-job transitions,
notifications and lifecycle records commit together. Exact decision replay is
idempotent. A different actor/evidence/result, changed owner or relevant execution
state, or a conflicting terminal/cancellation transition rejects. Unrelated log
replay and heartbeat updates do not invalidate the fingerprint. A later matching
runner completion remains idempotent; a divergent result rejects.

Cancellation acknowledgement records stopped ownership without changing the
cancelled run or inventing terminal step results. One bounded receipt is retained
per dispatch; arbitrary notes, evidence bodies and URLs are not accepted. Known
configured secrets in attribution fields reject. Run history retention remains
host-owned. Drain older writers before relying on adjudication receipts; no
retroactive fencing of old binaries or rewriting of local runner evidence occurs.


### Supervised remote checkout

Remote `uses: checkout` runs Git through the same owned POSIX process supervisor as shell steps, with awaited durable step transitions. Repository and ref/token expressions use the accepted secret snapshot. Explicit `with.ref` takes precedence, otherwise the trigger SHA is preferred over its ref (then pipeline ref); `HEAD` is used when neither is present. Set an explicit ref when overriding the repository to a different project. Fetch supports full commit IDs, branches, tags and `HEAD`; the resulting workspace is a detached checkout. Submodules and Git LFS content are not initialized.

An exact safe `owner/repository` shorthand is normalized to GitHub HTTPS. Network checkout accepts HTTPS URLs without embedded credentials, query strings or fragments. SSH, Git helper/ext transports and redirect-following are disabled in this checkpoint. Local absolute repository paths require the trusted library host option `allowLocalRepositories: true` on `RemoteRunner`/`Runner` (or the final policy argument to `executeRemoteShellJob`); pipeline data cannot enable it. The built runner leaves local access disabled.

Git runs with an isolated HOME/config, disabled credential helpers and hooks, and no inherited Git configuration/SSH agent. An optional token is passed only in the owned Git process environment to a private askpass helper. No token enters Git argv, repository URLs, persistent remote configuration or diagnostics. Checkout reports sanitized success/failure lines instead of raw Git output. The workspace must not already contain `.git`. The public synchronous `executeCheckout` API retains its return type and now uses argv calls; remote execution uses the exported asynchronous `executeOwnedCheckout` path.

Checkout has a 120-second operation budget, bounded captured output and owned process-group termination on cancellation. Termination verification adds the existing grace/kill/stdio cleanup bounds. If process disappearance cannot be established, execution remains uncertain: the private workspace/helper location is retained and no completion or replay is invented. A surviving process can still retain its environment; this is not a hard credential-erasure or OS sandbox guarantee. Normal completion/cancellation removes helper files. Workspace/repository bytes are not physically quota-bound by the output cap, and HTTPS provider acceptance, SSH, submodules and LFS remain open requirements where applicable.


### Bounded repository pipeline resolution

The exported `resolvePipelineDoc(pipelineRef, options)` uses the same supervised Git implementation as remote checkout. It accepts SHA/branch/tag/HEAD and searches `.ci/pipeline.yml`, `.ci/pipeline.yaml`, `cifn.yml`, then `cifn.yaml`, unless `configPath` is supplied. Each document is at most 500KiB of UTF-8 bytes. Explicit paths must be relative without traversal; realpath containment and a regular-file read reject escaping symlinks/directories. Internal symlinks remain supported. Reads are bounded even if a file grows after its metadata check.

Trusted options include `signal`, `token` and `allowLocalRepositories` (default false). Normal completion/cancellation removes private resolver workspaces; uncertain process-group termination retains them for host reconciliation. The same public `ProcessGroupUncertainError` is used by the lower-level control-plane helper and runner wrappers. Git remains an owned local tool, not a filesystem sandbox or disk quota. Custom `fetcher` callbacks remain host-owned I/O: their returned documents obey the byte cap and cancelled results reject, but arbitrary callbacks are not forcibly cancelled.

Hosts can inject `ref => resolvePipelineDoc(ref, trustedOptions)` as `createApp({pipelineResolver})`. The built server does not yet configure this resolver automatically; webhook normalization/branch gating and explicit built-server resolver policy remain the next integration slice. This helper checkpoint alone does not establish signed webhook-to-checkout readiness.

### GitHub webhook admission and repository resolution

The GitHub webhook validates its signature before processing event identity. Branch pushes require a nonzero 40-character commit SHA; tag pushes and deleted refs are acknowledged as skipped. Same-repository pull requests support `opened`, `reopened` and `synchronize`; other actions are acknowledged as skipped. PR base/head repository IDs and names must agree with the signed repository identity. Fork PRs without a matching trusted host approval return 403 before config resolution; the exact-code approval contract is described below.

Both pipeline config and default checkout use the accepted immutable commit SHA. PR branch filters apply to the base branch, while `github.ref` names the head branch and `github.sha` is the head SHA. `github.repository` remains the repository name; default checkout uses the accepted pipeline repository URL. Explicit checkout `with.repository` / `with.ref` still override defaults. `on.push` / `on.pull_request` must be present to admit that event. Their optional `branches` arrays match exact branch names: omitted permits all branches, empty permits none. Glob/negation syntax is not implemented. Filtered events return 200 with `data.skipped: true`, without resolving job secrets, persisting a run or dispatching jobs. Config resolution necessarily precedes pipeline filter evaluation.

The built control server defaults to `CIFN_PIPELINE_RESOLVER=off`; set it to `git` to enable the supervised resolver. It reads optional trusted `CIFN_GIT_TOKEN` from the configured secrets adapter for repository access. `CIFN_ALLOW_LOCAL_REPOSITORIES=true` is a separate trusted host policy for local repositories (default `false`); it is never inferred from webhook input. HTTPS credentials, Git isolation and cancellation limits follow the checkout/resolver contracts above. Server shutdown signals active resolver subprocesses to stop. Arbitrary secrets-adapter calls are not forcibly cancelled. Webhook retries are not delivery-ID deduplicated by this slice; same-repository support and explicit trusted-code fork approval do not establish untrusted-fork sandbox readiness or live GitHub App/PlugFn integration.


### Explicit trusted fork commits

`createApp({forkApprovals})` accepts at most 100 host-owned `ForkApproval` records. Each binds an approval ID; base and head repository numeric IDs, names and credential-free URLs; exact lowercase 40-character base/head commit SHAs; and an optional `allowedSecrets` list (default empty). The app validates and snapshots this policy at construction. Webhook payload fields cannot grant approval. The built server accepts the same array as `CIFN_FORK_APPROVALS` JSON, capped at 64 KiB; changing it requires restarting the server. Missing or mismatched policy denies the fork before config resolution or repository-credential lookup. Changed base/head SHAs invalidate an approval.

For approved forks, configuration is read from the approved **base** SHA, and default checkout uses the approved **head** repository and SHA. `trigger.payload.cifnAdmission` records distinct configuration/execution references and the approval snapshot; webhook-supplied provenance is overwritten. The accepted snapshot persists through dispatch/restart. Revoking host policy affects future admissions, not already accepted runs; cancel those separately when needed.

After validating the trusted base config and branch filter, all discovered secret names must appear in `allowedSecrets` before any job-secret read. Approval explicitly trusts that exact fork code with those secrets. A trusted pipeline may still override checkout or execute arbitrary commands. This is **not an untrusted-code sandbox**: the runner's host permissions, filesystem/network access, arbitrary external effects and inherited process environment still require independent isolation. Broad untrusted-fork execution and private-fork credential isolation remain incomplete. No live private-provider behavior is established by local fixtures.

### Container-required jobs

A local `Runner` with `job.image`, `dockerForDefault`, or a selected Docker label must have a configured container executor. If it does not, the step fails without invoking the host shell or host `runCommand` callback. An explicitly empty image declaration also cannot silently select the host. Image-free jobs without container policy retain host behavior.

This admission check does not complete the Docker execution contract. The current legacy `DockerExecutor` is synchronous and does not prove cancellation or removal of an owned container after CLI failure; its environment argument handling is also not suitable for secret-bearing production execution. The async executor described below is a separate opt-in path. Native runtime evidence and remaining recovery/isolation limits are documented below; this is not a full readiness claim.


### Owned container lifecycle

`OwnedDockerExecutor({ stateDirectory, context, timeoutMs? })` can be passed as `ownedDockerExecutor` to `Runner` or `RemoteRunner`. `Runner.executionOwner` supplies a host identity; RemoteRunner supplies the durable run/dispatch/execution/runner identity without its claim credential. The built server opts in only when the host sets `CIFN_DOCKER_CONTEXT`; receipts live under `CIFN_RUNNER_STATE_DIR/containers`. Image jobs remain denied without the option. The old synchronous `DockerExecutor` is compatibility-only and is not used by this remote path.

Runner opens **one container per job**, lazily at its first admitted run step. The canonical workspace is mounted at `/workspace`; the image must already be cached and contain `/bin/sh`. The container filesystem and background processes persist across steps, including a known nonzero exit followed by an `always()` step. Job cleanup removes the verified owned container before releasing the workspace or completing the job. This does not isolate host checkout or other provider steps.

The per-job path requires a host-selected local Unix-socket Docker context; TCP/SSH transports fail closed before container creation. It uses Engine exec-create/start/inspect: each daemon exec ID is durably recorded before starting its command, and authoritative ID/container/running/exit-code fields are checked afterward. An attach/inspect error stops admission and removes the whole container before reporting infrastructure failure and skipping later steps (including `always()`). If removal cannot be confirmed, it retains the private receipt/workspace and propagates the existing uncertain-execution outcome instead of inventing completion. A CLI exit alone is never used as proof of exec completion.

Private fsynced receipts record unique container ownership, context/daemon identity, canonical workspace and active/last exec identity. State must resolve outside the workspace mount. Per-job commands/environment travel in bounded local Engine request bodies, never process argv or receipt payloads; multiline environment values are supported. Environment names must be shell names, with at most 256 entries and 256 KiB JSON environment, plus a separate 256 KiB command cap. The privileged daemon/container can inspect their environment; deletion is not credential erasure.

The public `execute()` helper remains a standalone single-step CLI lifecycle. Its environment uses a mode-0600 file outside the mount, with single-line values; the interpolated command travels only in the owned CLI environment. Ambiguous creation may retain that private file. Runner's per-job path uses `openJob()`/`execute()`/`close()` sessions instead. Both paths check daemon/container ownership and confirmed absence before deleting evidence. There is no automatic stale-PID kill, shell replay or historical receipt deletion.

Engine JSON operations have a 10-second request deadline; exec streaming defaults to 300 seconds (host-configurable 1 ms–1 hour), with bounded output and separate cleanup operations. These are not a single whole-job wall-clock limit. Existing server shutdown waits for its current tick. Enforced hostile-code resource/network/nonroot isolation, durable receipt quota/maintenance and automatic crash reconciliation remain open requirements.

Actual cached-image acceptance is reproducible without external pulls:

```sh
CIFN_DOCKER_CONTEXT=owned-context CIFN_DOCKER_IMAGE=already-cached-image \
  node cifn/typescript/runner/scripts/verify-per-job-docker.mjs
```

The fixture exercises persistent container/workspace state, known failure with an `always()` successor, multiline environment, active cancellation, and a killed owner whose retained exec receipt is checked against the still-running container. Its last cleanup is explicitly performed by the fixture after observing its own child exit; it does not establish an automatic product recovery API. Cleanup uncertainty retains evidence. Native success cases do not establish every daemon-loss/host-crash scenario or hostile-fork isolation.

### Host-only retained container cleanup

After the host has independently established that the original execution owner is stopped, it can inspect and clean an exact retained **version-2 per-job** receipt:

```ts
const snapshot = executor.inspectReceipt(receiptId);
const result = await executor.cleanupReceipt({
  id: snapshot.id,
  fingerprint: snapshot.fingerprint,
  owner: snapshot.owner,
  operatorId: 'operations-incident-123',
  stoppedOwner: true,
});
// result.containerRemoved === true; result.executionOutcome === 'unknown'
```

This is a trusted host API, with no HTTP route. `stoppedOwner` is an explicit operator attestation, not a PID/heartbeat inference or an assertion the library can independently prove. Stop every original writer before using it. The exact fingerprint fences a changed receipt, and a durable exclusive lock serializes cooperating cleanup callers. It does not sandbox a hostile local filesystem writer or fence an old execution owner that ignores the attestation.

Inspection reads one exact UUID directory and at most 16 KiB from a private regular receipt file, rejecting symlinks, unsupported versions and malformed identity. It exposes no command/environment or workspace path. There is no unbounded inventory scan. Cleanup requires the expected context/daemon and container ownership label, then proves both container ID and name absent. A missing container is sufficient only for cleanup, never for knowing the original command's result. An incomplete create receipt without a container ID remains parked.

The original receipt and a separate immutable `cleanup.json` remain retained. Exact decision replay returns that terminal receipt without another daemon request; a different operator/decision rejects. Cleanup never deletes the workspace, executes steps, changes claim status, or supplies a completion result. Use the separate control-plane adjudication contract only with its required evidence.

Interrupted or uncertain cleanup retains `cleanup.lock`; subsequent calls fail closed rather than stealing it by age/PID. Offline lock repair must establish that its actual owner has stopped and inspect the state first. No public automatic stale-lock recovery, inventory pagination, terminal pruning or total disk quota is provided. These operational limits remain explicit; the original dated requirements do not prescribe a particular receipt TTL or mandate autonomous recovery. The native fixture separately demonstrates killed cleanup-owner lock retention and uses explicit fixture-only offline repair before exercising public cleanup and reopen replay.

### Artifact and cache workspace archives

The local artifact upload/download and cache save/restore helpers share the existing four-byte manifest-length + JSON manifest + file-bytes format. Valid legacy archives still round-trip. Upload paths and extraction entries must be relative POSIX paths: absolute paths, `..`/`.` components, empty components, NUL, backslash and colon are rejected. `.` or an empty selected upload root means the workspace itself. Artifact directories extract relative to the selected directory; single artifact files and cache files keep their workspace-relative path. Overlapping cache selections are deduplicated.

Before any extraction write, the complete manifest, contiguous integer byte ranges, UTF-8, destination paths, duplicate case/NFC file aliases and file/directory prefix conflicts are validated. Existing symlink parents, dangling/final symlinks, hardlinked files and nonregular files reject. Reads are bounded through no-follow descriptors. New output files use exclusive create; existing outputs open without truncation, then regular-file/link checks precede truncation. Zero-progress writes fail. Unexpected provider/filesystem error text is not reflected in returned logs.

`Runner({ archiveLimits })` and the four public helper option objects accept trusted host limits:

| Field | Default | Supported maximum |
| --- | --- | --- |
| `maxBytes` | 64 MiB for the complete encoded archive | 1 GiB |
| `maxManifestBytes` | 1 MiB | 16 MiB |
| `maxEntries` | 10,000 visited source entries / distinct destination files and parent directories | 100,000 |
| `maxDepth` | 64 path components | 256 |

Values must be positive safe integers; path text is at most 4096 UTF-8 bytes. These are explicit implementation resource policies, not numeric limits invented as original specification requirements. A host can tighten or raise them within the supported bounds; downstream FileFn limits still apply. Existing larger archives may require explicit configuration.

This path requires POSIX no-follow file operations and fails closed on Windows; case/NFC collision checks do not claim Windows reparse/filename compatibility. The host must exclude concurrent hostile workspace writers, including background processes started by job commands. Path checks and file descriptors defend against static malicious archives/preexisting links; they are not an OS sandbox against parent-directory replacement races. A filesystem failure during otherwise valid extraction can leave partial in-workspace output; whole-archive transactional rollback is not promised. The current provider interface returns a Buffer, so these archive caps do not bound provider-side network buffering before the helper receives that Buffer.

Remote FileFn upload/download/reference acknowledgement and cache integration remain required work: the remote executor still rejects these provider steps, and the existing FileFn HTTP adapter's key lookup/list implementation is incomplete. The archive helper checkpoint does not establish production FileFn interoperability.

### Local HostFn process execution

The local `Runner` executes `hostfn/deploy` with supervised argument-vector execution, streams redacted output, and forwards cancellation and its deadline to the owned process group. It always supplies `--ci` (even for a pipeline containing `ci: false`); `hostfn-runner` defaults to `--local` unless the existing explicit local option overrides it. Environment names follow `--` as one literal argument, never a shell command. HostFn itself validates supported names.

`RunnerOptions.hostFnExecutable` is an optional absolute executable path supplied by the trusted host; otherwise the executable is resolved from absolute host PATH directories. Job environment variables cannot select that executable. `hostFnTimeoutMs` defaults to ten minutes and accepts integers from 1 ms through one hour. The managed base environment defaults to PATH/LANG/TMPDIR plus admitted job environment; the host can configure `executionEnv`. These controls are not an untrusted-code sandbox or proof of deployment outcome.

The exported `executeHostFnDeployAsync` uses the same supervisor. Its `baseEnv`, `executable`, and redaction policy are trusted host settings. Without an explicit redaction policy, nonempty supplied environment values are redacted. A throwing output callback aborts execution and cannot produce success. Unproven group termination propagates `ProcessGroupUncertainError`; the Runner retains its workspace. Cancellation prevents subsequent steps, including `always()` steps.

The existing synchronous `executeHostFnDeploy` keeps literal argv and its optional `ci` flag. It inherits the host environment for compatibility and provides no asynchronous process-group cleanup guarantee. Timeout, capture overflow, or signal termination throws `ProcessGroupUncertainError`; the managed Runner does not use this path. The remote durable executor still rejects HostFn steps: remote integration, deployment receipts, and live provider acceptance remain open.

### Scheduled pipelines

The built control-plane server accepts trusted host configuration in `CIFN_CRON_PIPELINES`: a JSON array of `{id, spec, pipelineRef, cronExpression}`. Each expression must also appear in that pipeline's `on.schedule` array. Startup admits at most 100 registrations and 500 KiB of configuration; IDs must be unique. Expressions have five fields and are evaluated in UTC by the actual `@flowfn/core` Scheduler and its cron parser, rather than a fixed execution interval. Pipeline credentials should remain secret references, not literal values in this host configuration.

```json
[{"id":"nightly","pipelineRef":{"repo":"owner/repository","ref":"main"},"cronExpression":"0 2 * * *","spec":{"on":{"schedule":[{"cron":"0 2 * * *"}]},"jobs":{"build":{"runs-on":"default","steps":[{"run":"npm test"}]}}}}]
```

`CronScheduler.start()` returns a promise and repeated starts share the same owner. Register before starting; stop before modifying registrations. `await scheduler.stop()` prevents new scheduled admission and drains active work before closing its Flow scheduler. A shutdown timeout retains the stop fence and reports uncertain ownership. The server waits for that drain before closing storage. The legacy `start(intervalMs)` argument is accepted for source compatibility but cannot override the expression.

This integration has one scheduler owner per process. Restart schedules strictly future occurrences; missed occurrences are not backfilled. Concurrent control-plane processes must not register the same schedules: durable occurrence deduplication, distributed schedule ownership and crash reconciliation of ambiguous admission are not implemented here. Failed admission is recorded as a sanitized scheduler error and the next occurrence remains eligible; the failed occurrence is not blindly replayed. Committed run/job dispatch still uses the existing durable store and publisher. This does not claim the entire original FlowFn integration is complete.

# CiFn durable remote shell execution checkpoint

2026-10-20. Adds a functioning remote shell runner to the durable control plane.
It supersedes the root-only/no-completion limits in the earlier dispatch
checkpoint for newly prepared runs. Production readiness remains incomplete.

## Protocol and durable state

All jobs now have an encrypted prepared payload captured at run acceptance.
Root intents start ready; dependent intents start blocked. Their environment and
secret snapshot is retained rather than reconstructed or re-resolved when a
predecessor completes.

The existing authenticated heartbeat offers a durable claim. Three bounded JSON
endpoints use the registered runner secret, not an application API key:

- `POST /api/v1/runners/claims/resume`: `runnerId`, optional pagination cursor.
  Returns only that runner's outstanding claims and their prepared payloads.
- `POST /api/v1/runners/claims/ack`: `runnerId`, `runId`, `dispatchId`,
  `claimToken`, `executionId`. CAS binds an execution identity before work starts.
  Repeating the same acknowledgement is safe; competing identities conflict.
- `POST /api/v1/runners/claims/complete`: the same identity plus `result` with a
  terminal job status and the exact ordered step keys/terminal statuses.

Completion requires the runner binding, claim token and acknowledged execution
identity. Invalid authentication returns 401, malformed shape 400, stale or
conflicting identity/result 409, and a storage failure 503. Server-observed
completion timestamps are assigned internally. A canonical result digest makes
identical retries return the same `{accepted:true}` receipt without applying a
second transition; a conflicting result is rejected.

One run-row CAS commits completion, step/job statuses, dependent-intent promotion
and the resulting run status. An already ready/claimed/completed intent cannot
be scheduled again. Concurrent parent completions can release a join only once.
Failed dependencies skip blocked descendants; independent branches may finish.
A run becomes terminal only when all jobs are terminal. Cancelled runs reject
new execution acknowledgements and completions that were not already committed.
Notifications are not made durable by this transition.

The payload's `dispatchProtocolVersion:2` marks fully prepared runs. Earlier
record-only or root-only payloads remain readable but are not automatically
published/claimed by this execution protocol. Old claims without protocol
metadata are reconciliation-only. There is no automatic migration or unsafe
secret re-resolution for historical records; reconcile them explicitly before
creating replacement work.

## Runner lifecycle and secret handling

The built runner requires `CIFN_CONTROL_PLANE_URL`, `CIFN_RUNNER_ID`,
`CIFN_RUNNER_SECRET` and an explicit persistent `CIFN_RUNNER_STATE_DIR`.
`CIFN_POLL_INTERVAL_MS` defaults to 1000 (minimum 10). The control plane must use
the durable SQLite store for these endpoints. MemoryStore remains available for
local execution, not remote durability.

The runner reuses the existing Runner and shell executor with an ephemeral
per-job projection. That projection drives actual subprocess execution and
collects results; it is not the durable authority. Only shell `run` steps are
supported by this remote checkpoint. Image/container jobs and provider `uses`
steps fail explicitly. Existing local execution/provider paths remain available
and separately tested.

Before acknowledging a claim, the runner saves only identity/execution metadata
in its journal. It fsyncs an exclusive started marker before invoking the shell,
then durably saves terminal statuses before sending completion. Journal files
use mode 0600, the directory mode 0700, atomic replacement and directory fsync.
The journal contains no raw job environment, commands, log output, provider
credentials or runner secret. It retains scoped claim/execution tokens and
terminal statuses. Resume re-fetches payloads through runner authentication.

On restart:

- Unacknowledged offers and prepared journal entries may be resumed.
- A saved completed result is resent, never re-executed. A permanent conflict or
  invalid result is retained in reconciliation state without blocking later jobs.
- A started marker without a saved result is uncertain. The runner emits a
  generic reconciliation diagnostic and refuses automatic re-execution.
- An execution acknowledged elsewhere cannot be adopted with a new identity.

The exclusive started marker also prevents two local processes using one journal
from spawning the same execution. This protects against duplicate execution
caused by protocol/journal retries; it does not claim exactly-once external side
effects or recover an unknown result after a process/host loss.

Full-job logging was removed. Shell jobs receive prepared job variables plus a
small base environment (PATH/LANG/TMPDIR), not the runner's control-plane
credentials. Results saved/reported by this path contain statuses only, so raw
stdout/stderr and secret values cannot enter the journal. Existing executor
redaction is retained for its in-memory logs. This is not an OS/container sandbox.

## Validation

Real SQLite protocol tests exercise owner/runner/token binding, acknowledgement
retries, competing execution owners, wrong step results, duplicate/conflicting
completion, cancelled execution, prepared-secret preservation across reopen,
and parallel-parent join promotion. A native SQLite trigger rejects completion:
no partial result or downstream promotion is committed, and a later retry works.

`verify-remote-execution.mjs` starts the built control plane and runner as separate
processes. A real shell build writes a witness file, followed by a dependent test.
It loses the initial offer, resumes it, drops a successfully committed completion
response, kills the control plane with SIGKILL, and restarts on the same SQLite
file. The saved result is retried and the dependent job executes once. It checks
final step/job state after another reopen, rejects a forged completion token,
and verifies witness contents rather than inferring execution from records.

The probe then kills the runner process group after a real shell side effect but
before result persistence. Restart with the same journal leaves the job uncertain
and does not repeat the side effect. It checks private journal modes and scans
journal/process output for fixture secrets. Child processes, SQLite files,
journals and witness files are removed afterward.

Reproduce after installing the control-plane, runner and existing TestFn workspace
closure and building shared DB dependencies:

```sh
npm test --workspace=./cifn/typescript/control-plane
npm test --workspace=./cifn/typescript/runner
npm run lint --workspace=./cifn/typescript/control-plane
npm run lint --workspace=./cifn/typescript/runner
npm run test:remote --workspace=./cifn/typescript/runner
npm run test:remote --workspace=./cifn/typescript/control-plane
```

Validation: 169 control-plane tests and 75 runner tests, package typechecks,
strict durable/remote configurations with `skipLibCheck:false`, both package
builds, and the real two-process acceptance probe pass. Existing built startup,
SQLite dispatch restart and CJS/ESM control-plane consumer probes also pass.

Validation is local Node 20.20.0/native SQLite evidence. The existing runner suite
also exercises local executor paths; it is not evidence that provider steps are
supported remotely.

## Remaining original gates

Execution lease expiry/renewal, explicit operator reconciliation/reassignment,
crash recovery after an unknown subprocess result, durable notification delivery,
remote step/log streaming, artifact/cache/checkout/TestFn/HostFn/Docker provider
integration, and step-level secret expressions remain open. Remote shell jobs
with unsupported providers fail rather than claiming success. Cancellation does
not terminate a running subprocess. Completion is reported per job, so step
progress before terminal completion is not durably streamed.

Journal retention/backup and filesystem portability, installed tarball/runtime
matrices, live FlowFn/SecFn/FileFn/LogFn/SendFn acceptance, distributed load and
performance targets, production deployment, Python/CLI/dashboard parity and the
remaining original specification requirements are not completed by this slice.

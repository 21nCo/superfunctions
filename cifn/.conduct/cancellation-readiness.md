# CiFn remote shell cancellation checkpoint

2026-10-20. Extends the remote execution checkpoint without changing the original
production-readiness requirements. No shared packages or dependencies changed.

## Contract

The application-authenticated run cancellation endpoint still commits
`run.status=cancelled`. That commit is cancellation intent, not proof that work
has stopped. New bounded JSON runner endpoints use the registered runner secret
and the complete `{runnerId,runId,dispatchId,claimToken,executionId}` identity:

- `POST /api/v1/runners/claims/status` returns only `cancelRequested`, `completed`
  and `stopped`. It checks the claim owner/token and, once bound, execution ID.
- `POST /api/v1/runners/claims/stopped` CAS-records a server timestamp on a
  cancelled claim. Repeating the same receipt is safe; another execution identity
  or a completed claim conflicts. No environment or secret payload is returned.

Before acknowledgement and before creating the started marker, the runner
checks cancellation. Even cancellation before execution must win the exclusive
started marker before reporting stopped, so a second process sharing a journal
cannot claim that an execution owned by the first process never started. A
cancellation racing acknowledgement is observed after
the acknowledgement conflict. During execution it polls once per second, with
at most one status request in flight and a ten-second request timeout. A failed
request is not cancellation; during an outage work may continue to its existing
five-minute command timeout. There is no guaranteed one-second cancellation SLA.

Each remote shell command runs in an owned POSIX process group with asynchronous
output capture capped at 1 MiB. Cancellation sends SIGTERM, allows one second,
then sends SIGKILL if the group remains. The runner checks group disappearance
for up to five more seconds. Shell exit or closed stdio alone is insufficient.
A remaining or inaccessible group causes uncertain execution, not a stopped
receipt. The same cleanup handles timeout, output overflow, and background
children left behind when a shell exits. A command leaving background children
is considered failed. Group signalling uses only the currently spawned child's
identity; no PID is read from a journal. Later steps check the abort signal and
do not execute after observed cancellation.

Once its owned group has disappeared, the runner durably writes a `cancelled`
journal phase before reporting stopped. A lost response is retried after journal
reopen without execution. Run cancellation and successful completion use the
same run-row CAS: whichever commits first determines acceptance. A completion
receipt committed before cancellation remains replayable, including when another
job in the same run is subsequently cancelled. Cancellation metadata does not
invent new job/step enum values; the cancelled run retains its last durable job
snapshot and the claim stores the stopped receipt.

## Evidence

- Native SQLite close/reopen tests cover runner/token/execution binding, cancel
  before acknowledgement, idempotent stopped receipts, completion/cancel races,
  and replay of a previously committed result after run cancellation.
- Runner tests cover cancellation before acknowledgement, racing acknowledgement,
  before start, no spawn with an already aborted signal, receipt response loss,
  and transient observation failure without false cancellation.
- An actual shell test starts a SIGTERM-resistant descendant, confirms escalation
  stops it, checks that the next step did not run, and keeps an unrelated process
  alive. It uses real subprocesses rather than injected executor success.
- The built two-process HTTP acceptance probe now cancels an executing job,
  confirms its resistant descendant's process group returns ESRCH before a
  durable stopped receipt, checks no late/next-step witness, preserves an
  unrelated sentinel, and rejects a forged stopped token. Existing SQLite
  restart, DAG execution, lost offer/completion, and uncertain execution tests
  remain in the same probe. It explicitly cleans up the separate uncertain
  shell group after killing the runner, without asking the restarted runner to
  adopt or signal it.

Validation passed locally on Node 20.20.0/macOS with native SQLite: 170
control-plane tests (including 18 durable cases), 83 runner tests (including 12
remote cases), both package typechecks, strict durable/remote configurations
with `skipLibCheck:false`, both CJS/ESM/declaration builds, and the built
HTTP/process acceptance probe. This does not establish Linux or Windows process
behavior, deployed provider acceptance, or production load readiness.

Reproduce with package tests/typechecks and:

```sh
npm run test:remote --workspace=./cifn/typescript/runner
npm run test:remote --workspace=./cifn/typescript/control-plane
```

## Remaining original gates

This is POSIX process-group control, not an OS sandbox. Processes deliberately
escaping their group/session, Windows process trees, abrupt host/runner death,
and an unconfirmed process-group kill require operator reconciliation. A
restarted runner never signals historical PIDs or reexecutes uncertain work.
SIGTERM to the runner itself still requests shutdown after the current tick;
it is not an authenticated run-cancellation operation.

Execution leases/reassignment, SendFn email/provider delivery (webhook outbox now covered in
[notification-outbox-readiness.md](./notification-outbox-readiness.md)), provider
steps, remote logs/progress/artifacts, live provider acceptance, installed
consumer/runtime matrices, performance/deployment and Python/CLI/dashboard
parity remain open as recorded in the original spec and execution checkpoint.

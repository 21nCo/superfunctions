# CiFn durable root-job dispatch checkpoint

2026-10-20. Extends the encrypted-record checkpoint with atomic prepared dispatch
intent, transport retry and durable single-winner assignment. This is not
exactly-once execution or a complete durable scheduler.

## Acceptance and state transitions

API, signed webhook and cron creation use `prepareRun()` before any run is stored.
It snapshots the input, resolves all job environments and redaction values, and
computes root jobs from the DAG. Preparation errors leave no accepted run or
queued message. `DatabaseStore.createPreparedRun()` inserts the run, original
normalized definition, redaction values and root-job intents in one encrypted
record/write. The existing memory store remains supported, without a durability
claim. Run creation does not provide an HTTP idempotency key; repeated create
requests can still create separate runs.

A dispatch identity is `JSON.stringify([runId, jobKey, 1])`. Attempt 1 is the only
supported execution attempt in this checkpoint. Publication retries retain this
identity; they do not create execution attempts. Each intent has `ready` or
`claimed` state. Queue payloads include `dispatchId`; assigned payloads also
include an opaque `claimToken`.

Publication uses a revision-CAS lease with a random token and 5-second expiry.
Only its holder can acknowledge publication. A failed enqueue is retried after
5 seconds; an acknowledged but unclaimed delivery is eligible again after
30 seconds. A crash between enqueue and acknowledgement therefore permits
duplicate transport messages. The transport lease is not an execution lease and
never authorizes reassignment of claimed work. Server clocks must be synchronized
for publication scheduling; assignment uniqueness is enforced by database CAS.

The server publisher scans one bounded page of 100 queued/running records per
1-second tick and advances a cursor across pages. Initial acceptance also tries
publication immediately. Queue/publication failures emit generic diagnostics and
leave durable intent available; a transient queue failure does not turn an
already committed run into a failed creation response. Embedders using
`createApp()` must start its returned `dispatchPublisher` and await `stop()`
before closing their adapter. The built server does this automatically.

An authenticated runner heartbeat consumes transport messages and atomically
claims only an eligible pending job from a nonterminal run. The database record,
not the transport payload, supplies the returned job/environment and verifies
its runner label. CAS persists runner identity, claim token and timestamp,
promotes job and run to running, then returns the payload. Competing heartbeats
or duplicate messages cannot return a second assignment. Each request drains at
most 100 stale/duplicate messages. A failed database claim returns failure and
leaves intent ready; later publication recovers a destructively dequeued message.
Cancelled and terminal runs cannot be newly claimed or republished.

## Restart and compatibility

Restart replays only ready intents whose delivery/publication interval has
elapsed. A claimed job remains claimed even if the runner or HTTP response was
lost. `getDispatchStates(runId)` exposes privileged reconciliation metadata
without job environments or secret values. There is no implicit timeout,
requeue, lease renewal, claim-resume endpoint or operator reassignment command.

The encrypted payload extension is backward compatible and requires no DDL
change. Existing records created without prepared intents remain readable and
are not automatically dispatched. Durable-mode heartbeat ignores legacy queue
messages without `dispatchId`; migration of those runs requires explicit
reconciliation. This avoids silently rerunning jobs whose prior execution is
unknown. Generic `createRun()` remains a record-only API; use `prepareRun()` plus
`acceptRun()` for dispatch.

## Validation

Validation on Node 20.20.0: 166 control-plane tests across nine files, including
14 native SQLite cases; production, strict durable and strict boundary typechecks;
CJS/ESM/declaration builds; independent module consumers; built memory startup;
and the built SQLite SIGKILL/restart probe all pass.

Real SQLite tests cover atomic intent/redaction persistence, delivery failure and
close/reopen retry, duplicate messages through authenticated HTTP heartbeats,
competing publisher leases, expired leases, stale acknowledgement tokens,
cancellation, and preparation failure across API/webhook/cron. A native SQLite
trigger rejects claim updates after destructive dequeue: no assignment is
acknowledged, and retry succeeds after the database failure is removed.

The built-server acceptance creates two runs, claims one job, kills the process
with SIGKILL and restarts with the same database/key and an empty memory queue.
The queued job is republished and claimed within the bounded probe; the previously
claimed job is never reassigned. Runner authentication and encrypted record
checks remain part of the probe. It uses real elapsed time, real HTTP, the native
SQLite binding and the built entrypoint, and cleans its child processes/files.

Commands from the repository root:

```sh
npm test --workspace=./cifn/typescript/control-plane
npm run lint --workspace=./cifn/typescript/control-plane
npm run test:durable --workspace=./cifn/typescript/control-plane
node cifn/typescript/control-plane/scripts/verify-module-consumers.mjs
node cifn/typescript/control-plane/scripts/verify-startup.mjs
```

## Remaining original gates

- Remote runner claim acknowledgement/resumption, step/job completion protocol,
  authenticated claim-token validation on completion, execution leases/fencing,
  explicit retry policy and reassignment. Response loss after committed claim
  deliberately leaves work for reconciliation rather than risking duplicate
  side effects. The existing local runner still directly mutates MemoryStore;
  it is not a completed remote durable runner integration.
- Atomic dependent-job scheduling and terminal run/notification outboxes.
  This checkpoint prepares root jobs only. Completion, cancellation delivery,
  downstream DAG execution and provider-side idempotency remain open.
- FlowFn live acceptance, transport duplicate retention/backpressure, prolonged
  queue failures and hung provider requests, clock skew, large-scale scan cost,
  and the original dispatch/read/parse performance targets. Unclaimed work may
  have multiple transport copies; queue capacity and retention must accommodate
  them. The 30-second redelivery interval is not a measured 5-second recovery SLA.
- Other language, CLI/dashboard, provider, migration/key rotation, installed
  package, deployment, backup/restore and security/load gates from the original
  specification remain unchanged. No production deployment was performed.

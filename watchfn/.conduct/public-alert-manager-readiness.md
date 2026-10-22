# Public alert manager checkpoint

The public `watch.alerts` API now uses the windowed condition evaluator with
observations loaded from the configured WatchFn storage. Definitions, lifecycle,
notes and notification jobs share the internally schema-wrapped DB adapter.
Applications migrate `getAlertSchema()` alongside `getWatchFnSchema()` before
using alerts. Legacy event-only adapters cannot supply durable alerts. Memory
mode preserves the API but is explicitly process-local.

## Behavior

- `create`, `get`, bounded `list`, `update`, `trigger`, `acknowledge`, `addNote`,
  and `resolve` persist state. Definition updates require the full definition.
  Notes are bounded to 100 per alert. Channels are limited to 10 per definition;
  definitions are bounded to 32 KiB. Public results redact all channel routing
  configuration, including webhook URLs and integration keys.
- `evaluate({ now, limit, after })` is a host-scheduled, awaited page operation.
  It reads actual numeric observations, preserves composite metric separation,
  enforces each threshold window and never silently truncates observation overflow.
  The default limit is 10,000 observations per metric. Anomaly conditions use the
  retained history and fail on overflow; no unseen historical completeness is
  implied. Scalar suffix fallback follows the existing query convention.
- Missing observations are unknown. Recovery occurs only when the explicitly
  configured `autoResolve` condition matches. Acknowledgement is durable and
  remains active until resolution. Repeated breaches do not create duplicate
  transitions. Manual resolution can retrigger on a later observed breach.
- A shared DB transaction commits a revision-checked state transition and all its
  channel jobs atomically. Listener callbacks run after commit and are awaited.
  A callback failure reports that the transition committed; it does not undo
  state or notification jobs.
- `processNotifications({ limit })` claims a bounded page using revision/token
  fences, timeout and lease ownership. Jobs retry with capped exponential backoff
  and a default five attempts. Failed jobs become durable dead letters; no raw
  provider error or response body is persisted or logged. `notifications()`
  returns only safe status fields. `dismissNotification(id)` explicitly deletes
  a dead letter and reclaims capacity.
- Each alert admits at most 100 pending/dead notification jobs by default.
  Capacity failure rolls back the lifecycle transition. Delivered jobs are
  removed transactionally while updating a safe last-delivery summary, so they
  do not accumulate forever. Overall storage remains proportional to the number
  of alert definitions; there is no global definition-count limit or automatic
  historical cleanup claim.
- Webhook and Slack delivery use bounded HTTP requests with redirects rejected.
  Webhook jobs carry a stable idempotency key. Email/PagerDuty require configured
  server-owned sender functions, supplied again after restart; no console-only
  delivery is considered success. Standalone `EmailChannel` likewise requires a
  real sender and escapes rendered input. Provider credentials remain in stored
  definition/job snapshots, so database encryption, access controls, backups and
  credential rotation remain application responsibilities.
- Evaluation and dispatch participate in WatchFn's admitted-work tracking.
  `stop()` waits for admitted work and rejects new evaluation/dispatch. Host code
  owns scheduling; there is no hidden timer or new public HTTP management route.

## Validation and limits

Native SQLite fixtures and owned local HTTP receivers exercise the public API:
metric ingest/evaluation, restart, notes/acknowledgement, explicit autoResolve,
missing data, durable dead letters and bounded capacity, independent concurrent
claimers, observation overflow, and stop/drain. No external provider was contacted.
The full TypeScript suite passes 214 tests across 24 files, including 10 public
manager integration tests. TypeScript typecheck, CommonJS/ESM builds, bundled
declarations for all six entry points and `git diff --check` pass. Logs are
`/tmp/watch-alert-manager-full.log`, `/tmp/watch-alert-manager-types.log` and
`/tmp/watch-alert-manager-build.log`.

This remains a partial original alerting checkpoint. Storage scans are live, not
cross-query snapshots; concurrent ingestion/retention can change observations.
CAS conflicts surface for retry rather than silently overwriting state. Delivery
is at-least-once: a crash after a provider accepted a message but before durable
completion can repeat it. Provider-side idempotency support is required to dedupe.
Configured sender functions must honor AbortSignal; arbitrary noncooperative
application callbacks cannot be forcibly stopped or given a physical execution
bound. Their successful return is the sender's delivery acknowledgement.

Python still has a separate in-memory alert manager and incomplete database
storage; this change does not establish Python lifecycle/persistence parity.
Smart escalation, durable callback execution, hosted provider acceptance and
full original WatchFn readiness remain unproven. No deployment or real message
send is part of this evidence.

## Lifecycle and delivery fencing

Full definition replacement now removes omitted optional fields, including an
old `autoResolve` policy. The existing enabled state is retained when `enabled`
is omitted. Admitted lifecycle inputs are captured before database waits, so
later changes to the caller's object cannot bypass actor/value validation or
replace the requested note.

Evaluation binds its observations to the alert revision read before the scan.
A concurrent resolution, acknowledgement, definition edit or delivery-summary
update makes that evaluation conflict and require a fresh scan; stale evidence
cannot undo a newer operator decision. The scan itself is still not a database
snapshot of concurrently ingested events.

A successful sender return after the timeout is not acknowledged as delivered.
Both AbortSignal and elapsed wall time are checked, including delayed timer
execution. Completion requires the same token, a sending job and an unexpired
lease. A reclaimed job retains its notification ID for provider deduplication;
an old sender cannot complete or fail the new owner's attempt. Expired claims
consume attempts, and exhaustion produces a durable dead letter. A dead letter
may represent an uncertain remote delivery, not proof that the provider rejected
it. Custom senders still must honor cancellation: they remain awaited and cannot
be forcibly terminated by this library.

Accessing alerts with a missing database adapter or unsupported hybrid backend
now fails instead of silently creating volatile alert records. Empty dead-letter
IDs are rejected before any namespace query, preventing accidental deletion of
an unrelated notification.

Additional native tests cover the lifecycle/definition races, mutable admitted
inputs, timeout outcomes, lease reclaim and attempt exhaustion, unavailable
storage, invalid dismissal IDs, and a complete shutdown of every SQLite
connection followed by reopen and retry with the same notification key. The
full suite now passes 224 tests across 24 files (20 public-manager tests), plus
TypeScript and CommonJS/ESM/declaration builds. Logs:
`/tmp/watch-alert-audit-full.log`, `/tmp/watch-alert-audit-focused.log`,
`/tmp/watch-alert-audit-types.log`, `/tmp/watch-alert-audit-build.log`.

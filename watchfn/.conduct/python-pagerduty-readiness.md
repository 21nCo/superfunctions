# Python PagerDuty Events v2 delivery

Original SPEC section9 requires PagerDuty integrationKey/severity channels alongside
email and Slack. The database-backed Python alert manager now sends actual Events
v2 trigger/acknowledge/resolve requests through its existing bounded HTTP dispatcher.
No arbitrary provider callback, new database abstraction or external send is used.

## Durable lifecycle behavior

Each new alert incident receives a random persisted episode ID. Requests derive a
stable hashed dedup key from Watch namespace, alert ID and episode. Per-routing-key
predecessor links in outbox payloads enforce trigger→acknowledge→resolve ordering.
A rapid resolve→retrigger retains a predecessor dependency on the prior episode's
resolution while using a new dedup key. Different workers and random job-ID order
cannot bypass these dependencies: claim requires a retained delivered predecessor
receipt with matching alert, route and episode. A zero-row claim CAS means another
worker won and skips I/O.

Unknown/rejected/pending/dismissed predecessors do not unblock successors. A
verified operator `delivered` reconciliation can unblock an unknown outcome;
`dismissed` only releases that obligation and is not delivery proof. Explicit
cancellation of a blocked pending chain is still open. The latest per-route receipt
must be delivered before changing routing keys, and active incident routing cannot
change. Duplicate routes and unsupported severity values reject before persistence.
Channel severity overrides the alert severity; accepted values follow the original
spec/provider contract: critical, error, warning and info.

The default trusted endpoint is https://events.pagerduty.com/v2/enqueue. A validated
host-only `alerts.pagerDutyEndpoint` supports owned/local acceptance and trusted
provider gateways. Alert definitions and HTTP bodies cannot override it. TLS
verification, redirect prohibition, body caps, deadlines and error sanitization
remain in the existing dispatcher. HTTP202 plus bounded JSON status=success and
matching dedup key means provider acceptance, not verified incident/paging state.
Unexpected replies, rate limits and ambiguous outcomes park without automatic
replay. Replaying a trigger after an externally resolved incident could create a
new incident, so provider deduplication is not treated as blanket idempotency.

Terminal receipts remove routing credentials and preserve nonsecret predecessor
metadata. Alert definitions retain configured credentials at rest; protect the
DB/backups. Notification metadata now includes the lifecycle event, matching the
TypeScript public status shape.

## Upgrade boundary

Drain and stop all pre-PagerDuty Python lifecycle/dispatch writers before enabling
this slice. They share the python-v1 marker and can enqueue missing/stale sequence
metadata; the existing TS/Python marker alone does not fence this rollout. Legacy
or malformed PagerDuty jobs fail before claim/provider I/O, retain attempts/count,
and require explicit offline migration/cancellation. No automatic replay/backfill
is attempted. Both runtimes' different-protocol gate remains intact.

## Evidence

Owned loopback HTTP + actual SQLite cover queued lifecycle ordering across closed
connections/reopen and independent concurrent workers; unknown trigger blocking and
operator reconciliation; rapid episode turnover; routing-change fences; severity
mapping; malformed/oversized/wrong-key receipts; missing/malformed legacy episode
metadata; invalid endpoint and duplicate routes. All requests target the owned
loopback server; no live PagerDuty credentials or service is used.

- Focused provider/dispatcher/durable suites:36passed (11.65s).
- Normal Python CI entrypoint:160passed (12.58s); source archive/wheel built.
- Fresh five-wheel installed consumer:160passed (13.73s); imports confirmed from
  site-packages and dispatch extra dependency installed.
- TypeScript source did not change; no new TypeScript build/behavior claim is made.
- `git diff --check` passed. Owned HTTP servers/database handles and installed
  temporary environments closed/removed; source venv removed after validation.
  No active owned processes remain. Evidence is tracked; no ignore rules changed.

The initial focused run exposed a losing claim CAS unnecessarily aborting its
whole dispatch page and a missing public event metadata field. The final source
handles zero-row claims without I/O and exposes the event as metadata; the same
concurrent lifecycle fixture now passes without relaxing timing or delivery rules.

## Remaining provider and retention work

Email remains required. Existing SendFn Python EmailProvider/AwsSesProvider is a
real reusable provider contract, but AwsSesProvider calls synchronous boto3 inside
async methods, and its package currently declares stale superfunctions==0.1.0.
A bounded-I/O/packaging prerequisite is needed before integrating that implementation;
a custom callback placeholder would not satisfy the requirement. TypeScript still
requires configured email/PagerDuty senders; this checkpoint does not implement its
missing built-in PagerDuty provider or claim full language parity.

Original SPEC retention examples describe event/aggregation tiers, not a notification
receipt TTL. Terminal receipt retention remains required and is not silently added
here. A concrete next policy is an explicit host cutoff and bounded ID page, deleting
only delivered/dismissed receipts for alerts whose pendingNotifications==0 while
preserving current per-route tail receipts. CAS the alert revision in the same
transaction before deletes so concurrent enqueue defeats pruning. Unknown/rejected
obligations and referenced receipts remain protected. Busy/unresolved alerts retain
history; total retained history is still unbounded in this checkpoint.

Callbacks, calculated-value context and the broader original readiness scope remain
open. No deployment, release or publication is part of this checkpoint.

Provider evidence: [Events v2 API](https://docs.pagerduty.com/developer/api/reference/events-v2/send-event/create-v2-event),
[deduplication and lifecycle semantics](https://docs.pagerduty.com/developer/send-alert-event).

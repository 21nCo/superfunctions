# Durable TypeScript PagerDuty delivery

This checkpoint implements the original channel contract in SPEC section 9 through
stored alert transitions, shared-schema transactions, an owned dispatcher and the
actual Events v2 wire protocol. It does not establish full WatchFn readiness.

## Behavior and compatibility

PagerDuty definitions accept integrationKey and optional severity without a host
callback. Trigger, acknowledgement and resolution persist one episode and stable
incident deduplication key. Each route has a predecessor chain; a later incident
waits for the prior resolution and receives a new key. A dropped response parks the
job unknown, retains its pending obligation and blocks successors. There is no
blind replay. Explicit operator reconciliation can attest delivered or dismissed;
dismissal cannot assert provider acceptance or unblock a PagerDuty predecessor.
Only a bounded HTTP 202 JSON success response with matching dedup key is accepted.

Delivered and dismissed receipts remain stored. Their channel credentials are
removed; unresolved jobs retain the data needed for explicit recovery and require
protected storage. Public metadata does not expose routing keys or raw response
errors. Terminal receipt retention is currently unbounded and remains required
follow-up work; pruning must preserve route tails and unresolved obligations.

This intentionally changes old TypeScript retry behavior: expired leases,
transport failures, callback exceptions and ambiguous responses park unknown.
Only a validated Slack 429 Retry-After response permits automatic retry. Missing
email callbacks do not claim obligations. Hosts must traverse after/nextCursor
pages to avoid starvation behind unavailable senders or blocked predecessors.
Arbitrary host callbacks must cooperate with AbortSignal; they cannot provide a
hard shutdown deadline. Built-in TypeScript email remains required follow-up.

TypeScript now owns ts-v2 and Python owns python-v1, checked before lifecycle
mutation and dispatch. Read-only inspection remains available. Stop and drain all
older writers and their provider operations before adopting this checkpoint:
markers cannot retroactively fence old code. A missing marker with existing rows
fails closed. The explicit stopped-namespace migration requires an exact ts-v1
marker, scans limit+1 alerts/jobs, rejects overflow and legacy PagerDuty history,
and parks attempted non-PD work without discarding pending counts. Larger or
legacy PagerDuty namespaces still need explicit offline migration. No production
namespace was migrated during validation.

Kysely SQLite body contention retries only after the exact callback sentinel
returns through successful rollback. It uses three attempts and a 50ms monotonic
scheduling budget; this is not a deadline for database lock waits or rollback.
COMMIT-stage errors, rollback failure, other adapters and exhausted retries remain
visible. Provider I/O and listeners never occur in these closures. The existing
shared memory adapter queue provides serialization; WatchFn adds no second queue.

Python lifecycle operations now use the existing durable protocol guard. SES
configuration and delivery no longer depend on the optional httpx client; HTTP
channels retain their own capability requirement. Shared Unicode golden vectors
pin TypeScript/Python incident identity and wire fields.

## Acceptance

Owned loopback HTTP fixtures and native independent SQLite connections prove
ordered delivery across close/reopen, competing workers, exact send/receipt
counts, dropped responses, blocked successors, explicit reconciliation, malformed
metadata and bounded response rejection. Memory concurrency proves independent
managers cannot restore stale snapshots over another committed claim. Injected
body, COMMIT and rollback errors distinguish retry eligibility and exhaustion.
Migration tests prove overflow and legacy PagerDuty rejection leave state intact.

- Focused TypeScript: 39 tests passed.
- Full TypeScript under Node 20.20.0: 254 tests passed; typecheck passed.
  Installed consumer acceptance below uses Node 22.22.0; it is not an installed
  Node 20 consumer claim.
- Turbo dependency build: 10 tasks passed using existing Turbo 2.6.1.
- Fresh five-tarball npm consumer: ESM and CommonJS entry points passed actual
  local Events v2 lifecycle, uncertain-outcome recovery and public migration API
  checks using Node 22/npm 11, with a 30-second child execution bound.
- Normal Python CI entrypoint: 177 tests passed after wheel/sdist build.
- Fresh six-wheel installed Python environment: 177 tests passed, including
  native SQLite reopen/worker and owned SES-without-httpx regressions. Both Python
  runs reported 101 dependency/datetime deprecation warnings.

Initial full TypeScript validation had 253 passes and one unrelated context timer
failure: a requested 100ms timer produced 99ms Date.now elapsed time. The test now
asserts exact 0/99/100 boundaries and undefined outside context using a controlled
clock; runtime clock behavior is unchanged. Its focused rerun passed. Initial
Turbo invocation could not see the tracked sparse-excluded turbo.json; adding the
existing path to sparse materialization resolved it without content changes.
Npm 10 failed before execution with Arborist edgesOut null; existing npm 11 ran the
same dependency closure without manifest workarounds. An initial installed fixture
correctly rejected migration but failed to consume the retained drain error and
skipped cleanup; the corrected fixture explicitly asserts that error and always
stops both instances and closes its server. The stuck owned child was terminated;
no provider request was replayed to conceal the failure.

Logs remain under /tmp/watch-ts-pd-* (focused-final, full, full-final, context,
build, installed-npm11, installed-npm11-final, installed-bounded, python-ci, wheel). No external
PagerDuty/Slack/email provider was contacted. No base merge, push or deployment was
performed. Owned temporary wheel/consumer environments and the validation venv
were removed; no owned test, client or server processes remain. Source work is limited to WatchFn; root metadata and ignore rules are
unchanged.

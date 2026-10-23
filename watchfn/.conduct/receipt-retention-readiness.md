# Bounded durable receipt retention

The original SPEC's Storage & Data Retention section requires configurable
retention/capacity behavior but does not prescribe an alert-receipt TTL. This
checkpoint adds explicit host-driven bounded receipt maintenance in both runtimes;
it does not invent a default TTL or claim a physical storage quota.

## Policy and storage invariants

`pruneNotifications({completedBefore,limit,after})` and Python
`prune_notifications(completed_before=...,limit=...,after=...)` use an exclusive
completion-time boundary. Page limits are 1..1000. A compound completion-time/full
ID cursor handles tied timestamps and arbitrary legacy IDs without truncation.
Hosts must traverse all pages and schedule subsequent scans. The bound covers
rows and per-row dependency lookups, not database lock duration or total disk.

Only delivered/dismissed terminal receipts are candidates. Every current route
tail and every incoming operational predecessor reference pins its receipt.
Pending/sending/unknown/rejected work is never removed. Dismissed blocked chains
retain their dependencies. Authoritative delivery releases only that job's
operational predecessor link; payload episode, route and predecessor history stay
intact. No pruning operation changes pending counts, provider state or sends.
The current tail remains available for later incident generations across restart.

The outbox gains nullable completedAt and predecessorId projections, indexed for
completion range and reverse-dependency lookup. Namespace/ID indexes support
migration pages. Both schemas expose the same columns/indexes. Every lifecycle
writer and authoritative receipt mutation conditionally updates the owning alert
revision. Pruning checks current tails and incoming references, then CASes that
same revision before deleting. Competing lifecycle writers cannot commit a new
reference past that fence. TypeScript uses conditional shared deleteMany. Python
uses existing shared transaction APIs: owner CAS, candidate revision CAS, delete,
and same-transaction absence verification. Missing delete capability fails before
mutation; deletion failure rolls back owner/candidate changes and row removal.

Projection integrity assumes cooperating supported writers on an owned database.
Direct hostile database edits are not isolated. Encountered missing/inconsistent
projections fail closed. Hosts still need storage monitoring and admission limits:
retained current tails, unresolved obligations and dismissed blocked chains can
remain indefinitely. Alert-definition deletion remains unsupported. Built-in TS
email and broader original readiness requirements remain open.

## Resumable migration and protocol fencing

Hosts first apply Watch-owned nullable schema additions and physical indexes:
outbox completedAt/predecessorId and runtime migrationPhase/migrationCursor/
migrationRevision. Schema registration does not run production DDL. Stop and drain
all prior writers and provider operations before starting. Old releases cannot
retroactively be fenced by a new marker.

The explicit migration accepts exact ts-v2/python-v1 ownership and switches to a
migration marker. Each DB-only transaction commits at most one bounded keyset page
and CASes durable progress. Phases backfill projections, validate current alert
tails, then validate job dependencies before activating ts-v3/python-v2. Current
runtime creation, lifecycle, dispatch and pruning recheck ownership transactionally
and reject migration markers. Inspection/status remains available. Two operators
may contend; a rejected transaction can be retried by the host without skipping a
page. Crash/reopen resumes saved progress. A validation error preserves the failing
page and keeps runtime writes fenced. Offline repair may require restarting
backfill; never activate by simply overwriting the marker.

The older ts-v1 helper remains a separate bounded first step to ts-v2. Its overflow
and legacy PagerDuty migration restrictions are unchanged. Missing namespace
markers do not establish ownership. The new migration does not claim that every
historic namespace is automatically repairable.

## Evidence

Native owned SQLite and loopback provider fixtures cover:

- Delivered ancestors pruned while current tails remain; unknown/dismissed blocked
  successors retain predecessors and exact pending counts after reopen.
- Competing workers pruning while lifecycle enqueues a new incident; exact sends
  and retained receipt counts; owner/candidate rollback after deletion failure.
- Resumable page migration with independent operators, stopped/reopened instances,
  and actual child processes killed after a committed page in both languages.
- Missing predecessor rejects activation without advancing progress; inconsistent
  projection rejects pruning; full legacy IDs and tied timestamps paginate safely.
- SQLite EXPLAIN QUERY PLAN confirms declared receipt-range, predecessor and
  namespace-keyset indexes without temporary sort trees.
- Fresh installed public APIs exercise migration, status and maintenance alongside
  actual Events v2 delivery through ESM/CommonJS and Python wheels.

Validation on the final source:

- Node 20.20.0: full TypeScript 264 tests / 26 files passed; typecheck passed.
- Turbo 2.6.1: all 10 dependency build tasks passed (9 cache hits).
- Node 22.22.0/npm 11: fresh five-tarball ESM/CommonJS consumers passed actual
  delivery, unknown-obligation pinning, resumable migration, status and pruning.
  A strict installed TypeScript consumer checks the new public declaration signatures.
  Child execution is bounded at 30 seconds. Installed Node 20 is not claimed.
- Normal Python CI entrypoint built wheel/sdist and passed 187 tests in 25.85s.
- Fresh six-wheel Python 3.12 consumer passed 187 tests in 26.82s, including actual
  native SQLite and killed-child acceptance. Both reported 101 dependency/datetime
  deprecation warnings.

Initial focused failures are
preserved in /tmp/watch-retention-* logs: Python transaction.delete_many was not
available and was replaced with the existing shared API ownership sequence above;
new metadata validation required updated exact error assertions; the TS crash
fixture needed ESM Kysely loading and its normal physical table mapping. An initial
full TS run had 262 passes and one unrelated event-retention test failure: its
transactions-only capabilities object omitted shared data-type capabilities. The
fixture now preserves the adapter's other capabilities before disabling
transactions, keeping the intended fail-closed assertion. No event-retention
runtime behavior changed. The first installed declaration fixture omitted the
currently required typed storage field; the corrected consumer explicitly selects
memory storage without changing the existing public type contract.

No external provider sends, production schema changes, base merges, pushes or
deployments were performed. No shared package/root metadata/ignore changes are
part of this checkpoint.

Owned wheel/consumer fixtures and the validation venv were removed after checks;
no owned provider, database, test or child processes remain. Initial/final logs are
retained under /tmp/watch-retention-* for the source, build, installed and wheel runs.

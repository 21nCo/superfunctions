# Python transaction conditional-update prerequisite

SQLAlchemy's ordinary transaction update resolves a selected row to its primary
key and does not retain revision predicates at write time. It is unsuitable as
an optimistic-concurrency primitive. The existing batch conditional-update
implementation now also runs on the caller's transaction connection, preserving
all WHERE predicates in one SQL UPDATE and returning the driver's row count.
No nested transaction or separate connection is opened for that operation.

The additive `AtomicUpdateTransactionAdapter` protocol keeps existing transaction
implementations compatible. Consumers must detect the optional method and reject
unsupported adapters; no read/unconditional-write fallback is supplied. A CAS
caller changes the revision and requires exactly one row. Driver no-op and unknown
row counts retain their backend semantics; only revision-changing SQLite CAS is
proven here, not every backend's locking/isolation behavior.

Validation:
- Normal core CI: build, Ruff, mypy and20 tests pass.
- Normal SQLAlchemy CI: build, Ruff, mypy and23 tests pass.
- Fresh core+SQLAlchemy wheels installed in an isolated consumer:23 tests pass,
  including actual native SQLite independent engines/worker threads racing from
  the same observed revision; results are exactly one success and one stale zero.
- Transaction-local subsequent reads, second stale predicate update, rollback,
  untouched unrelated rows and invalid predicates covered. Existing constraint
  exception tests pass after preserving typed errors across helper delegation.
- Existing APIs and no-op ordinary-update behavior remain covered.

Logs: `/tmp/watch-atomic-{core-ci,db-ci,wheel}.log`. Owned installed-wheel fixture,
SQLite files and environments were cleaned. No remote database, push or release.
This is a prerequisite for WatchFn durable lifecycle/outbox transitions, not that
feature's completion. No root metadata or lockfile changed.

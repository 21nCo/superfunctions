# Python LogFn integration checkpoint

WatchFn attaches the actual LogFn dynamic sink, normalizes redacted log events, and commits events with scalar secondary indexes through the shared database adapter. Explicit detach, stop/drain, restart, validation failure and retry preserve ownership of admitted writes. Structured JSON messages pass through the producer's public default redactor again before storage.

## Validation

Python 3.11.14 normal package CI and a fresh seven-wheel installation both passed all **291 tests**. The wheel run builds the shared core, FastAPI, Flask, SQLAlchemy, LogFn, SendFn and WatchFn distributions, installs normally into an isolated environment, verifies site-packages imports and executes copied tests without workspace PYTHONPATH.

Commands (the owned environment was removed afterward):

```sh
PATH="/tmp/watch-log-integration-python/bin:$PATH" node scripts/ci-run-python-package.mjs watchfn/python
/tmp/watch-log-integration-python/bin/python watchfn/python/scripts/verify-http-wheel.py
```

Receipts retained locally:

- `/tmp/watch-log-python-final-ci.log`: 291 passed, 22 warnings, 26.41 seconds.
- `/tmp/watch-log-python-final-seven-wheel.log`: 291 passed, 22 warnings, 27.12 seconds.
- `/tmp/watch-log-python-reentrant-before.log`: subprocess timeout reproduced a storage-callback logging deadlock before the guard. The subprocess was killed and joined; the final regression completes normally and verifies explicit rejection of recursive logging and `WatchFn.flush()`.
- `/tmp/watch-log-python-real-receipt-before.log`: actual SQLite REAL `receivedAt` reproduced the integer-only reader failure. The final fixture reads integral REAL timestamps; malformed fractional, negative, boolean, nonfinite, unsafe and string values remain rejected.

`tests/test_log_integration.py` adds 16 cases:

1. Actual logger family lifecycle, canonical fields, query and aggregate.
2. Configuration overrides and structured-message privacy.
3. Stop joining an admitted synchronous write and observable storage failure/retry.
4. Disabled integration, validation and reentrant stop.
5. SQLite index seek, legacy/changed-policy fallback, bounded backfill, reopen and query plan.
6. Atomic event/index rollback and retry.
7. Scalar key semantics and memory coverage.
8. Invalid configuration, whole-batch validation and private index metadata.
9. Explicit old-schema migration and the physical metadata row cap.
10. Backfill rollback preserving prior coverage.
11. Shared scalar-key golden vectors, including Unicode and IEEE754 rounding.
12. Actual TypeScript-shaped stored log validation and canonical reserved fields.
13. Lone Unicode surrogate rejection.
14. Subprocess storage callback recursion without deadlock.
15. Normalized structured expansion rejected before batch admission.
16. Safe integral numeric receipt representations and malformed ordering rejection.

The SQLite fixture stores 42 events, including legacy and differently indexed policies. Equality lookup fetches only 3 payloads while scanning bounded metadata for all 42. `EXPLAIN QUERY PLAN` confirms `SEARCH` using the secondary lookup index. Idempotent seven-row backfill pages replace 81 prior secondary rows with exactly 42, and reopened storage returns the same three results. Failed index insertion and failed backfill roll back atomically.

## Boundaries

- Each producer input and normalized stored event is limited to 64 KiB; each batch input/output is limited to 16 MiB and 1,000 entries. Validation occurs before admission.
- Queries reject more than 10,000 metadata/index rows or separate 16 MiB metadata/payload budgets. Legacy or changed-policy rows remain residual candidates. This is payload-read reduction, not an index-only query or a total database-work guarantee.
- Hosts must stop all old/new writers for explicit nullable coverage-column/index migration and bounded backfill. This deployment barrier is not distributed fencing. No runtime automatic DDL is introduced.
- SQLite migration, rollback, reopen and query-plan behavior are verified. PostgreSQL/MySQL migration and index-width acceptance remain open.
- Python has no event-retention API; external deletion must delete secondary rows transactionally. Memory eviction rebuilds its index.
- Only validated canonical TypeScript log envelopes receive compatibility mapping; arbitrary cross-language custom event envelopes remain unsupported.
- The installed LogFn build must provide both `add_sink` and public `default_redactor`. Index selection never expands the producer's privacy allowlist.
- Pattern creation/detection remains outside this implemented integration surface. No live provider dispatch or production deployment was performed.

The owned source environment and final wheel consumer directory were removed and absence verified. All owned validation processes ended. `git diff --check` passed.

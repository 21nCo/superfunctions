# Python transactional database checkpoint

2026-10-23. Replaces the unfinished DatabaseStorage add/query placeholders with
shared-adapter operations and a Watch-owned schema/JSON-text codec. Applications
migrate the exported shared TableSchema; no adapterSchema escape hatch or duplicate
DB adapter is introduced. watchfn_events id/payload and nullable projection columns
match TypeScript's storage layout. Python writes projectionVersion0 for honest
TypeScript scan fallback. Arbitrary TypeScript payload shapes are not silently
coerced into reduced Python events.

A started DB-backed WatchFn owns one serialized adapter loop/thread. Synchronous
track/batcher/query calls bridge to it; HTTP ingestion awaits the transaction and
HTTP query offloads its synchronous flush/bridge from the request loop. Stop drains
admitted work and joins the worker without closing the caller-owned engine. Missing
adapters/transaction capability fail explicitly. The validated backend is the
shared SQLAlchemy adapter with file-backed native SQLite.

Batches are transactional and stable private Event IDs/frozen payloads reconcile
in-process retries after postcommit acknowledgement failure. New HTTP requests
have no idempotency key and can duplicate earlier uncertain requests. Cancellation
does not cancel an admitted transaction. Pending batch queues remain non-durable.
Queries page actual rows within an adapter transaction, validate stored payloads
and reject row/byte overflow rather than return partial success. Backend isolation
controls snapshot semantics; receivedAt/id determine order. The README describes
100-row pages,10000-row/16MiB scans and64KiB stored payload limits.

Final validation on Python3.12.12:

- Normal repository Python CI entrypoint:49 tests pass, wheel/sdist build.
- Fresh five local wheels (Watch/core/SQLAlchemy/FastAPI/Flask), isolated install:
  49 tests pass, installed site-packages import asserted. Plain Flask works without
  flask[async]/asgiref. Temporary consumer is removed in finally.
- Actual SQLite tests cover HTTP202 only after commit, rollback with zero rows,
  postcommit lost-ack batch retry without duplicate rows, stop/start and independent
  engine/adapter reopen, two independent writers, JSON roundtrip, missing migration
  failure, scan overflow, cancellation drain and worker cleanup. Both real framework
  adapter stacks execute in-process, not against a deployed server.

Logs: /tmp/watch-python-db-ci.log, /tmp/watch-python-db-wheel.log and
/tmp/watch-python-db-tests.log. An uncommitted attempt to preserve fallback tool
installation by naming ruff/mypy in dev activated new gates in ci-utils and reported
321 lint errors; /tmp/watch-python-db-ci-tools-attempt.log retains that evidence.
Those tool-only additions were reverted to the previous gate semantics: ec2/91cac
had no configured lint/type gates, and none was removed. This checkpoint does not
claim lint/type cleanliness. Source/wheel tests retain existing Pydantic/datetime
and FastAPI testclient migration warnings.

The owned source venv and temporary consumers were removed after validation; all
runners exited. No external DB/provider/deployment/publication or base merge.
Remaining limits include unsupported foreign-loop clients/thread-local SQLite
pools, custom adapters blocking drain indefinitely, transport buffering before
body validation, indexed query/retention, issue/alert/tenant parity, and durable
queue/crash replay. A live process can drain writes; this is not a process-kill
exactly-once guarantee. Other original17-function readiness requirements remain
open where separately tracked.

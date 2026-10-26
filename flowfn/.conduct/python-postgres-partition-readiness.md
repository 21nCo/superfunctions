# Python PostgreSQL stream partition receipts

Baseline: `d0335d73895333b48eb4ee1e6d5917c3cdd1962f`.

A configured PostgreSQL stream previously raised `Adapter does not support stream partitioning` before any connection. The baseline reproduction is retained in `/tmp/flow-pg-partitions-baseline.log`.

## Behavior

Python PostgreSQL now persists immutable routing policies, sparse group/partition progress, and receipt barriers independently of payload rows. Publication and group transitions reuse the existing namespace/stream advisory lock and asyncpg pool. Claim, renewal, ACK/NACK and retention are transactional. An attempt token plus PostgreSQL-time expiry fences every settlement. A retained expired predecessor is retried before its partition successor. Payload deletion cascades pending rows but does not remove a live partition barrier. Capacity and fractional-age retention also apply to unconfigured streams independently of unread/pending work.

Active callbacks renew; returned manual callbacks do not renew indefinitely. Lost ownership cancels and joins owned callback work through the existing lease helper. Unsubscribe releases only a still-current receipt after joining the callback. Cleanup fences public admission immediately, owns one shared completion task, and joins even when its caller is repeatedly cancelled. The migration pool is serialized through the same initialization lifecycle and closed before cleanup completes.

Stream schema version 2 is installed on a fresh database. Version 1 requires explicit `migrate_stream_schema()` with older writers stopped. DDL and version changes commit atomically; retry after rollback and repeated completed migration are supported. Existing histories/groups become legacy policies, not fabricated partition histories. Existing Python JSON rows, message IDs and table namespace are preserved. The TypeScript PostgreSQL physical layout is different and is not claimed interoperable. New cooperating APIs fence policy changes; older deployed code must be stopped because it cannot be fenced by metadata it never reads.

## Native acceptance

`/tmp/flow-pg-partitions-env/bin/python -m pytest flowfn/python/tests/test_postgres_partitions.py --no-cov -q` passed **9 tests in 1.97s** on Python 3.9.6 (`/tmp/flow-pg-partitions-native6.log`). Tests use a private local PostgreSQL cluster and two independent adapters, including:

- immutable routing, Unicode keys, detached input snapshots, concurrent configuration and legacy fencing;
- independent partitions/groups, NACK ordering, stale tokens and tail cutoff;
- returned manual callback expiry and late acknowledgement;
- retained barrier after payload removal, cancellation and successor eligibility;
- actual version-1 migration rollback, retry, idempotence and preserved history;
- a separate Python consumer process killed after claim, followed by durable recovery;
- concurrent cleanup and repeatedly cancelled cleanup caller, admission rejection and immediate receipt release;
- unconfigured pending/unread capacity removal and fractional storage-time age;
- migration blocked on an advisory lock while cleanup waits, with temporary connection closure verified.

Initial fixture runs failed because the macOS Unix-socket path exceeded PostgreSQL's limit; the owned cluster now uses its isolated TCP listener without a Unix socket. A subsequent retention fixture allowed its own default 100 workers to claim the successor; its intended single-worker ordering case now explicitly uses `max_in_flight=1`. Failed receipts remain in `/tmp/flow-pg-partitions-native*.log`; neither case changed production thresholds.

The former PostgreSQL pending-payload retention assertion intentionally conflicts with the new exact-retention contract and is replaced by native removal/cancellation cases. Existing heartbeat/recovery tests retain one payload during their ownership checks, then still assert final trimming. This separates ownership recovery from zero-capacity deletion.

## Package validation

Final normal CI passed **260 tests, 6 intentional provider-specific skips**, Ruff, strict mypy across **97 source/test files**, and wheel/sdist build on Python 3.9.6. Command: `PATH=/tmp/flow-pg-partitions-env/bin:$PATH python flowfn/.conduct/run-python-postgres-ci.py`; log `/tmp/flow-pg-partitions-ci.log`. This runner enables both owned local PostgreSQL and Redis, then verifies provider shutdown/private-directory removal. The six skips select the opposite provider parameter in provider-specific tests; neither provider was omitted.

`PATH=/tmp/flow-pg-partitions-env/bin:$PATH python flowfn/.conduct/verify-python-redis-partitions.py` passed from clean wheel builds on actual Python **3.9 and 3.11**, each with **23 tests** (9 PostgreSQL cases plus 14 Redis/ownership cases) and strict typing of all three installed test consumers. Log: `/tmp/flow-pg-partitions-wheels.log`. The fixture verifies the new PostgreSQL modules are in the wheel, asserts imports resolve inside each isolated environment, checks actual TypeScript Redis bundle source provenance, and removes its temporary source/consumer tree. No source checkout is used for Python imports. Existing Pydantic class-config deprecation warnings remain; no checks or versions were weakened.

The new normal-CI entry point uses the existing Redis owner with an explicit private PostgreSQL URL. Without that argument the older Redis-only entry point still removes inherited PostgreSQL URLs. No new runtime dependency is introduced.

## Remaining limits

This checkpoint does not establish original throughput/latency targets, deployment readiness, Redis Cluster support, PostgreSQL server-process crash recovery, or exactly-once external callback effects. PostgreSQL partition scheduling serializes cooperating transitions per stream; no unmeasured throughput claim is made. Cancellation-resistant user callbacks can delay cleanup. Migration requires stopped older writers and the known version-1 schema, not an inferred upgrade of arbitrary externally modified tables.

# Python relative queue delays

2026-10-20. Relative initial delays and computed retry backoffs now use storage
time for Redis and PostgreSQL, including dependency-aware transactions. Queue
creation and retry pass a private one-shot duration separately from stored job
JSON. A retry may differ from the original delay; fractional custom backoff is
rounded up to a whole millisecond. Explicit adapter `available_at` schedules and
legacy imported schedules keep existing absolute-time semantics. No table or
stored payload layout changes are needed.

Redis patches scalar JSON fields inside its existing script, preserving nested
payloads/empty arrays. PostgreSQL installs versioned enqueue_v4, update_v3 and
dequeue_v3 functions through existing initialization; older signatures remain.
Claims set processed_on from storage. Queue processing preserves it and calculates
local duration from worker-local start/end, avoiding subtraction across clocks.
Completion/retention timestamps and jumps of the storage clock remain separate
contracts. Memory/custom adapters keep local behavior.

Before the fix, native one-hour clock-skew cases failed in all eight combinations
of Redis/PostgreSQL, fast/slow producer, and ordinary/dependency-aware admission:
`/tmp/flowfn-python-clock-before.log`. Explicit absolute scheduling passed.
The new 12 native cases additionally verify a 350ms retry after a 200ms initial
delay, nonserialized relative intent, authoritative claim times and duration
metrics with a skewed worker. Existing native lease, duplicate, payload, migration,
retention and cancellation tests run in the full suite.

Validation from the worktree root:

- `node flowfn/typescript/scripts/provider-acceptance.mjs --python`: Python 3.12,
  189 passed, 6 skipped; `/tmp/flowfn-python-clock-native-final.log`.
- `FLOWFN_PYTHON_VERSION=3.9 node flowfn/typescript/scripts/provider-acceptance.mjs --python`:
  Python 3.9, 189 passed, 6 skipped; `/tmp/flowfn-python-clock-py39-native-full.log`.
- From `flowfn/python`, `uv run --isolated --no-project --python 3.9 --with '.[dev,redis,postgres]' python -m pytest tests -o addopts= -q`:
  89 passed, 106 provider-dependent cases skipped;
  `/tmp/flowfn-python-clock-py39-source.log`.

The native runner owns unique disposable Redis 7/PostgreSQL 16 containers and
removes/read-backs those containers in finally. No live production provider was
used. These runs import the source tree; fresh installed-wheel acceptance is a
separate packaging gate.

`uv run --isolated --no-project --python 3.12 --with '.[dev,redis,postgres]' mypy flowfn`
reports the same 10 errors in three untouched files as an archived pre-change
checkout under the same environment: missing psutil stubs in metrics/health and
Redis client typing errors. The latest mypy also rejects the existing Python 3.9
configuration. Logs: `/tmp/flowfn-python-clock-types.log` and
`/tmp/flowfn-python-clock-types-baseline.log`. No changed file has a diagnostic;
this does not claim a clean repository-wide typecheck. Existing Pydantic
class-configuration deprecation warnings remain in the test output.

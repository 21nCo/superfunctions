# Python HTTP authentication and memory storage checkpoint

2026-10-23. Python WatchFn accepts shared AuthProvider/AuthSession contracts with
exact watchfn:ingest and watchfn:query scopes, expiry validation and provider-first
behavior without legacy key fallback. Configuration errors fail construction.
Authentication precedes body reads; unauthorized/provider/storage failures return
sanitized errors. Legacy keys remain explicit full-operation authority.

The prior ingestion route called track(), which silently discarded stopped calls
and otherwise merely queued them before returning200. HTTP ingestion now validates
the complete bounded batch and returns202 only after admission to the implemented
memory store. Memory batch writes and snapshots use a lock, preserving background
batching compatibility. The query route now returns actual flushed events with
exact-name/limit filtering rather than a constant empty array. Unsupported query
fields reject. The Flask wrapper now uses the shared adapter's url_prefix argument.

Validation on Python3.12.12:

- Normal `node scripts/ci-run-python-package.mjs watchfn/python`:41 tests pass,
  builds wheel/sdist and resolves all three shared Python dependencies locally.
- `python watchfn/python/scripts/verify-http-wheel.py`: four freshly built local
  wheels installed into a separate temporary environment;41 tests pass through
  real FastAPI/Flask adapters. Import path verifies installed site-packages.
- Tests cover scope separation before body reads, provider failure/no fallback,
  malformed/expired sessions, legacy headers, strict auth config, invalid batch
  atomicity, stopped/error503, no acknowledgement before storage returns, query
  snapshots/bounds and no duplicate writes with synchronous track batching.

Logs: /tmp/watch-python-http-ci.log and /tmp/watch-python-http-wheel.log. Initial
adapter setup discovered a sparse-checkout omission (tracked adapters materialized,
no merge), then the Flask prefix bug and a test provider's case-sensitive header
lookup. Those were corrected before both final successful runs. Warnings are
existing Pydantic class-config/datetime deprecations and FastAPI testclient/httpx
migration notices. The temporary installed consumer is removed in finally; the
owned source validation venv was removed after validation. No deployed server,
provider request, registry publication or base merge is involved.

This does not complete Python HTTP parity. DatabaseStorage remains incomplete;
HTTP database requests deliberately return503 rather than claim persistence or
query success. Shared-schema-backed asynchronous DB storage is required next.
Memory retention is1000 events by default, not durable storage. Issue status,
bug-report integration, aggregate/time-range query and alert parity remain open.
Scopes do not implement tenant/resource filtering. The shared Request buffers
body() before actual-byte validation; transport allocation/deadline enforcement
is host-owned, as are provider deadlines and blocked flush timeouts. README gives
exact accepted fields, bounds and compatibility rules. All17-function readiness
requirements remain open where separately documented.

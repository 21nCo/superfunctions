# Explicit background configuration refresh lifecycle

2026-10-20. Adds the original background-refresh requirement on top of the verified
service/SDK contract, with explicit lifecycle ownership in both languages.

## Behavior

`startConfigRefresh/start_config_refresh` starts one immediate refresh and is
idempotent while running. `refreshInterval/refresh_interval` is milliseconds,
default 30000, valid 100–86400000. Python requires a running asyncio loop and rejects
without leaking a coroutine or marking itself running when none exists.
Constructors remain network-free. Subsequent requests begin only after settlement
plus delay; explicit refresh calls coalesce with the active request.

Failures preserve last-good values and are observable in a copied status record:
running state, consecutive failures, last error, last-success epoch milliseconds
and next scheduled epoch milliseconds. Backoff doubles per failure and caps at
five minutes or the configured interval when longer. Verified success/304 resets
the delay. Status contains fixed transport errors, not response bodies or keys.

Awaitable stop disables scheduling, synchronously fences active work before
yielding, cancels it and awaits settlement. Verified ETag state survives restart;
manual setters still invalidate it. Await stop before start to prevent overlapping
lifecycle transitions. Stop also cancels explicit callers sharing active transport
work. Permanent close prevents restart. TS close is awaitable; Python preserves
its synchronous close fence, with awaitable stop for settlement. Node timers are
unref'ed so this optional loop alone does not keep the process alive.

## Acceptance

- Four deterministic TS scheduler tests cover idempotent start, interval, capped
  backoff/reset, no overlap, cancellation settlement and timer cleanup.
- Actual service HTTP tests cover repeated conditional refresh, stop/restart,
  retained ETag, active-request stop and no late application. Python real HTTP
  tests cover the same lifecycle, observable failure and invalid/synchronous start.
- Full TS SDK suite: 72 tests; service baseline: 10 tests; actual HTTP/SQLite
  native suite: 16 tests. SDK/service typechecks and SDK build pass.
- Python 3.9 source suite and fresh installed Python 3.12.12 wheel with the
  config extra each pass all 74 tests. Installed tests run outside the source tree.
- Fresh npm tarballs pass signed HTTP publication, verified SDK refresh, background
  lifecycle and strict declaration consumption without skipLibCheck or peer bypass.
- Actual Chrome 154.0.8037.58 passes WebCrypto verification, conditional 304,
  allowed/blocked CORS, ambient-cookie omission, invalid-response preservation,
  deadlines and scheduled-refresh stop.
- Both SDKs recheck a monotonic deadline before applying a downloaded snapshot,
  including when synchronous work delayed the timeout callback. Late fetch responses
  after cancellation have their bodies cancelled rather than retaining a reader.

## Remaining original requirements

Durable client caches, monotonic signed revision/freshness/rollback policy, key
rotation/revocation administration, jitter/fleet/load acceptance, cross-browser
and hosted HTTPS acceptance, WatchFn exposure delivery, flag UI/hooks, owner/tag
administration, broader segment/operator parity and all other original UserFn
requirements remain open. Background scheduling is not exposure delivery or a
claim of complete platform readiness.

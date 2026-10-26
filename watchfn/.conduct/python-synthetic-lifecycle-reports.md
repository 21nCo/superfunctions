# Python HTTP synthetic lifecycle and reports

Original source: WatchFn SPEC.md section4, HTTP/API monitoring and reports (lines645–731). Baseline46758eaef has no Python `watch.synthetics` facade; executing that exact client source confirmed `AttributeError`. This checkpoint adds Python execution/reporting parity with the existing TypeScript `scheduler.ts`, `http-check.ts` and `reports.ts`, rather than the unused legacy monitor placeholders.

## Public behavior

`watch.synthetics.create({...})` uses the same serialized check options and result fields as TypeScript. Python report method names are `get_uptime`, `get_incidents` and `get_performance_trend`. Options retain `checkId`, `timeRange`, `responseTime` and other canonical field names. Execution requires the optional `watchfn[synthetics]` extra, reusing HTTPX and LogFn's shared default redactor. Importing WatchFn and reading stored reports do not require these execution dependencies.

Check definitions are detached snapshots, capped at100 per scheduler and owned by one process. The first run starts immediately; later runs wait the interval after completion, so an individual check never overlaps itself. Intervals accept integer milliseconds or `ms/s/m/h/d` strings, 10ms through2147483647ms. Retries are0–5 and produce one final result per run. Each attempt has one deadline covering connection, response headers and streamed decoded-body consumption (default5s, maximum300s). The retained response cap defaults to1MiB and cannot exceed16MiB. Input URL and aggregate headers are bounded. HTTPX uses no ambient proxy settings.

Status, response time, body and header assertions match the existing operators. Response bodies are never persisted. Stored response headers use the shared redactor; failures expose fixed messages and assertion kind/operator rather than body values, credentials or arbitrary network error strings. A completed result includes canonical application identity, check/run identity, attempts, durations and capture timestamp and is committed through existing WatchFn storage.

One owned asyncio-loop thread serves the scheduler. Stop closes admission, cancels attempts/timers, joins all tasks and closes the thread before WatchFn closes storage. Concurrent scheduler stops are serialized. Stop from the scheduler's storage callback is rejected during the initial preflight before any WatchFn subsystem is partially stopped. A failed result write stops that check from rescheduling, and WatchFn completes teardown before surfacing the persistence failure. A failed thread start closes its unstarted loop and leaves no reserved check. No task/thread is detached to manufacture a successful shutdown. Arbitrary blocking host storage callbacks and operating-system resolver cleanup remain real joins, not a claimed universal shutdown deadline.

## Stored reports

Reports consume retained canonical `synthetics.check` observations, not a scheduler's local check map, so an independent database client can report after reopen. Application identity is enforced; relevant legacy unowned rows require explicit migration. Run IDs deduplicate identical observations and reject conflicting payloads. Canonical envelope timestamps define windows and ordering; conflicting simultaneous outcomes fail explicitly.

Uptime is successful completed checks divided by all observed completed checks, with null for no data. It is not a time-weighted availability or an assumption that missing checks succeeded. Incidents describe observed failure sequences, include preceding retained history and mark left-censored first failures. Performance reports provide fixed bounded buckets and nullable averages/min/max for empty buckets. The retained snapshot is capped at10000 observations,64KiB per event and16MiB total; buckets are capped at10000. Python currently materializes the storage snapshot before its cap checks, unlike TypeScript's streaming scan; this does not claim a hard preallocation memory quota or identical scanning costs.

Browser execution, multiple locations, consecutive-failure alert configuration, persistent check definitions and restart ownership remain unimplemented and are explicitly rejected or documented. Their original requirements remain in scope. This checkpoint adds no external provider acceptance, automatic deployment or global readiness claim.

## Acceptance

Final results follow below. Focused fixtures use owned loopback HTTP and SQLite, including retries, immutable input, sensitive headers, stalled bodies, body limits, stop cancellation, nonoverlap, concurrent stop, failed thread creation, storage errors, reentrant shutdown, duplicate/conflicting runs and independent database reopen. The existing installed bilateral fixture schedules an actual TypeScript HTTP check and reads its persisted uptime/incidents/performance through the freshly installed Python package. Base-only wheel acceptance reads reports with HTTPX absent.

Final October26 results on the scoped source:

- Normal Python package CI built wheel/sdist and passed338 tests (34.10s). Existing package configuration has no additional Ruff/mypy gate; none is claimed.
- Fresh seven-wheel installation passed the same338 copied tests (35.55s), with site-packages imports verified. All nine new synthetic tests passed within these complete runs.
- A separate clean base installation verified stored goals and synthetic reports with `httpx` absent. Full execution extras were normally installed for the HTTP fixtures.
- Fresh normally installed TypeScript packages scheduled a real owned loopback HTTP check into shared SQLite; the installed Python package independently returned100% completed-check uptime, no incidents and one response-time sample. Existing bilateral goal/funnel vectors remained green. TypeScript runtime was unchanged; its preceding398-test/types/build/package evidence is not relabeled as a new source rerun.
- Local receipts: `/tmp/watch-python-synthetics-ci.log`, `/tmp/watch-python-synthetics-wheels.log`; initial focused5 and expanded7 receipts are `/tmp/watch-python-synthetics-focused.log` and `focused2.log`. Final full runs include the later nonoverlap and failed-thread-start regressions.
- Owned HTTP servers, scheduler threads, SQLite connections, npm consumers and wheel environments were closed/removed. No external provider requests, user browser/profile changes, deployment or release occurred. These are local installed-consumer results, not full provider/database/OS acceptance.

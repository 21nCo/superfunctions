# LogFn production readiness

Branch `codex/logfn-readiness-sf-next-20261018` starts at sf-next/next b21477fc9. Main next checkout is unchanged. Original specification remains authoritative; this checkpoint is not readiness completion.

## Verified ingestion checkpoint

The former WatchFn handler discarded batches while returning 202. It now awaits an injected `ingest(events, request)` callback and returns 503 when unconfigured or when the callback rejects. It never exposes storage/authentication error details. Async authentication is awaited before parsing; unsupported methods return405. Body reading enforces an8MiB default UTF-8 bound, and strict event validation rejects invalid levels/timestamps/context/tags/identifier types before any batch write. The README documents migration and partial-write/idempotency responsibilities.

Clean scoped npm10 ci against the target lock succeeded. Core158tests pass (including HTTP+fsync persistence and transient storage failure), source typecheck and build pass. No root lock changes. Python code was inspected but has not been modified or validated in this checkpoint.

## Remaining requirements

- HTTP sink durable browser offline buffering, lifecycle cleanup and overflow metrics remain incomplete.
- Python generic async sink task ownership/shutdown and full cross-language parity remain to be verified; HTTP delivery was repaired in the checkpoint below.
- Core serialization lacks cycle safety and reliable UTF-8 per-event size enforcement; check pipeline redaction, correlation IDs, sampling, shutdown and concurrent sinks against spec.
- Integrate ingestion/middleware with shared HTTP abstractions per original spec and repository instructions; retain function-specific behavior without duplicating shared adapters.
- Admin dispatcher validation, framework actual-server acceptance, browser lifecycle/offline persistence, packed imports/declarations, version/runtime matrix, audit and informational benchmarks remain.
- Original spec names unscoped logfn while current manifest uses @logfn/core. Verify package ownership/compatibility before choosing migration; do not silently rename.
- No PR, publication, deployment or production readiness is claimed. Future PR targets sf-next, never origin for this function.

## HTTP transport checkpoint

Concurrent explicit flush callers now wait for the active queue drain. Each request honors the configured batch bound; arrivals during a send are drained afterward. Network/timeout/408/429/5xx retries use fresh per-attempt abort controllers, bounded exponential backoff, and finite attempts. Other4xx terminate the current send immediately. Explicit failure rejects while retaining queued events; background failure reports internally. Queue overflow retains the existing newest-events policy.

166core tests pass, source typecheck/build pass. Tests cover joining automatic sends, arrivals during delivery, retained failures, permanent/transient HTTP status differences, per-attempt timeout signals, batch bounds and actual HTTP sink-to-ingest-to-fsynced-file delivery. Browser IndexedDB persistence and lifecycle behavior are still open and are not proven by these Node checks.

## Python HTTP delivery checkpoint

The Python HTTP sink now sends the ingestion envelope, bounds batches and queued events, implements interval delivery, checks response statuses, retries transport/timeouts/408/429/5xx with bounded attempts, and retains failed or cancelled batches subject to the documented newest-events queue limit. Concurrent flush calls serialize delivery. Explicit flush and close propagate failure; a failed close remains retryable. Caller-owned HTTP clients remain open. Logger.flush no longer suppresses delivery errors.

Source tests pass on Python3.9 and3.12 (18 each). A freshly built wheel installed into an isolated Python3.12 environment passes all18 tests. Strict mypy1.18.2 checks the changed sinks module on Python3.9. The HTTP cases use httpx MockTransport; these checks do not prove real-server integration, browser durability, full-package typing or generic async sink shutdown. No full readiness claim.

## Python asynchronous sink ownership

Parent and child loggers now share tracked async sink calls, including returned Futures. Flush waits for accepted deliveries before sink flush hooks, runs all hooks even when one fails, and reports completed background failures. Cancellation of a flush waiter leaves accepted sink tasks running. No-event-loop coroutine creation is closed and reported instead of leaked.

Python3.9 and3.12 each pass23 tests; a fresh installed Python3.12 wheel also passes23. Strict mypy1.18.2 validates the changed core module. Four deterministic concurrency regressions cover parent/child delivery ownership, completed failure reporting, flush-waiter cancellation and Future-returning sinks. A real local HTTP server verifies envelope/authentication,503 retry and owned-client close. This addresses the generic async delivery join gap; remaining fullspec/browser/sharedHTTP/serialization gates above still apply.

## Serialization and UTF-8 event bounds

TypeScript sanitizer now handles cycles, deep nesting, throwing getters, invalid dates and literal prototype keys without corrupting output. Additional event fields are sanitized as well as context. Size enforcement measures UTF-8 JSON bytes, preserves complete context entries that fit, and bounds oversized envelope metadata/messages with a truncation marker. Five regressions plus the existing suite pass (171core tests); source typecheck/build pass. Python serialization parity and pipeline security remain separate open gates.

## TypeScript async delivery and cyclic redaction

TypeScript parent/child loggers share async sink tracking; flush joins delivery before hooks, awaits all hooks even when another fails synchronously, and reports a completed background rejection. Cyclic context is sanitized before redaction, preserving literal prototype keys without prototype mutation; cycles no longer cause a skipped redaction stage and raw secret delivery.175coretests, source typecheck and build pass. Includes three deterministic async ownership/failure regressions and a real logger-to-sink cyclic secret regression. Other spec gates above remain open.

## Server preset and signal shutdown

The server preset now installs its HTTP sink when url is supplied. Signal handlers no longer enqueue a success event after final flush, and failed delivery exits1 instead of0.179coretests/typecheck/build pass. New tests cover actualHTTPpresetdelivery, both signals, repeated-handler suppression, listenercleanup and failureexitstatus. Separate real Node subprocess probes send actual SIGTERM/SIGINT and verify both queued events reach a file before exit0. Other fullspec requirements remain open.

## Error callback API

LoggerOptions now exposes the previously documented onError callback, inherited by children. Pipeline, synchronous/asynchronous sink delivery and flush failures report through it; throwing or synchronous recursive callbacks do not escape logging. Explicitflush still rejects.183coretests/typecheck/buildpass, including four new callback regressions. Browser/offline/sharedHTTP/admin/Pythonparity/fullcontract gates remain.

## HTTP lifecycle cleanup and authenticated unload

HttpSink.close drains and removes owned timers/listeners, rejects future enqueue, joins concurrent closes and remains retryable after deliveryfailure. Visibility listeners now attach to document. Auth/customheaders stay on keepalivefetch rather than headerlessbeacons. Publicbeacons are bounded to60000bytes/batchsize, preservequeueddata untilconfirmedHTTPdelivery and fallbackwhenrejected.189coretests/typecheck/buildpass, including six event-target lifecycle regressions. These tests simulate browser targets; actual browserunload/IndexedDBdurability remain open, and no durability claim is made.

## Durable IndexedDB HTTP queue

Implemented transactional per-queue persistence, exact-ID acknowledgement, newest-events bounds, stable non-secret authenticated queue keys, automatic recovery and explicit unavailable-storage failure. Sink enqueue returns persistence completion and Loggerflush joins it. At-least-once delivery/eviction/identity-isolation responsibilities documented. Memorymode unchanged. Testdependency fake-indexeddb added with standardnpm11lock regeneration; clean scopednpm10ci327 passes.

Fullcore195tests/typecheck/build pass before final rollbacktest; focusedIndexedDB7tests pass including atomic transactionrollback, reopen/isolation, concurrentenqueue/exactack, HTTPfailure-retention, authenticatedrecovery and batchthreshold. ActualChrome154.0.8037.58 persistent-profile processrestart script passes:503retained, browserclosed/reopened, eventdelivered, nextreloadempty. Tempbrowserprofile removed. Firefox/nativeSafari/quota/private-mode behavior and remaining fullspec/admin/sharedHTTP/Pythonparity/performance gates are still open. No fullreadiness claim.

## Packed core and trace-context validation

Fresh isolated core tarball consumers pass ESM realHTTP/redaction/shutdown and dynamicCJS onNode18.17.0/20.19.0/22.23.3, strictNode16/NodeNext declaration checks and runtimeaudit0. Consumer installs onlycoretarball; compiler comes from developmentcheckout. Pack excludes testfiles. Reproducible helper logfn/scripts/packed-core-acceptance.mjs removes its temporaryconsumer.

Traceparser now rejects nonhex/uppercase/zero IDs, malformedflags,ffversion,v00extensions and trailingnewline; additivefutureversions retainknownfields. withRequestIds fills missing IDs without overwriting supplied ones. Based on W3CTraceContext3.2.2/3.2.4 https://www.w3.org/TR/trace-context/ .210coretests/typecheck/buildpass and latestpackedchecksabove pass. Complete framework/admin/packageownership/Pythonparity/performance gates remain open.

## Framework request logging

Fixed default secret-header redaction being disabled by adapter/customlists. Fastify preserves native request.log, exposes typed request.logfn, registers hooks in caller scope, and captures parsed body at preHandler.213coretests/typecheck/buildpass. New ExpressactualHTTP, Fastifyinject and HonoRequest tests verify secretredaction; Fastify additionallychecks native loggerchild/body/LogFn attachment. Remaining middleware sampling/correlationtoplevel/completion/boundedbody and sharedHTTP integration gates still need verification.


## Request correlation and sampling

All three framework adapters now attach trace, span, request, user and tenant identifiers to the event envelope through inherited child correlation. Automatic info-level start/completion events use one sampling decision per request; invalid rates fail at middleware setup. Sampled-out requests retain their application logger. Express observes finish/close once, distinguishes aborted responses, and leaves response.end unchanged.

The full core suite passed220 tests with typecheck/build; the final focused framework suite passed11 tests after adding parent/child correlation isolation and captured identity assertions. Existing actual Express HTTP, Fastify inject and Hono request checks cover the adapters. This does not prove all failure/streaming/body-limit cases; those and the broader sharedHTTP/admin/Python parity gates remain open.


## Captured body serialization

Parsed body capture now uses the shared LogFn sanitizer before serialization, preserving false/zero/empty values and safely representing cycles and unsupported values. Its bound measures UTF-8 JSON bytes including truncation metadata, with previews cut at Unicode code points.224 core tests, source typecheck and build pass, including multibyte, escaped text, circular objects and false/zero cases. Hono still reads a complete cloned request body before truncation; bounded streaming capture remains open.


## Bounded Hono stream capture

Hono now reads at most8192 bytes from a cloned request branch with a100ms default configurable deadline. It does not drain the remainder to compute a total size; prefix metadata distinguishes captured bytes from total bytes. Unavailable/timed-out capture yields an omission marker, and cancellation is not awaited because the original application branch must remain consumable. Runtime transport buffering and individual source chunk allocation remain outside this helper's bound.

13 framework contract tests pass, including a large multibyte body consumed intact by the actual Hono route and a stalled body that still allows the route to respond. Typecheck/build pass. Prior full224 core tests predate this change; the focused suite validates this change. Shared HTTP integration, admin, Python parity and remaining original readiness gates are still open.


## Python nested redaction and safe sink values

Python redaction now traverses nested lists/dictionaries after cycle-safe sanitization. Selected keys retain top-level selection semantics with recursive processing beneath each selected root. Logger sanitizes final events after pipeline execution so custom stages cannot accidentally leave cycles, dates, non-finite floats or unsupported objects for HTTP serialization. Source input is preserved; deep structures use a64-level marker.

27 tests pass on Python3.9 and3.12 and against a fresh installed Python3.12 wheel, including nested secret/cycle/nonmutation, selected roots, post-pipeline values and deep/shared structures. Full64KiB event bounds, middleware and remaining Python parity are still open. Initial typing command used3.12 dependencies with a3.9 target and stopped in AnyIO's pattern-matching syntax; strict mypy1.18.2 subsequently passes all three changed modules in an actual Python3.9 environment.


## Python event size and tags

Logger now sanitizes and bounds events before sink delivery, caps tags at20, preserves whole context entries that fit and marks truncation. Oversized optional envelope fields are dropped before required text is shortened at Unicode code-point boundaries. Size uses the standard escaped JSON representation, conservatively covering compact UTF-8 HTTP payloads. Context budgeting adds per-entry encoded costs rather than repeatedly serializing the growing context.

30 tests pass on Python3.9 and3.12, plus a fresh Python3.12 wheel. Strict mypy1.18.2 passes the two changed source modules. Tests include oversized Unicode message/name/context, small context preservation, source nonmutation and tag count. Other Python framework/sharedHTTP/correlation/error-callback parity requirements remain open.


## Default request logger and ingress contract

Express, Fastify and Hono now use request children from a lazy shared console root when no application logger is configured. Automatic logging and attached request loggers therefore satisfy the original optional-logger contract. Watch ingestion checks the supported schema version and individual64KiB UTF-8 event limit before invoking ingestion; invalid batches cause no partial callback delivery. Existing missing-field errors retain precedence.

229 core tests, typecheck and build pass. Tests exercise default logging in all three frameworks and mixed valid/invalid batches for version/size rejection. Shared HTTP abstractions, target shared dependency integration, admin and remaining full-spec runtime/Python/performance gates remain open.


## Shared HTTP ingestion router

Merged shared prerequisite745ea7b3c (merge8bc518abb) and regenerated the conflicted lock from merged manifests. watchLogsRouter now uses the shared HTTP router contract, configurable mounting, route metadata,404/405 dispatch, existing authentication and awaited persistence. Framework adapters remain consumer-owned. HTTP peer and dev dependencies both target0.3.1; the first test exposed a stale nested0.1.3 development package, now removed from the lock.

Clean scoped npm10 ci installs329 packages; actual module resolution points to local packages/http/dist. Shared observability/HTTP builds and LogFn typecheck/build pass.231 core,66 shared HTTP and8 observability tests pass. Fresh tarball consumer verifies shared router delivery/method handling on exactNode18.18.0,20.19.0 and22.23.3; strictNode16/NodeNext declarations and runtime audit0 pass. Reproducible script logfn/scripts/packed-http-acceptance.mjs removes its temporary consumer.

Shared request-logging middleware, admin dependency/runtime integration and other original Python/browser/performance gates remain open. No full-readiness or LogFn PR claim.


## Shared request middleware

New http/shared subpath exports requestLogger as a shared HTTP Middleware with typed optional context.log. It uses existing correlation, default root, header redaction, sampling and bounded body helpers. Automatic completion records the router's final response, including configured error responses; application logs retain correlation when automatic request sampling is disabled. Framework adapters stay external consumer dependencies. Existing direct Express/Fastify/Hono adapters remain compatibility entrypoints.

Three focused real-router tests, core typecheck/build pass. Fresh tarball consumer verifies middleware export, correlated start/completion and ingestion on exactNode18.18.0/20.19.0/22.23.3; strictNode16/NodeNext declarations and runtime audit0 pass. The prior full231 core tests predate this new subpath. Admin, remaining Python middleware/error parity, browser and performance gates remain open.


## Admin dependency and dispatcher validation (2026-10-20)

Aligned LogFn admin to shared admin 0.1.5 and its Node >=20 runtime floor, removing stale nested dependency entries through lock regeneration. Clean scoped npm10 ci installed419 packages; MCP/shared admin/core/admin builds and admin typecheck pass. ESM resolution confirms the local shared admin package.

Six LogFn admin tests pass, including real dispatcher validation/permissions, namespace rejection before delivery, spoofed actor replacement, audit-context redaction and failed flush acknowledgment.234 core and109 shared admin tests pass after the dependency change. Added usage documentation distinguishing dispatcher authorization from trusted adapter calls and emission acknowledgment from durable flush.

Packed admin consumers and full WatchFn host composition are not yet validated. Python middleware/error parity, browser/performance and other original readiness gates remain open. This checkpoint was completed with only the main agent active.


## Packed admin boundary (2026-10-20)

Fresh independent tarballs for MCP/shared admin/LogFn core/admin pass strict Node16/NodeNext declarations, ESM dispatcher emission and flush, dynamic CJS imports and runtime audit with zero findings on exact Node20.0.0 and22.23.3. The reproducible packed-admin-acceptance.mjs helper removes its temporary consumer.

The first packed flush failed the dispatcher's idempotency-key precondition. This exposed a weakness in the preceding failure test: a negative result alone did not prove the rejecting sink ran. Corrected source test supplies an idempotency store/key and asserts the sink flush was called; all six admin tests pass. Documentation now states the key/store requirement. This supersedes the earlier unsupported implication that the previous negative test proved sink failure propagation.

Actual WatchFn host composition, Python middleware/error parity and original browser/performance gates remain open; no full readiness claim.

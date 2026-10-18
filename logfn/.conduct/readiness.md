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

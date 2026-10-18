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

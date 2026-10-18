# LogFn production readiness

Branch `codex/logfn-readiness-sf-next-20261018` starts at sf-next/next b21477fc9. Main next checkout is unchanged. Original specification remains authoritative; this checkpoint is not readiness completion.

## Verified ingestion checkpoint

The former WatchFn handler discarded batches while returning 202. It now awaits an injected `ingest(events, request)` callback and returns 503 when unconfigured or when the callback rejects. It never exposes storage/authentication error details. Async authentication is awaited before parsing; unsupported methods return405. Body reading enforces an8MiB default UTF-8 bound, and strict event validation rejects invalid levels/timestamps/context/tags/identifier types before any batch write. The README documents migration and partial-write/idempotency responsibilities.

Clean scoped npm10 ci against the target lock succeeded. Core158tests pass (including HTTP+fsync persistence and transient storage failure), source typecheck and build pass. No root lock changes. Python code was inspected but has not been modified or validated in this checkpoint.

## Remaining requirements

- HTTP sink flush currently returns before an existing send completes; per-attempt timeout/retry, terminal4xx classification, durable browser offline buffering and lifecycle cleanup need completion.
- Python HTTP sink sends an array rather than the ingest envelope, ignores non-success statuses, drops failed events, and does not implement its flush interval. Fix and validate existing Python promises despite future full-parity roadmap.
- Core serialization lacks cycle safety and reliable UTF-8 per-event size enforcement; check pipeline redaction, correlation IDs, sampling, shutdown and concurrent sinks against spec.
- Integrate ingestion/middleware with shared HTTP abstractions per original spec and repository instructions; retain function-specific behavior without duplicating shared adapters.
- Admin dispatcher validation, framework actual-server acceptance, browser lifecycle/offline persistence, packed imports/declarations, version/runtime matrix, audit and informational benchmarks remain.
- Original spec names unscoped logfn while current manifest uses @logfn/core. Verify package ownership/compatibility before choosing migration; do not silently rename.
- No PR, publication, deployment or production readiness is claimed. Future PR targets sf-next, never origin for this function.

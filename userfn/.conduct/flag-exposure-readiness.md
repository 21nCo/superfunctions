# Flag exposure delivery

2026-10-20. Implements the original flag exposure requirement using selected
branch provenance and actual Watch ingestion. Both SDKs preserve their synchronous
flag-value API. Configuration is opt-in and separate from the UserFn service key.

The evaluator carries value, variation ID, rule ID and reason from the selected
branch through prerequisite resolution; it never infers IDs by comparing values.
Only the requested public flag emits. Constructor bootstrap values have a distinct
reason until a successful definition replacement. Unavailable flags use the caller
fallback with null IDs. Returned configured JSON values remain isolated copies.

TypeScript uses the current `@watchfn/browser` capture/flush implementation with
`autoTrack:false`, no sampling and no automatic retry loop. Python supplies a
bounded direct HTTP transport via optional `httpx`; synchronous evaluation only
enqueues and explicit async flush performs delivery. Both use canonical Watch
track envelopes, stable UUID event identities, fixed error messages, bounded
queue/event/batch size and request deadlines. No flag values, traits or credentials
are included in event properties. HTTPS is default; local HTTP requires opt-in.

Delivery failures retain queued events. Overflow and oversized captures count as
dropped without changing the flag result, and the next explicit flush reports
rejected captures once. Close fences capture immediately while draining; failed
close/flush can be retried. Neither queue is durable. Ordinary Watch event ingestion
is at least once; ambiguous response loss can cause duplicate stored rows even
though retry preserves the event ID.

## Validation

Focused provenance and transport tests cover equal-valued variations, prerequisite
root-only events, environment/default/bootstrap/unavailable branches, full queues,
oversized metadata, failure retention, stable identity, close and coalesced flush.
Actual built Watch HTTP/SQLite/browser acceptance is recorded separately in
`exposure-acceptance-readiness.md`. The full TS SDK suite passes 77 tests;
Python 3.9 source and fresh installed
Python 3.12.12 wheel with config/exposures extras each pass 79 tests. A core-only
fresh wheel imports and evaluates without optional HTTP/crypto dependencies.
SDK typecheck/build pass; service native HTTP/SQLite suite passes 16 tests after
the Watch merge. Fresh npm tarballs include the actual Watch browser package;
installed ESM/CJS HTTP exposure runtime, signed config/scheduler runtime and
strict ESM/CJS declarations pass
without peer bypass or skipLibCheck. The reused Watch browser package passes
its 30 tests; the UserFn service baseline passes 10 tests and its typecheck.

## Remaining original requirements

Watch credentials are not tenant-scoped or ingestion-only; deployment needs a
trusted proxy or appropriate isolation. Durable offline exposure storage,
exactly-once ingestion, consent/privacy administration and fleet/load evidence
remain open. Exposure delivery does not implement messaging/survey delivery,
UI/hooks, owner/tag administration, durable config caches, key revocation,
monotonic config rollback policy or all original UserFn requirements.

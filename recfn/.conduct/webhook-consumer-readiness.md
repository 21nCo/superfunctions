# RecFn shared webhook consumer — 2026-10-19

The RecFn delivery wrappers now accept shared `WebhookDeliveryOptions`. The obsolete custom `fetch` option is removed. Retry/backoff, per-attempt deadlines, and optional hostname resolution pass through to the shared package; the existing three-attempt and one-second initial-delay defaults are retained. The shared package remains responsible for public-address checks, pinned Undici connections, signing, redirect handling, and retries. No shared transport code was changed.

Callers must remove `fetch` injection. Use the documented shared options for delivery policy. A custom resolver cannot allow private-address targets; its results still pass the shared validator. Namespace fan-out and metrics behavior remain unchanged.

Validation:

- `npm run build -w @recfn/server`: passed.
- `npm test -w @recfn/server`: **214 tests passed across all 39 files**.
- Webhook/participant tests use the actual shared implementation and real Undici Agent construction, mocking only Undici fetch; participant tests replace DNS answers at Node's Resolver boundary. Test aliases select the shared source and the same installed Undici copy so the mock intercepts the intended transport.
- Assertions cover HMAC content, lifecycle/participant payloads, retries after HTTP failure, dispatcher's presence, manual redirects, unique event IDs, unsigned delivery, and policy forwarding.
- New negative acceptance covers IPv4/IPv6 loopback and a mixed public/private DNS answer; all fail before transport. A hanging resolver is aborted by the configured validation deadline without transport calls.

This closes the full-build and five webhook-test gates recorded in `persistence-readiness.md`. The test transport is mocked: this is not evidence of live DNS, TLS, external endpoint delivery, or production webhook reliability. Other persistence/deployment limitations from that document remain.

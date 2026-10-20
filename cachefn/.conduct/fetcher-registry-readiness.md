# Bounded refresh callback retention

2026-10-20 UTC. Object-form `getOrFetch` and cache-first reads previously retained every fetcher closure indefinitely, independently of entry capacity or expiration. A cache limited to one entry could retain thousands of callbacks, and disposal did not release them.

Refresh registration now uses a finite LRU limit through `maxRegisteredFetchers` (default 1000, independent of `maxSize`). Explicit reads and callback replacements touch recency. When the limit is reached, the oldest callback registration is released; the normal read still runs successfully. Zero disables registration retention. Negative, fractional, nonfinite and unsafe-integer limits reject during construction before resources are initialized.

This is an intentional retention change: refresh only covers the bounded retained working set. Applications needing more than 1000 registered keys must configure a larger finite limit or re-request keys as needed. Entry deletion/invalidation still preserves retained registrations, as the existing refresh contract requires. Registry eviction never deletes cached values or durable queued jobs. Coupling this limit to `maxSize` was avoided because zero entry capacity remains useful for offline/refresh workflows.

`unregisterFetcher(key)` explicitly releases a callback without changing its value, pending caller-owned request, or queued writes. A later qualifying read registers it again. `dispose()` clears the registry; later reads preserve their existing one-shot behavior without re-registering or caching late results.

Refresh traversals snapshot keys rather than callback objects, and re-read the live registration after waiting for a pending request. Unregistered or evicted callbacks are skipped, replacement callbacks are current when invoked, and newly added keys wait for a subsequent traversal. Background refresh does not change LRU recency. Already-running requests can finish; this API does not cancel a remote operation or reclaim a closure still owned by active work.

## Validation

- 16 dedicated registry cases pass: the 1000-entry default with zero storage capacity, request/replacement LRU order, zero retention, unregistered function overload, invalidation/re-registration, callback additions/removals/eviction during refresh, waiting pending requests, disposal, offline queue independence, and invalid limits.
- Combined TypeScript suite: 247 tests pass, including offline queue/refresh and priority invalidation regressions.
- Typecheck and schema type tests pass, including valid and invalid schema keys for `unregisterFetcher`.
- ESM/CommonJS/declaration builds pass.

Python `get_or_fetch` retains only active work and has no refresh/offline callback registry or matching API. No Python behavior was changed or parity claimed. This correction bounds retained callback count, not bytes captured by each callback, outstanding caller-owned operations, durable queue contents, or total application memory. It supersedes the registry lifecycle concern recorded in `priority-clear-readiness.md`; other readiness gates are independent.

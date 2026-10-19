# Browser delivery checkpoint — 2026-10-20

BrowserClient now exposes awaited `flush()` and `close()` while retaining `init`, `track`, and automatic delivery. Concurrent flush calls share one promise. A batch remains in the queue until fetch returns a successful HTTP status; failures reject flush and are surfaced through `onError` (or console.error for automatic attempts). Failure does not recursively restart an unbounded delivery loop. Explicit flush/close or later tracking can retry retained data.

Delivery retries network failures, timeouts, HTTP 408/429 and HTTP 5xx, with a configurable bounded attempt count, exponential delay, and per-attempt AbortController deadline. Other HTTP failures reject immediately and retain the batch. Headers and API keys accept callbacks so an application can refresh credentials before retrying. Header callbacks run each attempt. API keys use the Authorization Bearer scheme. `close()` stops collection, disconnects owned PerformanceObservers, and awaits delivery; a failed close can be retried but new tracking is rejected.

The bounded queue defaults to 1,000 events, including in-flight events. Explicit tracking throws on overflow, invalid/cyclic data, or an event above 64 KiB UTF-8; already accepted events are retained. RUM collection surfaces such failures through the error callback. Events are serialized at enqueue time to prevent caller mutation during asynchronous delivery. Batches are bounded by event count (default 100, maximum 500) and 1 MiB UTF-8. Fetch keepalive is omitted to avoid silently exceeding the browser's aggregate 64 KiB keepalive quota. Explicit sampleRate is validated and honored.

## Validation

- 12 unit tests pass using fetch/Response/Headers interfaces: concurrent flush and arrivals, immutable queued payloads, transient statuses, network retry exhaustion, terminal 401, auth refresh, timeout abort, queue overflow, retryable close, observer disconnection, callback isolation, byte limits and sampling.
- CJS/ESM/IIFE builds and declarations pass. Strict TypeScript source checking passes.
- Real Chrome 154.0.8037.58 with an isolated temporary browser context and local HTTP server passes actual fetch 503 retry, 401 retention, refreshed authentication, Unicode payload preservation and awaited close. The server is a controlled ingestion-response fixture; this is not hosted WatchFn deployment evidence.

From `watchfn/agents/browser`, invoke the repository binaries `../../../node_modules/.bin/vitest run --config tests/vitest.config.ts` and `../../../node_modules/.bin/tsup`. Then run `node tests/browser-acceptance.mjs`, setting `PLAYWRIGHT_MODULE` to an installed Playwright module if it is unavailable by package resolution. The existing browser package is not registered as a root npm workspace and its old test script is still a placeholder; package/workspace metadata is managed separately from this change.

## Remaining gates

Retention is in process memory only: reload, page termination, and crashes lose queued data. There is no IndexedDB/offline persistence or unload delivery guarantee. Delivery is at least once; a server that commits before a network error can receive duplicates. Permanent failures retain and block the batch until configuration/server recovery; no discard API is introduced. Retry-After, jitter, cross-tab coordination, tenant authorization, CORS configuration, service worker support, browser compatibility matrix and ingestion throughput remain unverified. Existing simplified RUM metrics are not expanded here. No remote push, PR, release or deployment was performed.

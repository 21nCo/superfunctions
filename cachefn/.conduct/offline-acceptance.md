# Offline-first acceptance — 2026-10-15

Original V0 §7 offline-first API is implemented: `offlineStrategy: 'cache-first'`,
`navigator.onLine` checks, object `getOrFetch({ fetcher, offlineFallback })`, online
`refresh()`, offline update queuing and online synchronization. The callback
getOrFetch signature remains available. Miss fallbacks are not persisted as real
server data; undefined cached values remain valid hits.

The previously unspecified write API is `queueUpdate(key, value, options?)` with
config-level `offlineQueue.sync` for durable delivery. Records have stable IDs,
ordered attempts/status, and serialized values in a separate named/namespaced
backend, independent of cache eviction, TTL, clear, and refresh. Queue bounds
reject rather than discard jobs. Explicit persistent storage errors propagate;
auto caches default their durable queue to explicit IndexedDB. Per-call callbacks
are explicitly ephemeral. See SDK README for full lifecycle/error/conflict rules.

Delivery is FIFO/single-flight within an instance, at least once, with retained
failures blocking later jobs. Server idempotency uses the stable ID. Pending
optimistic writes are protected from refresh, active deliveries cannot be cancelled,
and disposal detaches online listeners/stops new deliveries while allowing an
already-started request to acknowledge. One active delivery owner per named queue
is required; this implementation does not claim a distributed consumer lease.

Checks:
- Full TypeScript suite: 175 tests / 15 files pass, retaining the prior 165 tests.
- Ten offline tests cover fallback/hits, refreshed hits, stale-write suppression,
  durable reconstruction, cache-clear independence, ordered retry attempts,
  concurrent enqueue/sync, bounds/cancellation, namespaced queue isolation,
  serialized snapshots, restored in-flight state, event cleanup, disposal and
  protection of pending optimistic updates.
- Source/schema typechecks and additional schema negative fixtures pass.
- Build, packed ESM/CJS runtime, and NodeNext/Node16 typed consumers pass.
- Native Chrome 154.0.8037.58: 27 assertions pass. Actual Playwright offline/online
  connectivity transitions verify offline writes remain local, durable queue
  reopening, nonpersistent offline placeholders, and automatic reconnect delivery
  followed by registered-fetcher refresh.
- Playwright WebKit 26.0: all 27 assertions pass. This is engine acceptance,
  not a native Safari application/version certification.

The persisted browser acceptance supports `BROWSER_ENGINE=chromium|firefox|webkit`
(default chromium), `PLAYWRIGHT_MODULE_PATH`, and optional
`BROWSER_EXECUTABLE_PATH`. Unsupported `indexedDB.databases()` enumeration is
capability-guarded. Firefox build 1497 could not complete `browserType.launch` on this macOS host,
before navigation or application execution. The owned stalled process was stopped;
a bounded launch retry used a 30-second launch timeout. Browser diagnostics report
`sandbox_extension_issue_file_to_process ... Operation not permitted` and
`RenderCompositorSWGL failed mapping default framebuffer`. Firefox application
acceptance is therefore unvalidated here, not a passing result or an SDK failure.

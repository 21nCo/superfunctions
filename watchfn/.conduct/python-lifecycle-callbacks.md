# Python alert lifecycle callbacks

Durable and memory alert managers expose on_trigger/on_resolve. Listeners run after state changes; durable listeners run after the shared-adapter transaction commits, and memory listeners run outside the evaluation lock. Each listener receives its own public snapshot and context. Durable callbacks receive public dictionaries; memory callbacks receive Alert snapshots. Calculated stored observations carry value and applicable trigger/recovery threshold. Legacy array evaluation preserves implicit recovery without inventing a measured value.

Awaitable listeners run to completion on the owning worker's private event loop. Active-event-loop callers use evaluate_stored_async and durable trigger_async/resolve_async; the legacy memory API also provides evaluate_async/evaluate_all_async. Resources tied to another loop must not be used by callbacks. Synchronous transition methods reject an active event loop when listeners are registered, before changing state. Listener failures attempt other listeners and report a sanitized committed-transition error. Neither reopen nor repeated idempotent transitions replay listeners; durable outbox delivery is separate.

Operation ownership spans state changes and listeners. WatchFn.stop closes new admission, joins admitted work, then closes storage. Nested note writes inherited through asyncio.to_thread remain admitted during drain. Self-shutdown is rejected even across copied async contexts. Listener contexts expire after completion, preventing detached work from retaining admission. Lazy managers on stopped hosts are closed; standalone memory managers remain usable. Memory batch evaluation owns a snapshot of definitions, so registration/removal by a callback cannot invalidate iteration. Async caller cancellation joins its worker before reporting cancellation. Arbitrary callbacks can delay shutdown indefinitely; there is no hard cancellation deadline.

## Validation

- Normal node scripts/ci-run-python-package.mjs watchfn/python passes local dependency installation, wheel/sdist builds and210 tests onPython3.11 (25.38s).
- Fresh six-wheel installation outside the source checkout passes210 tests onPython3.12 (26.70s), with site-packages imports verified and temporary directory cleaned.
- Native SQLite cases cover committed visibility, scalar/recovery context, reentrant note writes, listener isolation/failure, idempotency, reopen without replay, cancellation joining and shutdown before storage close. Memory cases cover lock-free callback reentry, legacy implicit recovery, batch definition changes, stopped-host admission and expired copied contexts.
- Logs: /tmp/watch-callbacks-final-ci.log and /tmp/watch-callbacks-final-wheel.log. Dependency/runtime deprecation warnings remain22 source/103 installed. No failed/skipped tests. TypeScript unchanged in this checkpoint.

Full WatchFn readiness remains incomplete: automatic LogFn ingestion, log pattern detection, public trace/business/synthetic/dashboard gaps, provider/database/browser matrices, original performance/capacity requirements and deployment acceptance remain open.

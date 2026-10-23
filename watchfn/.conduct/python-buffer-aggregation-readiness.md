# Python dependency, buffering and aggregation — 2026-10-23

Hosted CI installed unrelated distribution superfunctions0.1.3 and could not import superfunctions.http. The manifest now requires the actual superfunctions-core distribution. After resolving that import, normal CI reproduced five failing tests: async context execution awaited a synchronous callback result; metric queries omitted overlapping buckets and one aggregation function overwrote another; immediate event queries missed buffered writes.

Python aggregation now follows the existing TypeScript bucket-overlap semantics and retains each (bucket,function) result independently. Time-based tests use deterministic aligned fixtures rather than depending on the current minute boundary. Async context execution supports both immediate and awaitable callback results while preserving token reset.

The batcher keeps all pending events in shared state, serializes delivery with manual flushes, and wakes promptly for shutdown. Stop flushes pending events and permits restart. Failed delivery restores the batch in order; explicit flush/stop propagates the error, while background retries back off. Query flushes admitted events before reading storage. Callbacks may partially persist before failing, so retry can duplicate events; this is not exactly-once delivery. The buffer remains process-local and unbounded, and callback execution is cooperative. Durable buffering, admission quotas, global-context inheritance and broader Python/TypeScript feature parity remain open.

Twenty-one tests pass, including active-delivery/query ordering, stop/restart, failed delivery retention, simultaneous metric functions and bucket boundary exclusion. The original test failures were observed before source fixes. No tests were removed or skipped. The initial local CI attempt lacked the sparse Python core directory; materializing its tracked source restored ordinary workspace dependency resolution. Logs: /tmp/watch-python-oct23-ci-2.log and /tmp/watch-python-oct23-regression-tests.log. Full integrated CI validation follows the shared prerequisite merge; no hosted-green claim.

## Concurrent stop/restart and reversed ranges

Two overlapping stop callers can capture the same worker. If one finishes and a
new worker starts before the other returns from its join, unconditional clearing
of `_thread` loses the replacement's ownership. A deterministic reproduction
observed the late stop return with `_thread=None`, `_stopped=False`, and a live
replacement worker. Stop now clears the reference only if it still identifies
the captured worker. A stop covers that captured generation; a concurrent restart
remains tracked and can be stopped by a subsequent call. No lifecycle lock is held
across delivery callbacks or thread joins.

The regression gates one stop after its join, restarts through the other caller,
and checks that another `start()` cannot create a duplicate worker and that the
replacement is subsequently joined. A second regression verifies an active
delivery callback can call `start()` while another thread is stopping it without
a lifecycle-lock deadlock. Owned test threads terminate on the passing path, and
the failure gates use bounded waits.

The bucket-overlap predicate also admitted reversed ranges such as
`62500..61500` for a bucket beginning at `60000`. The range guard restores the
previous empty-result behavior when `from_time > to_time`, while preserving
inclusive point queries and partial-bucket overlap for valid ranges.

The actual normal Python CI runner passes installation, wheel/sdist build and all
**24 tests** with these corrections. A newly installed wheel, tested outside the
checkout with import readback from `site-packages`, also passes all 24 tests and
`pip check`. The existing 18 Pydantic deprecation warnings remain unsuppressed.
Immediate, custom-awaitable and exception context-reset checks also pass.
These results retain the
process-local, cooperative, at-least-once and remaining parity limits above.

Receipts: `/tmp/watch-generation-focused-oct23.log`,
`/tmp/watch-generation-ci-oct23.log`, and
`/tmp/watch-generation-wheel-tests-oct23.log`. No hosted result or deployment is
claimed by this local checkpoint.

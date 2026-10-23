# Python interval delivery drain

An interval callback previously remained registered as the cancellable timer while it awaited an HTTP send. Explicit flush or close cancelled that task, requeued the active batch and issued a replacement request. A server may already have accepted the first request, so an ordinary drain unnecessarily created duplicate-delivery risk.

After the timer delay, ownership now transfers without an intervening await to the tracked background-delivery task. Explicit drains cancel only a still-sleeping timer and wait through the existing delivery lock. Retry, timeout, explicit task cancellation and retained-failure semantics are unchanged; this is not an exactly-once transport guarantee.

Two controlled transport regressions reproduced cancellation for both flush and close before the change. They now verify that the original request remains active, the drain stays pending, and exactly one request completes after release. The full Python3.12 source suite passes47 tests. A fresh built wheel installed into isolated Python3.9 passes46 tests with one existing interpreter-specific serialization skip. Strict mypy1.18.2 accepts the changed sink module. Existing source and installed suites retain actual loopback HTTP envelope/retry/client-close checks; the new request-ownership regression uses a controlled HTTPX transport, not a deployed server.

Receipts: /tmp/logfn-interval-baseline.log, /tmp/logfn-interval-source.log, /tmp/logfn-interval-installed.log. The exact owned source/wheel validation environment was removed and its absence checked. TypeScript source did not change; native browser matrices, future Python middleware and remaining original requirements remain open.

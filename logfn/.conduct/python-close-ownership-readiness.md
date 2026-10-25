# Python HTTP close ownership

Concurrent close calls previously invoked owned-client shutdown twice. Cancelling one call reset the shared closing flag even while the other call was still closing the transport, allowing new admission during shutdown. Both controlled regressions failed against the preceding implementation.

Close now creates one retained shutdown task, fences admission before scheduling it, and shields it from individual caller cancellation. Concurrent callers join the same task. A completed actual failure permits a later explicit retry; cancellation of a waiter alone does not. A completion callback observes errors even if no waiter remains. Borrowed clients remain caller-owned. The README documents the cancellation contract.

Validation: all49 Python3.12 source tests passed; a fresh built wheel installed into isolated Python3.9 passed48 tests with one existing interpreter-specific serialization skip. Strict mypy1.18.2 passed the changed sink module on both interpreters. New tests use a controlled HTTPX client close gate and verify exactly one close, pending sibling waiter, rejection of admission after caller cancellation, and completed transport closure. Existing actual loopback delivery/retry and close-failure retry tests remain included. No claim of forcibly terminating cancellation-resistant transports or deployed runtime acceptance.

Receipts: /tmp/logfn-close-baseline.log, /tmp/logfn-close-source.log, /tmp/logfn-close-installed.log. The exact owned source/wheel validation directory was removed and its absence verified. TypeScript/Safari work is separate. Remaining original readiness requirements are unchanged.

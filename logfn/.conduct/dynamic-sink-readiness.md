# Dynamic sink attachment

WatchFn's declared logger integration requires a producer attachment contract; the existing LogFn API only accepted sinks at construction. Baseline regressions fail in both TypeScript and Python because attachment methods are absent.

Logger.addSink / Logger.add_sink now register an independent sink across a parent/child logger family, including existing children. Identical callbacks are reference-counted and delivered once while attached. Idempotent detach prevents future admission. A snapshot isolates callback registration changes during an emission. Events still pass the existing filter, serialization and terminal redaction stages; each sink receives an independent copy.

Previously admitted asynchronous deliveries remain owned by family flush even after detach. Both synchronous and asynchronous sink failures are retained for flush while healthy sinks continue. Active buffered sinks receive flush hooks; callers must flush buffering sinks before detaching to drain private buffers. Python registry changes use a shared reentrant lock and identity keys, including unhashable callable objects. General cross-thread async event-loop ownership is unchanged.

Validation so far: 269 TypeScript tests, source types, 81 Python tests, strict mypy across19 files and Ruff pass. Four original missing-method regressions fail in each baseline. Full Python installation resolves shared packages locally because unpublished shared package versions are not available from the registry. A first reused-environment command found the historical environment removed; a first fresh registry-only resolution failed honestly before testing. Fresh local-dependency environment tests passed. Normal CI installation, wheel/sdist build, Ruff, strict mypy and81 tests pass. Fresh tarball strict Node16/NodeNext declarations and actual Node18.17/20.19/22.23 consumers pass, including attached-child redaction/flush/detach; production audit is zero. The existing hardened four-wheel fixture verifies canonical site-packages imports outside the checkout with environment overrides removed:81 Python3.11 tests and strict consumer pass; base-only Python3.9 passes52 tests with2 expected optional/interpreter skips. HTTP extras remain explicitly unavailable on3.9. All disposable consumers are removed.

Additional logs: /tmp/logfn-dynamic-build.log, /tmp/logfn-dynamic-packed.log, /tmp/logfn-dynamic-normal-ci.log, /tmp/logfn-dynamic-wheel.log.

Logs: /tmp/logfn-dynamic-baseline.log, /tmp/logfn-dynamic-baseline-python.log, /tmp/logfn-dynamic-full-ts.log, /tmp/logfn-dynamic-types.log, /tmp/logfn-dynamic-full-python.log, /tmp/logfn-dynamic-python-types.log, /tmp/logfn-dynamic-python-ruff-final.log.

This producer contract does not itself implement WatchFn use(), durable delivery retry or the remaining original LogFn/WatchFn production requirements. Consumer integration and its installed cross-package acceptance remain required.

# Python shared HTTP middleware checkpoint

The original LogFn specification lines28 and144 includes minimal FastAPI/Flask middleware using shared HTTP abstractions. The Python SDK previously had only core/pipelines/sinks. `logfn.http.request_logger()` now returns the existing `superfunctions.http.Middleware` contract; consumers pass it to `Route.middleware`, and use the existing FastAPI/Flask adapters. No HTTP adapter, router, or response serializer is duplicated or reexported.

`get_request_logger()` exposes a ContextVar-scoped child. The same request/context objects reach the handler; nested calls and cancellation restore context. Concurrent requests do not overwrite each other's logger. New tasks inherit Python context snapshots and remain application-owned. Valid W3C trace context follows the TS parser's nonzero/lowercase/version rules; IDs otherwise use secure local randomness. Returned responses receive matching request/trace/span headers even when sampling disables automatic logs. Existing other headers/cookies/body remain intact, original response headers are not mutated, and earlier case-insensitive correlation header values are replaced. Capture callbacks can supply user/tenant identity but cannot override correlation. Default log privacy remains active.

Exceptions, shared HttpError, and cancellation are logged without exception text and propagated unchanged. Framework-owned error conversion remains intact. Returned error Responses receive headers, while responses synthesized outside the middleware after thrown errors do not. Bodies are never read: shared Request currently exposes only fully buffering body methods, so bounded capture remains an original parity gap. No persistent Flask asynchronous delivery loop is introduced; use synchronous sinks with its shared per-request asyncio loop. FastAPI asynchronous sink lifecycle/flush remains host-owned. This covers instrumented shared HTTP routes, not arbitrary native routes, pre-routing errors, WebSockets or full LogFn readiness.

## Packaging and compatibility

Base `logfn` remains Python>=3.9 and does not import optional HTTP code. `logfn[http]` depends on `superfunctions-core>=0.1.1`, whose Python>=3.10 requirement is intentionally preserved: installing the extra on3.9 fails resolution rather than silently omitting its dependency. Framework adapters stay consumer-selected. Development installs add local shared adapter dependencies on3.10+ so normal CI executes real framework tests; `build` is explicit because the normal entry point invokes it. A narrow mypy missing-import exception for optional `superfunctions.*` permits base-only environments; the HTTP module and installed public API were separately strictly checked with the real shared types present. No existing lint/type/test gate was removed.

## Validation

- Source Python3.11:77tests passed (28 new middleware cases); strict source types passed.
- Actual normal `scripts/ci-run-python-package.mjs logfn/python`: local shared dependency closure, wheel+sdist build, Ruff, strict mypy18files and77tests all passed. Initial own test lint/type annotation failures were corrected; final log `/tmp/log-python-http-normal-ci-verified.log`.
- `python3 logfn/scripts/python-http-acceptance.py`: fresh four-wheel isolated consumer; real FastAPI/Flask tests onPython3.11 (77passed), strict installed public Middleware declaration consumer passed. Separate base-only Python3.9 consumer imported/logged without superfunctions installed and passed48tests, with2expected skips (optional HTTP module and existing runtime-specific case). Explicit HTTP-extra dry-run on3.9 rejected the shared3.10 minimum. Log `/tmp/log-python-http-installed.log`.
- Coverage includes native framework200/503 responses; sampled-out application logging; inherited cookies/headers and unchanged body; typed400 and sanitized500 adapter errors; nested/concurrent context, cancellation; W3C vectors; identity privacy and validation. No public server/provider/deployment or browser settings were used.

The wheel acceptance runner uses bounded subprocess timeouts and a TemporaryDirectory, removed on completion. The source-only owned environment `/tmp/logfn-http-python-20261023` was removed after validation. No test processes or services remain. Shared package source, root metadata and ignore rules are unchanged.

## Authoritative installed-import verification

The acceptance helper now removes inherited `PYTHON*`, `PYTEST_*`, `MYPYPATH`,
`VIRTUAL_ENV` and `UV_PROJECT_ENVIRONMENT` overrides from child processes. All
Python verification commands use isolated `-I` mode. Tests and their configuration
are copied into the owned temporary directory outside the source checkout.
Before each environment's tests, the helper asserts that `sys.prefix` equals the
expected fresh environment, and that canonical module file paths are under that
environment's `site-packages`. The HTTP environment checks LogFn, `logfn.http`,
shared core/HTTP, FastAPI adapter and Flask adapter; the base environment checks
LogFn and separately verifies shared core is absent.

The final run used `python3 -I logfn/scripts/python-http-acceptance.py` with
`PYTHONPATH` deliberately pointed at the source SDK and `PYTHONHOME`/`MYPYPATH`
set to nonexistent poison paths. `/tmp/log-python-http-isolated-final.log` records
all canonical imported-wheel paths,77Python3.11 tests, the strict installed API
consumer,48Python3.9 tests/2expected skips, and the expected3.9 HTTP-extra resolver
rejection. All passed. Both fresh environments and copied tests were removed
by TemporaryDirectory cleanup; no runtime package implementation changed.

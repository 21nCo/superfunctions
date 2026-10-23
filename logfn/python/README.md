# logfn-python

Structured logging for Python with pluggable pipelines and transports.

## Features

- **Structured Logging**: JSON-based log events with consistent schema
- **Log Levels**: trace, debug, info, warn, error, fatal
- **Child Loggers**: Create scoped loggers with inherited context
- **Pipeline Stages**: Pluggable event processing (redaction, enrichment, sampling)
- **Multiple Sinks**: Console (pretty/JSON), HTTP (batched with retry)
- **Type Hints**: Fully typed with Python type hints

## Installation

```bash
pip install logfn
```

## Quick Start

```python
from logfn import dev_logger

logger = dev_logger("my-app")

logger.info("Application started", version="1.0.0")
logger.warn("Deprecated API used", api="/old-endpoint")
logger.error("Request failed", status_code=500, path="/api/users")
```

## Basic Usage

### Creating a Logger

```python
from logfn import create_logger, SinkConsole

logger = create_logger(
    name="my-service",
    level="info",
    sinks=[SinkConsole(json=True)],
)

logger.info("User logged in", user_id="123", email="user@example.com")
```

## HTTP delivery and shutdown

`SinkHttp` sends `{ "events": [...] }` batches compatible with the TypeScript
ingestion handler. Synchronous logging enqueues; with a running event loop,
`batch_size` and `flush_interval_ms` trigger background delivery. Without a running
loop, explicitly run `await sink.flush()` before shutdown.

`flush()` joins an active interval-triggered delivery without cancelling or
restarting its request; `close()` uses the same drain behavior. It rejects on failure, retaining unsent
events for retry. `Logger.flush()` propagates sink failures. The sink retries
network/timeouts and HTTP 408/429/5xx with bounded backoff; other unsuccessful
statuses fail immediately. `max_queue` bounds waiting events by discarding oldest
entries on overflow. Each request contains at most `batch_size` events.

Use `await sink.close()` to flush and close its owned HTTP client. Concurrent
callers join one shutdown. Cancelling a caller does not cancel that shutdown or
reopen admission; await `close()` again to observe its completion. If the actual
shutdown fails, the sink becomes available for retry. An injected `client` remains owned by its
caller. Requests can be duplicated after ambiguous network errors, so ingestion
storage should use idempotent writes where duplicates matter.

Async custom sinks may return a coroutine or Future. Parent and child loggers
share delivery tracking: `await logger.flush()` waits for their outstanding
sink calls before running every sink's flush hook. Background delivery failures
are reported by the next flush, after the other sinks have finished flushing.
Cancelling a flush waiter does not cancel these accepted sink calls. Custom
async sinks require a running event loop when logging; `SinkHttp` itself can
also enqueue synchronously and flush later.

## Serialization and nested redaction

Sink events are sanitized after pipeline processing: dates become ISO strings, non-finite floats become null, cycles and unsupported objects become explicit placeholders, and nesting is limited to 64 levels. Application context is not modified by this conversion.

The `redact` stage applies its patterns recursively to strings inside dictionaries and lists. Its optional `keys` selects top-level context fields; all nested values within each selected field are processed. Message redaction remains active. Configure patterns for the secrets your application emits.

Logger events are limited to 64 KiB in the standard escaped JSON representation, which also bounds the compact UTF-8 HTTP representation. Tags are capped at 20 entries. Oversized context retains whole entries that fit and adds `ctx._truncated`; oversized envelope text is shortened at Unicode code-point boundaries. The escaped JSON budget is conservative for non-ASCII text. Custom sinks that add fields or whitespace after delivery must enforce their own resulting wire-size limit.

## Internal error reporting

Pass synchronous `on_error(error, context)` to `Logger` or `create_logger` to observe pipeline, sink delivery and flush failures. Context identifies the stage or sink, with `phase: "flush"` for flush hooks. Children inherit the same callback. Callback exceptions and synchronous recursive reports are isolated so they do not replace the logging outcome. Use a separate reporting channel rather than logging callback failures back into the same sinks.

`flush()` still raises asynchronous delivery or flush failures after all sink hooks settle. Without a callback, internal reports go to stderr. The exported `ErrorHandler` type describes this callback.

### Request correlation

Pass `correlation` to `Logger` or `create_logger` to emit `traceId`, `spanId`,
`requestId`, `userId`, and `tenantId` as top-level event fields. Children inherit
these fields and can override individual values without changing their parent:

```python
request_log = logger.child(correlation={"requestId": "request-123", "userId": "user-7"})
request_log.info("request accepted")
```

Correlation mappings are copied when creating a logger or child. Context fields
remain separate. The `with_request_ids()` pipeline fills missing request IDs
with UUID strings and missing trace IDs with lowercase 32-character hexadecimal
values, preserving supplied IDs. This helper generates IDs per event; pass a
shared request correlation mapping when multiple events belong to one request.

Values that exceed Python's configured integer-to-decimal conversion limit are
replaced with `[unserializable]` during event sanitization. Other context fields
are preserved, the original input is unchanged, and the interpreter's limit is
never disabled or increased.

## Default privacy boundary and migration

Logger factories now apply terminal masking after custom stages and serialization
and before every sink. Known secret keys (password/token/API-key/auth/cookie and
common variants), user/tenant ID keys, credential assignments, bearer/basic text
and email patterns are masked recursively. Quoted JSON credential fields are
covered, but message text need not remain parseable JSON after masking; prefer
structured context. Input objects are not modified by masking, and each sink
receives an independent snapshot within the existing 64 KiB event limit.

Intentional safe exceptions use exact JSON Pointer primitive leaves:

```python
logger = create_logger(
    "service", [SinkConsole(json=True)],
    correlation={"userId": "approved-pseudonymous-id", "tenantId": "private"},
    redaction={"allowlist": ["/userId", "/ctx/publicToken"]},
)
```

`DefaultRedactionOptions` is exported. Policies are copied at construction and
inherited by children. Paths escape literal `/` as `~1` and `~` as `~0`.
Allowlisting an object does not exempt its descendants, and secret containers
remain masked as a whole. Existing `redact` patterns and selected roots continue
to configure their explicit stage, without disabling this terminal boundary.
This is a migration from previously unmasked default output: add only deliberate
safe exceptions. Built-in diagnostic context is masked too; custom `on_error`
callbacks and exceptions propagated by `flush()` remain caller-owned.

Key/value matching is heuristic; arbitrary unlabelled credentials and all PII
cannot be detected. Configure application-specific stages as needed. Direct sink
calls assume already-processed events. This parity checkpoint does not implement
the future v0.2 Python middleware surface or close all original readiness gates.

## Typed custom sinks and development checks

A `Sink` is any callable accepting a list of `LogEvent` values as a positional
argument. Plain functions, bound methods, callable objects, and async callables
are supported. A `flush` hook is optional; when present, the logger calls it and
awaits its result if awaitable. `logger.flush()` also joins accepted async delivery
before completing. Sinks do not need an empty flush method to satisfy the type
contract. The wheel includes `py.typed` for installed-package type checking.

Run checks with the interpreter whose dependencies are installed:

```sh
python -m pip install -e '.[dev]'
python -m ruff check .
python -m mypy .
python -m pytest .
```

Strict mypy checks source and tests. Only generated `build/` and `dist/` copies
are excluded from discovery. Its Python target follows the running interpreter,
so dependencies resolved for Python 3.11 are checked as Python 3.11. Minimum
Python 3.9 support must also be checked in an actual Python 3.9 environment;
a 3.11 pass alone does not establish it. The Ruff and Black targets remain 3.9.
The repository CI currently runs Python 3.11. See
[the Python typing evidence](../.conduct/python-typing-readiness.md) for separate
minimum-version and installed-wheel results.

### Queue overflow metric

`SinkHttp.overflow_evictions` is a read-only cumulative count of queue records
evicted by this instance to retain the newest `max_queue` entries. It includes
enqueue overflow and failed/cancelled-send requeue overflow, and excludes normal
acknowledgements. Poll this value from the host metrics collector; reading it
does not log or enqueue more events. The count resets with a new sink instance
and is not persisted. An evicted in-flight record may already have reached the
receiver, so this counts queue evictions rather than confirmed remote loss.

## Shared HTTP request logging (Python 3.10+)

Install `logfn[http]` and the framework adapter you use (`superfunctions-fastapi`
or `superfunctions-flask`). The base logger still supports Python 3.9 without
HTTP dependencies; the HTTP extra requires Python 3.10 because the shared HTTP
packages do. Importing `logfn` does not import the optional HTTP module.

```python
from logfn import create_logger, SinkConsole
from logfn.http import request_logger, get_request_logger
from superfunctions.http import Route, HttpMethod, Response
from superfunctions_fastapi import create_router  # Flask: create_blueprint

logger = create_logger("api", sinks=[SinkConsole()])

async def handler(request, context):
    request_log = get_request_logger()
    assert request_log is not None
    request_log.info("application event")
    return Response(body={"ok": True})

routes = [Route(method=HttpMethod.GET, path="/", handler=handler,
                middleware=[request_logger(logger=logger, sample=1.0)])]
# FastAPI: app.include_router(create_router(routes))
# Flask: app.register_blueprint(create_blueprint(routes))
```

This uses the shared route executor and adapters, without replacing native
framework request/response machinery. The original request/context objects pass
through unchanged. `get_request_logger()` uses context-local state, supports
nested middleware, and resets after return, exception or cancellation. Tasks
spawned inside a request inherit Python's context snapshot; applications own
those tasks and must not treat the logger as proof a request is still active.

The logger inherits `traceId`, `spanId` and `requestId`. A valid W3C `traceparent`
(or the configured `header`) supplies trace/span IDs; invalid input generates
fresh IDs, and request IDs always come from local secure randomness. Returned
responses receive `x-trace-id`, `x-span-id` and `x-request-id`, matching event IDs
before custom pipeline transformations. These reserved response headers replace
case-insensitive earlier values while other headers, cookies and body remain
unchanged. They are correlation values, not authentication tokens. No W3C flags
or user/tenant identifiers are synthesized into response headers. Hosts own CORS
expose-header configuration.

`sample` is a finite number from 0 to 1, controlling one decision for the
start/completion pair. It never disables the application logger or response IDs.
`redact_headers` adds to the default authorization/cookie/API-key/token redaction.
`capture_user(request)` may supply `userId` and `tenantId`; it cannot override
correlation IDs and existing logger privacy policy still applies. Bodies are
never read or captured. Shared Python Request exposes only a fully buffering
body API; bounded body-capture parity remains open rather than silently buffering
an arbitrary body for logging.

A returned error Response is correlated like any other response. Thrown
exceptions (including shared HttpError) and cancellation propagate unchanged;
LogFn emits a sanitized failure event without exception text and resets context.
Responses subsequently created by the outer framework adapter cannot acquire
these headers through route middleware. LogFn does not replace adapter error
handling or suppress cancellation.

Sink delivery and flush remain owned by the host. FastAPI uses its running
application loop; arrange logger flush/shutdown there for async sinks. The shared
Flask adapter runs each async route in a temporary loop: use synchronous sinks
with this middleware there. This does not provide a persistent async delivery
loop or durable background queue for Flask. Only routes with this middleware are
instrumented; native framework routes, routing failures before it, and WebSocket
routes are outside this shared HTTP contract.

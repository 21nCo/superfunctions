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

`flush()` waits for any active delivery and rejects on failure, retaining unsent
events for retry. `Logger.flush()` propagates sink failures. The sink retries
network/timeouts and HTTP 408/429/5xx with bounded backoff; other unsuccessful
statuses fail immediately. `max_queue` bounds waiting events by discarding oldest
entries on overflow. Each request contains at most `batch_size` events.

Use `await sink.close()` to flush and close its owned HTTP client. Failed close
leaves the sink available for retry. An injected `client` remains owned by its
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

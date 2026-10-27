# logfn (Python)

Structured logging for Python with redaction, enrichment, sampling and bounded
transports. Python 3.10+, no runtime dependencies.

This is the Python half of the reusable LogFn event pipeline on `dev`, ported
from `21nCo/super-functions.next` at `523c66ae8cf981ff8331d56386cec1f81c704182`
(`logfn/python`). It shares its redaction rules with `@logfn/core` through
`tests/conformance/redaction-vectors.json`, a byte-identical copy of
`logfn/typescript/conformance/redaction-vectors.json`.

## Quick start

```python
import asyncio
from logfn import create_logger, enrich_context, redact, sample, SinkHttp

# Without sinks a logger writes to the local console only.
local = create_logger("my-app")

# Remote delivery is always explicit.
http = SinkHttp("https://collector.example.com/ingest", auth_token=token)
logger = create_logger(
    "my-service",
    level="info",
    pipeline=[enrich_context({"service": "billing"}), redact(), sample({"info": 0.1})],
    sinks=[http],
)

logger.error("charge failed", ValueError("card declined"))
asyncio.run(logger.flush())
```

`dev_logger(name)` logs pretty, colored output at `debug`.
`server_logger(name, url=None, level="info")` logs redacted JSON to stdout and
adds an HTTP sink only when `url` is given.

## Logger

- Levels: `trace`, `debug`, `info`, `warn`, `error`, `fatal`. The default is
  `info` when `ENV` (or `NODE_ENV`) is `production`, otherwise `debug`.
- Keyword arguments are merged into the context:
  `logger.info("login", user_id="1")`. An exception passed as the context is
  logged as `ctx["error"]`.
- `child(name=, level=, ctx=, tags=)` inherits sinks, pipeline and context.
- Logging calls and `await logger.flush()` never raise. Pipeline and sink
  failures go to `on_error(error, context)` (default: stderr).
- A pipeline stage that raises drops the event, so a failing redaction stage
  cannot let an unredacted event through.
- Events are sanitized after the pipeline: exceptions become `{name, message,
  stack, cause}` (`stack` is the formatted traceback, `cause` is
  `__cause__`), cycles become `"[circular]"`, unknown objects become
  `"[unserializable]"`, and events over 64 KB (UTF-8) lose their context and
  then have their message shortened.
- Timestamps are RFC3339 UTC with milliseconds (`2026-01-14T12:00:00.000Z`).

## Redaction

`redact(patterns=None, replacement="[redacted]", keys=None, allowlist=None)`
and `redact_event(event, ...)` apply the same rules as `@logfn/core`: values
under credential-named keys at any depth, URL credentials, credential query
values and `name=value` / `Name: value` pairs inside strings, bearer tokens,
and email addresses by default. `patterns` replaces the default extra list
(emails) but never disables the credential rules; `keys` adds sensitive key
names; `allowlist` exempts exact paths such as `user.email` or `userId`.

## Sinks

- `SinkConsole(json=False, color=True)` prints to stdout.
- `SinkHttp(url, auth_token=None, batch_size=10, flush_interval_ms=1000,
  timeout=5.0, *, headers=None, secret_header=None, max_queue=5000,
  retry_attempts=5, backoff_ms=200, redact_patterns=None, redact_keys=None,
  redact_allowlist=None, transport=None, on_error=None, on_drop=None)`:
  - Constructing it performs no I/O; the url must be absolute http(s) without
    embedded credentials.
  - Every event is redacted before it is queued. The queue holds at most
    `max_queue` events and drops the oldest beyond that.
  - Calling the sink never raises or blocks. On a running event loop a full
    batch is sent at once and a partial one after `flush_interval_ms`;
    without a running loop events wait for `await sink.flush()`.
  - Network errors, timeouts, 408, 429 and 5xx are retried with exponential
    backoff; other responses and exhausted retries drop the batch.
  - `flush()` and `close()` never raise; `stats()` returns `queued`,
    `in_flight`, `sent`, `dropped` and `failed_batches`.
  - The default transport is the standard library (`urllib`) in a worker
    thread; pass `transport=async (url, body, headers, timeout) -> status` to
    use another client.

## Differences from the `next` package

- `httpx` and `typing-extensions` are no longer dependencies.
- `redact()` works without arguments and always applies the credential rules;
  `keys` now adds sensitive key names (it used to restrict which ctx keys were
  redacted).
- `enrich_context` lets the event's own ctx win and no longer mutates the
  event; `with_request_ids` generates W3C-sized hex ids.
- `SinkHttp` is bounded, retries, honours `flush_interval_ms` and redacts.
- Python 3.10 is the minimum version.

## Development

```bash
node scripts/ci-run-python-package.mjs logfn/python   # from the repository root
```

`tests/test_clean_consumer.py` installs the built wheel from `dist/` into a
fresh virtual environment outside the repository and runs
`scripts/clean_consumer.py` there.

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
  `logger.info("login", user_id="1")`. `msg` is positional-only, so any other
  keyword (`level`, `msg`, `name`) is context too; `ctx` and `tags` are the
  parameters of those names. An exception passed as the context is logged as
  `ctx["error"]`.
  Any other non-dict context (call, `base_context` or child `ctx`) is logged as `ctx["value"]`, never merged; tags that are not a list or tuple (also `base_tags` and child `tags`) are ignored, never split into characters.
- `child(name=, level=, ctx=, tags=)` inherits sinks, pipeline and context.
- Logging calls and `await logger.flush()` never raise. Pipeline and sink
  failures go to `on_error(error, context)` (default: stderr). `flush()`
  first waits for async sink calls scheduled before it (also those made
  through child loggers, and those running on another thread's event loop),
  then flushes every sink. A call whose loop has stopped or closed is not
  waited for, since nothing would run it. Looking up a sink's `flush` or a
  sink's or stage's `__name__` is inside the same isolation: a raising
  property is reported, and sibling sinks still flush. So is a
  `CancelledError` a sink raises itself (its call or flush awaited a
  cancelled future): it is that sink's failure, reported once, and
  `flush()` still waits for the siblings. A sink, stage, `on_error` or
  `__name__` that raises `CancelledError` from a synchronous call fails like
  any other. Cancelling `flush()` itself propagates and cancels the sinks'
  `flush()` calls it started; sink calls made by logging are not cancelled
  and still deliver (only the loop shutting down cancels them). An `on_error` that
  logs through a failing sink, or schedules `flush()` while a sink's flush
  fails, is never called for the failure it caused, whether the sink raises
  at once or its awaitable fails later in a task (also through child loggers
  or another logger's `on_error`); that failure goes to stderr instead, so
  one error cannot start a loop.
  `flush()` also waits, before and after flushing the sinks and for up to 16 rounds, for sink calls an `on_error` starts meanwhile; awaited inside a sink call, it never waits for that call nor for calls whose sinks are awaiting `flush()`.
- A pipeline stage that raises drops the event, so a failing redaction stage
  cannot let an unredacted event through.
- Events are sanitized after the pipeline: exceptions become `{name, message,
  stack, cause}` (`stack` is the error's own traceback, its last 64 frames as file, line and function with no source text, a name over 200 characters becoming `"[max-size]"` whole; `cause` is `__cause__`, else `__context__` unless suppressed), cycles become `"[circular]"` and unknown objects become
  `"[unserializable]"`. Binary data (`bytes`, `bytearray`, `memoryview`)
  becomes `"[unserializable]"` too, also in the redaction stage: no text rule
  could find a secret in its bytes.
  One walk copies at most `MAX_TRAVERSAL` (256K) values and string or key characters; past it values become `"[max-size]"` and dict entries stop, so objects shared many times cannot expand exponentially. `ctx` and each schema field (`ts`, `level`, ids) have their own budget; other fields share one. Dates are written by the built-in `isoformat` (no subclass override runs). Tags are text: strings are kept, numbers and booleans written as JavaScript writes them, and any other tag becomes `"[unserializable]"`, as its JSON text would hide sensitive keys from redaction.
- Sinks bound the size, after their own redaction, so truncation can never
  cut a secret's delimiter before `SinkHttp` redacts it. Both built-in sinks
  (`validate_and_serialize`) keep every event within 64 KB of UTF-8 JSON: an
  oversized event loses its context; if its other fields are still large,
  metadata is cut to the schema fields of at most 256 characters and tags are
  removed; then the message is shortened. A custom sink receives the
  sanitized event without a size bound.
- Timestamps are RFC3339 UTC with milliseconds (`2026-01-14T12:00:00.000Z`).

## Redaction

`redact(patterns=None, replacement="[redacted]", keys=None, allowlist=None)`
and `redact_event(event, ...)` apply the same rules as `@logfn/core` to every
event field, object keys, top-level field names and exception class names,
messages, tracebacks and causes included: values under
credential-named keys at any depth, URL credentials (up to the last `@` of
the authority), credential query and
fragment values (percent-decoded names; the value runs to the next `&`, `#`,
whitespace or quote; also inside a percent-encoded URL), `name=value` /
`Name: value` pairs inside strings (any JSON whitespace around the
separator, escaped `\n`/`\r`/`\t` after it in once-escaped JSON; quoted names
may contain spaces; quoted values consumed whole, escaped quotes and glued
text included; object and array values to their balanced closing bracket),
bearer tokens, and email addresses by default. A value is left alone only
when the replacement is all of it, and `replacement` must not be empty
(`ValueError`); it is inserted literally (`\g<0>` or `\1` are not expanded).
`patterns` replaces the default extra list (emails) but never disables the
credential rules; `keys` adds sensitive key names; `allowlist` exempts exact
paths such as `user.email` or `userId`. Distinct keys that become the
same text (two email keys once redacted; `1` and `"1"` once made JSON-safe,
on every path: the logger, `SinkHttp`, `sanitize_value`) keep every value:
later ones are stored under `"<key>#2"`, `"#3"` and so on, in key order.
Both redact the sanitized copy, so exception fields obey `keys` and `allowlist` like dict keys, and a key whose redacted text is a credential name counts as one. Quoted names with spaces take `=` as well as `:`; a quoted value runs across lines to its closing quote (a multi-line PEM key included), or to the end of the text when unterminated, and a credential key or bearer token glued to a value takes its own value in. `replacement` must not read as a sensitive key name such as `SECRET` either (`ValueError`). `allowlist` names ctx paths from the ctx root and other fields, `msg` included, by name, in one namespace: `userId` exempts the `userId` field and `ctx.userId` but not `ctx.user.userId`. Schema field names (`msg`, `level`, `ctx`, `tags`, the ids) are never renamed or taken: an extra field whose name redacts to one is kept under `"<name>#2"`.

Each rule reads only caller text: a marker one rule writes is never part of a later match, a sensitive value that runs into a marker takes it in, and touching markers are written as one. The rules run again, keeping the markers, until the text stops changing and stays the same with its markers read as text; text that does not settle in four passes becomes the replacement, so redacting twice changes nothing. A `patterns` entry that matches the replacement itself is the exception: its markers are redacted again on each call.

The text rules have the same known limits as `@logfn/core` (see its README):
unquoted names with spaces, escaped whitespace before the separator,
`password=abc}TAIL`, `password=[redacted]"X"` and twice-encoded query
strings are not redacted. Log credentials as structured context instead.

Runtime differences kept from the ported packages: `create_logger(sinks=[])`
warns where `createLogger({ sinks: [] })` throws, and `with_request_ids()`
fills each missing id where `withRequestIds()` leaves an event that already
has any id unchanged.

## Sinks

- `SinkConsole(json=False, color=True)` prints to stdout; each event is
  size-bounded, and JSON lines use the same UTF-8 encoding the bound measures.
- `SinkHttp(url, auth_token=None, batch_size=10, flush_interval_ms=1000,
  timeout=5.0, *, headers=None, secret_header=None, max_queue=5000,
  retry_attempts=5, backoff_ms=200, redact_patterns=None, redact_keys=None,
  redact_allowlist=None, redact_replacement="[redacted]", transport=None,
  on_error=None, on_drop=None)`:
  - Constructing it performs no I/O; the url must be absolute http(s) without
    embedded credentials.
  - Every event is made JSON-safe, redacted (every field, keys included) and
    size-bounded before it is queued, so the request body is exactly what was
    redacted. The queue holds at most `max_queue` events and drops the oldest
    beyond that, also when an interrupted batch is put back.
  - Calling the sink never raises or blocks. On a running event loop a full
    batch is sent at once and a partial one after `flush_interval_ms`;
    without a running loop events wait for `await sink.flush()`.
  - Network errors, timeouts, 408, 429 and 5xx are retried with exponential
    backoff; other responses and exhausted retries drop the batch. Redirects
    are never followed: a 3xx drops the batch without a retry, so the body
    and credentials cannot reach another origin.
  - `flush()` and `close()` never raise. `flush()` returns once every event
    accepted before the call is sent or dropped, across batches and retries;
    events logged while it waits keep their interval timer. `close()` drops
    later events and delivers, or drops as `"closed"`, everything accepted
    before it, also when the loop cancels its delivery or `close()` itself
    is cancelled (then batches in flight on any loop are dropped and their
    delivery cancelled). Request bodies are
    UTF-8 JSON with non-ASCII text unescaped, as measured by the size limit.
    `stats()` returns `queued`, `in_flight`, `sent`, `dropped` and
    `failed_batches`. A drop or error caused while `on_drop` or `on_error`
    runs (for example by logging to a closed or full sink) is counted in
    `stats()` but not reported to that callback again on that thread, so a
    callback is never re-entered. Events that `on_drop` or `on_error` logs to
    the same sink on its own thread while it runs (directly or through a
    logger) are its diagnostics: when a batch made only of them later fails
    or is dropped, it is counted, its error goes to stderr, and neither
    callback is called, so a collector that always fails cannot turn one
    event into an endless chain of requests. A batch that also holds an
    independent event is reported as usual. Events a callback hands to
    another thread or task are not recognized as its diagnostics.
    Events the transport logs to the same sink are its diagnostics too: a queue holding only them is sent after `flush_interval_ms`, so a transport that logs adds at most one request per interval.
  - `headers` apply after `Content-Type` and before the `auth_token` header; names are case-insensitive, and each drops every earlier spelling. Header values (the `auth_token` one included) are trimmed of leading and trailing spaces, tabs, CR and LF as `fetch` does; a name that is not an HTTP token, or a value that is not a string, holds CR, LF or NUL or is not Latin-1, raises `ValueError` at construction, and no error or diagnostic carries the value.
  - A `CancelledError` raised by a custom transport (its own request was
    cancelled) is a failed attempt within the retry budget. Only cancelling
    the delivering loop's work (loop shutdown) puts a batch back. A call that
    times out is cancelled and given 0.1 s to stop; one that ignores the
    cancellation is abandoned, its late result discarded, so an attempt
    never outlasts `timeout` + 0.1 s. `flush()`/`close()` wait for a batch,
    also one their own drain is sending, no longer than its retry budget.
  - `timeout` (seconds) must be above 0; `timeout`, `backoff_ms` and
    `flush_interval_ms` must be finite, so every batch has a bounded retry
    budget.
  - The sink may be called from any thread, and `flush()`/`close()` awaited
    on any event loop: they also wait for batches that another loop is
    sending. A batch whose loop stopped without finishing it is dropped by the
    waiting `flush()`/`close()` once its retry budget
    (`retry_attempts × (timeout + 0.1 s)` plus backoff, plus 1 s) has passed; its
    current attempt is cancelled when that loop runs again and no further
    attempt is made, so each event has exactly one outcome.
  - The default transport, `stdlib_transport`, posts with `http.client` on a
    new connection in a daemon thread. Each attempt is bounded by `timeout` as
    a whole, including connecting to every address the name resolves to; on
    timeout or cancellation a connect in progress is stopped, no further
    address is tried and a connected socket is shut down, so a slow or
    unreachable collector cannot hold a connection, and `asyncio.run()` or
    interpreter exit never waits for it. Only DNS resolution is not
    interruptible (it finishes in its daemon thread, and no connect follows
    it). A lookup holds no sockets, and at most 4 lookups per host and 64 in
    the process are outstanding: beyond that an attempt fails at once with
    `ResolverBusyError` (retried like any network error) without starting a
    thread, so a hung resolver cannot accumulate threads or descriptors. The
    cap is per host, so a host whose lookups stall does not hold up sinks
    for other hosts; an IP-literal host needs no lookup and takes no slot.
    Proxy environment variables are not used.
    Pass `transport=async (url, body, headers, timeout) -> status` to use
    another client; it should release its resources when cancelled.
  - Redaction runs on the caller's thread over the whole, untruncated event
    (linear in its size; about 1.5-2.5 s for a 10 MiB message), so keep
    very large payloads out of log calls.

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

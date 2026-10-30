# @logfn/core

Structured logging for browser and server with redaction, enrichment, sampling
and bounded transports. No runtime dependencies.

This is the reusable LogFn event pipeline on `dev`, ported from
`21nCo/super-functions.next` at `523c66ae8cf981ff8331d56386cec1f81c704182`
(`logfn/typescript`). The HTTP framework middleware (`http/express`,
`http/fastify`, `http/hono`, `http/watch`) and the LogFn admin product are not
part of this package.

## Entry points

| Import | Contents |
| --- | --- |
| `@logfn/core` | Logger, pipeline stages, console and HTTP sinks, plus both helper sets below (compatible with the `next` package) |
| `@logfn/core/browser` | Everything runtime-neutral plus `captureBrowserErrors` and `attachFlushHooks`; no server code |
| `@logfn/core/server` | Everything runtime-neutral plus `registerProcessHandlers` |
| `@logfn/core/conformance/redaction-vectors.json` | Shared redaction vectors (also used by the Python package) |

Each entry ships ESM (`.js`), CommonJS (`.cjs`) and type declarations. No
entry imports a Node or DOM module, so all of them bundle for browsers; the
package tests bundle `browser` and the root entry with esbuild's browser
platform and fail on any Node built-in.

## Quick start

```typescript
import { createLogger, enrichContext, redactSecFn, sample, sinkHttp } from "@logfn/core";

// Without sinks a logger writes to the local console only.
const local = createLogger({ name: "my-app" });

// Remote delivery is always explicit.
const http = sinkHttp({ url: "https://collector.example.com/ingest", auth: { token } });
const logger = createLogger({
  name: "my-service",
  level: "info",
  pipeline: [enrichContext({ service: "billing" }), redactSecFn(), sample({ info: 0.1 })],
  sinks: [http],
});

logger.error("charge failed", new Error("card declined"));
await logger.flush();
```

`devLogger(name)` logs pretty, colored output at `debug`. `serverLogger({ name,
url?, level? })` logs redacted JSON to the console and adds an HTTP sink only
when `url` is given.

## Logger

- Levels: `trace`, `debug`, `info`, `warn`, `error`, `fatal`. The default is
  `info` when `NODE_ENV` is `production`, otherwise `debug`.
- `child({ name, level, ctx, tags })` inherits sinks, pipeline and context.
- An `Error` context is logged as `ctx.error`; any other non-record context
  (string, array, `Date`, `String` wrapper, bytes) as `ctx.value`, never
  spread. Non-array tags (also `baseTags` and child `tags`) are ignored; a child without `ctx` adds none.
- Logging calls and `flush()` never throw. Pipeline and sink failures go to
  `onError` (default `console.error`). `flush()` first waits for pending
  async sink calls (also those made through child loggers, and for up to 16 rounds those an `onError` starts meanwhile), then flushes
  every sink.
  Reading a sink's `flush` or a sink's or stage's `name` is inside the same
  isolation: a throwing getter is reported, and sibling sinks still flush.
  An `onError` that logs through a failing sink, or calls `flush()` while a
  sink's flush fails, is never called for the failure it caused, whether the
  sink throws at once or its promise rejects later (also through child
  loggers or another logger's `onError`); that failure goes to
  `console.error` instead, so one error cannot start a loop.
- `registerProcessHandlers(logger)` (server entry): on SIGTERM or SIGINT it
  logs the signal, flushes once, logs nothing after that flush and exits
  with 143 or 130 (128 + the signal number). A second signal while that
  flush is pending exits at once with its own code, so a sink whose flush
  never settles cannot block shutdown. It returns an unregister function.
- A pipeline stage that throws drops the event, so a failing redaction stage
  cannot let an unredacted event through.
- Events are sanitized after the pipeline: errors become `{ name, message,
  stack, cause }`, cycles become `"[circular]"` and unserializable values
  become `"[unserializable]"`. One walk copies at most `MAX_TRAVERSAL` (256K) values and string or key characters; past it values become `"[max-size]"` and object entries stop unread (no later getter runs), so objects shared many times cannot expand exponentially. `ctx` and each schema field (`ts`, `level`, ids) have their own budget; other fields share one. Listing an object's own keys stays linear in their number (JavaScript has no lazy key enumeration); value reads, copies and output are bounded by `MAX_TRAVERSAL`. A date is written as its built-in ISO text (no caller `toISOString` override runs) and is charged like a string, as is each tag on the tags budget. Binary data (`Buffer`, typed arrays,
  `DataView`, `ArrayBuffer`, `SharedArrayBuffer`) becomes `"[unserializable]"`
  too, also in the redaction stage: no text rule could find a secret in its
  bytes.
- Sinks bound the size, after their own redaction, so truncation can never
  cut a secret's delimiter before `sinkHttp` redacts it. Both built-in sinks
  (`validateAndSerialize`) keep every event within 64 KB of UTF-8 JSON: an
  oversized event loses its context; if its other fields are still large,
  metadata is cut to the schema fields of at most 256 characters and tags are
  removed; then the message is shortened. A custom sink receives the
  sanitized event without a size bound.

## Redaction

`redactSecFn(options)` (stage) and `redactEvent(event, options)` redact the
message, context (recursively, including error name, message, stack and cause) and
every other event field, object keys and top-level field names included (it redacts the sanitized copy, so error fields obey `keys` and `allowlist` like record keys):

- Values under credential-named keys at any depth, of any type (`password`,
  `secret`, `apiKey`, `authorization`, `cookie`, `credentials`, keys ending in
  `token`, `jwt` or `signature`, and a few exact names such as `auth`, `sid`).
  Keys are compared lowercased with punctuation removed; `maxTokens` and
  `tokenCount` are kept.
- URL credentials (`scheme://user:pass@host`, up to the last `@` of the
  authority as URL parsers read it), credential query and fragment
  values (names are percent-decoded; the value runs to the next `&`, `#`,
  whitespace or quote; parameters inside a percent-encoded URL such as a
  redirect target are found too), `name=value` or `Name: value` pairs inside
  strings (any JSON whitespace, newlines and CRLF included, may surround the
  separator, and escaped `\n`/`\r`/`\t` may follow it in once-escaped JSON;
  quoted names may contain spaces and take either separator, as in
  `"api key" = x` or `'api key': x`; quoted values are consumed whole, escaped
  quotes and once-escaped JSON included, across lines to the closing quote
  (a multi-line PEM key included) or to the end of the text when
  unterminated, with any text glued to the closing quote; an object or
  array value is consumed to its balanced closing bracket, across lines, or
  to the end of the text when unbalanced), and bearer tokens. A value that already starts with
  the replacement is left alone only when the replacement is all of it.
- Email addresses, by default. `patterns` replaces this default extra list but
  never disables the credential rules.

Each rule reads only caller text: a marker one rule writes is never part of a
later match (`https://MASK@host/path` keeps its host for any replacement), a
sensitive value that runs on past a marker takes it in, and touching markers
are written as one, so redacting twice changes nothing.

Options: `keys` (extra sensitive key names), `allowlist` (exact exempt paths
such as `user.email`, `items[0]`, `userId`; ctx paths start at the ctx root
and other fields, `msg` included, are named by their field name, in one namespace, so
`userId` exempts both the `userId` field and `ctx.userId`, but not
`ctx.user.userId`), `patterns`, `replacement`
(default `"[redacted]"`; it must not be empty, which throws; it is inserted
literally, `$&` or `$1` are not expanded). Cycles become `"[circular]"` and
nesting beyond 32 levels becomes `"[max-depth]"`. Dates are redacted as the
ISO text sanitization writes, so the output is final: no later step adds
unredacted text. The output, like sanitization's, is plain data only: arrays
become fresh plain arrays (an `Array` subclass, a `Symbol.species` override
or a proxy keeps no inherited `toJSON`) and functions, symbols and bigints
become `"[unserializable]"`, so serializing it runs no caller code. Own `__proto__` keys are kept as ordinary keys, here and in
sanitization. Distinct keys that redact
to the same text (two email keys) keep every value: later ones are stored
under `"<key>#2"`, `"#3"` and so on, in key order (an allowlisted top-level name too). Schema field names (`msg`, `level`,
`ctx`, `tags`, the ids) are never renamed or taken: an extra field whose name
redacts to one is kept under `"<name>#2"`.

Every value kind is handled alike by redaction and sanitization: `NaN` and
`Infinity` become text; `new String`, `new Number` and `new Boolean` (JS only) become
their primitive, read with the built-in `valueOf` (never an own `toString` or
`valueOf`), so a boxed string is redacted as text, not split into one key per
character; boxed bigints and symbols, like bigints, symbols, functions and
binary data, become `"[unserializable]"`. Any other object (class instances,
`Map`, `Set`, `URL`, proxies) becomes a plain object of its own enumerable
string keys and `toJSON` is never called, so a `URL` becomes `{}`. Kinds are found by brand, not `instanceof`, so an error, date or buffer from another realm (a `vm` context, an iframe) is handled like a local one (an error is what `Error.isError` or the brand check accepts, so a `DOMException` stays an error on every engine; a foreign one, whose class sets its own tag, is read as a record).
Tags are text: strings (also `String` wrappers) are kept, numbers and booleans written as text, and any other tag value becomes `"[unserializable]"` in sanitization and redaction alike, as its JSON text would hide sensitive keys from redaction.

Text rules are heuristics with known limits (the same in both runtimes):
unquoted names with spaces (`pass word=x`), escaped whitespace before the
separator (`\"token\"\n:` in serialized JSON), text after a closing bracket
that ends an unquoted value (`password=abc}TAIL`), a quoted value right after
an unquoted marker (`password=[redacted]"X"`) and query strings encoded twice
(`%253Ftoken%253D`) are not redacted. Log credentials as structured context
under a credential key rather than inside free text.

The rules are shared with the Python package through
`conformance/redaction-vectors.json`; both test suites run every vector, and
whenever `logfn/python` is present the TypeScript suite checks that its copy
matches byte for byte. Rules JSON cannot express (dates, plain-data output
for subclassed or proxied arrays, lists and tuples, own `toJSON` functions)
are covered by each runtime's own tests.

## Sinks

### `sinkConsole({ json, color, levelColors })`

Writes synchronously to the console; `error` and `fatal` go to `console.error`,
`warn` to `console.warn`.

### `sinkHttp(options)`

Posts `{"events": [...]}` to `url` in batches.

- Constructing the sink performs no I/O; the url must be absolute http(s)
  and must not embed credentials.
- Every event is made JSON-safe, redacted (every field, keys included) and
  size-bounded before it is queued, so the request body is exactly what was
  redacted (`redact` adds options; it cannot be turned off).
- The queue holds at most `maxQueue` events (default 5000); the oldest are
  dropped beyond that. A full `batch` (default 50) is sent at once, a partial
  one after `flushIntervalMs` (default 1000).
- Each attempt times out after `timeoutMs` (default 3000; must be above 0).
  The response body is never read: it is cancelled and the request aborted
  once the status is known, so a collector that holds a body open keeps no
  connection. Network errors,
  timeouts, 408, 429 and 5xx are retried up to `retry.attempts` (default 5)
  with exponential backoff from `retry.backoffMs` (default 200). Other
  responses, and exhausted retries, drop the batch. Redirects are never
  followed (`redirect: "manual"`): a 3xx drops the batch without a retry, so
  the body and credentials cannot reach another origin.
- Calling the sink never throws or waits. `flush()` resolves once every event
  accepted before the call is sent or dropped, across as many batches and
  retries as that takes, and never rejects; events logged while it waits keep
  their interval timer. `close()` drops later events and settles everything
  accepted before it. `stats()` returns
  `{ queued, inFlight, sent, dropped, failedBatches }`; `onDrop(count, reason)`
  and `onError(error)` report losses.
- Background timers are unref'd so they do not keep a Node process alive;
  while a caller awaits `flush()` or `close()` the retry backoff and request
  timeout do, so the awaited batch is sent or dropped before exit. In
  browsers the request uses `keepalive` when the body is at most 60,000 bytes
  of UTF-8.
- `fetch` can be supplied; by default `globalThis.fetch` is used per request.
  An instrumented `fetch`, `onDrop` or `onError` may log to the same sink or
  call its `flush()`/`close()`: those calls join the running delivery and
  settle with it. A `fetch` that awaits its own sink's `flush()` before
  responding waits on itself, so that attempt ends only at `timeoutMs`.
  A drop or error caused while `onDrop` or `onError` runs (for example by
  logging to a closed or full sink) is counted in `stats()` but not reported
  to that callback again, so a callback is never re-entered. Events that
  `onDrop` or `onError` logs to the same sink synchronously (directly or
  through a logger) are their diagnostics: when a batch made only of them
  later fails or is dropped, it is counted, its error goes to
  `console.error`, and neither callback is called, so a collector that
  always fails cannot turn one event into an endless chain of requests. A
  batch that also holds an independent event is reported as usual. Events a
  callback logs later (after an `await` or a timer) are not recognized as
  its diagnostics. Events the sink's own `fetch` logs synchronously are diagnostics too: a queue holding only them is sent
  after `flushIntervalMs`, so such a `fetch` adds at most one request per interval. Events it logs after an `await` are ordinary events,
  so with a small `batch` (such as 1) each starts the next request at once, an endless chain: do not, or log through a logger without that sink.
- Redaction runs synchronously in the logging call over the whole,
  untruncated event (linear in its size; about 0.5-1.2 s for a 10 MiB
  message), so keep very large payloads out of log calls.

## Other stages

- `enrichContext(static, dynamic?)`: adds fields; event context wins.
- `sample(rates, { random })`: per-level keep rate (defaults: error, fatal,
  warn 1; info 0.1; debug 0.01; trace 0).
- `withRequestIds({ generate })`: adds W3C-sized trace, span and request ids
  when the event has none. `parseW3CTraceContext(header)` validates a
  `traceparent` value.

## Development

```bash
npx turbo run build typecheck test lint --filter=@logfn/core...
```

`npm test` runs the unit and conformance tests and then
`scripts/verify-packed.mjs`, which packs the package, installs the tarball
offline into a clean project outside the repository and runs ESM, CommonJS and
type-checked consumers against it.

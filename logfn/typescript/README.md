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
- An `Error` passed as the context argument is logged as `ctx.error`.
- Logging calls and `flush()` never throw. Pipeline and sink failures go to
  `onError` (default `console.error`). `flush()` first waits for pending
  async sink calls (also those made through child loggers), then flushes
  every sink.
- A pipeline stage that throws drops the event, so a failing redaction stage
  cannot let an unredacted event through.
- Events are sanitized after the pipeline: errors become `{ name, message,
  stack, cause }`, cycles become `"[circular]"` and unserializable values
  become `"[unserializable]"`.
- Sinks bound the size, after their own redaction, so truncation can never
  cut a secret's delimiter before `sinkHttp` redacts it. Both built-in sinks
  (`validateAndSerialize`) keep every event within 64 KB of UTF-8 JSON: an
  oversized event loses its context; if its other fields are still large,
  metadata is cut to the schema fields of at most 256 characters and tags are
  removed; then the message is shortened. A custom sink receives the
  sanitized event without a size bound.

## Redaction

`redactSecFn(options)` (stage) and `redactEvent(event, options)` redact the
message, context (recursively, including error message, stack and cause) and
every other event field, object keys and top-level field names included:

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
  quoted names may contain spaces; quoted values are consumed whole, escaped
  quotes and once-escaped JSON included, with any text glued to the closing
  quote; an object or array value is consumed to its balanced closing
  bracket, across lines, or to the end of the text when unbalanced), and
  bearer tokens. A value that already starts with
  the replacement is left alone only when the replacement is all of it.
- Email addresses, by default. `patterns` replaces this default extra list but
  never disables the credential rules.

Options: `keys` (extra sensitive key names), `allowlist` (exact exempt paths
such as `user.email`, `items[0]`, `userId`), `patterns`, `replacement`
(default `"[redacted]"`; it must not be empty, which throws; it is inserted
literally, `$&` or `$1` are not expanded). Cycles become `"[circular]"` and
nesting beyond 32 levels becomes `"[max-depth]"`.

Text rules are heuristics with known limits (the same in both runtimes):
unquoted names with spaces (`pass word=x`), escaped whitespace before the
separator (`\"token\"\n:` in serialized JSON), text after a closing bracket
that ends an unquoted value (`password=abc}TAIL`), a quoted value right after
an unquoted marker (`password=[redacted]"X"`) and query strings encoded twice
(`%253Ftoken%253D`) are not redacted. Log credentials as structured context
under a credential key rather than inside free text.

The rules are shared with the Python package through
`conformance/redaction-vectors.json`; both test suites run every vector.

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

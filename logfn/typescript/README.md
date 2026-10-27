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
  `onError` (default `console.error`).
- A pipeline stage that throws drops the event, so a failing redaction stage
  cannot let an unredacted event through.
- Events are sanitized after the pipeline: errors become `{ name, message,
  stack, cause }`, cycles become `"[circular]"`, unserializable values become
  `"[unserializable]"`, and events over 64 KB (UTF-8) lose their context and
  then have their message shortened.

## Redaction

`redactSecFn(options)` (stage) and `redactEvent(event, options)` redact the
message, context (recursively, including error message, stack and cause),
tags, `userId` and `tenantId`:

- Values under credential-named keys at any depth, of any type (`password`,
  `secret`, `apiKey`, `authorization`, `cookie`, `credentials`, keys ending in
  `token`, `jwt` or `signature`, and a few exact names such as `auth`, `sid`).
  Keys are compared lowercased with punctuation removed; `maxTokens` and
  `tokenCount` are kept.
- URL credentials (`scheme://user:pass@host`), credential query values and
  `name=value` or `Name: value` pairs inside strings, and bearer tokens.
- Email addresses, by default. `patterns` replaces this default extra list but
  never disables the credential rules.

Options: `keys` (extra sensitive key names), `allowlist` (exact exempt paths
such as `user.email`, `items[0]`, `userId`), `patterns`, `replacement`
(default `"[redacted]"`). Cycles become `"[circular]"` and nesting beyond 32
levels becomes `"[max-depth]"`.

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
- Every event is redacted before it is queued (`redact` adds options; it
  cannot be turned off).
- The queue holds at most `maxQueue` events (default 5000); the oldest are
  dropped beyond that. A full `batch` (default 50) is sent at once, a partial
  one after `flushIntervalMs` (default 1000).
- Each attempt times out after `timeoutMs` (default 3000). Network errors,
  timeouts, 408, 429 and 5xx are retried up to `retry.attempts` (default 5)
  with exponential backoff from `retry.backoffMs` (default 200). Other
  responses, and exhausted retries, drop the batch.
- Calling the sink never throws or waits. `flush()` sends what is queued and
  never rejects; `close()` flushes and drops later events. `stats()` returns
  `{ queued, inFlight, sent, dropped, failedBatches }`; `onDrop(count, reason)`
  and `onError(error)` report losses.
- Timers are unref'd so they do not keep a Node process alive. In browsers the
  request uses `keepalive` when the body is under 60 KB.
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

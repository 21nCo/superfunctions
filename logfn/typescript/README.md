# LogFn

Structured logging for browser and server with pluggable pipelines and transports.

## Features

- **Structured Logging**: JSON-based log events with consistent schema
- **Log Levels**: trace, debug, info, warn, error, fatal
- **Child Loggers**: Create scoped loggers with inherited context
- **Pipeline Stages**: Pluggable event processing (redaction, enrichment, sampling)
- **Multiple Sinks**: Console (pretty/JSON), HTTP (batched with retry)
- **Browser & Server**: Works in both environments with appropriate optimizations
- **TypeScript**: Full type safety with comprehensive type definitions
- **Zero Dependencies**: Core has no runtime dependencies

## Installation

```bash
npm install @logfn/core
```

## Quick Start

```typescript
import { devLogger } from "@logfn/core";

const logger = devLogger("my-app");

logger.info("Application started", { version: "1.0.0" });
logger.warn("Deprecated API used", { api: "/old-endpoint" });
logger.error("Request failed", { statusCode: 500, path: "/api/users" });
```

## Basic Usage

### Creating a Logger

```typescript
import { createLogger, sinkConsole } from "@logfn/core";

const logger = createLogger({
  name: "my-service",
  level: "info",
  sinks: [sinkConsole({ json: true })],
});

logger.info("User logged in", { userId: "123", email: "user@example.com" });
```

### Child Loggers

```typescript
const requestLogger = logger.child({
  ctx: { requestId: "req-123", traceId: "trace-456" },
  tags: ["http", "api"],
});

requestLogger.info("Request received");
// Includes inherited context and tags
```

## Pipeline Stages

### Redaction

```typescript
import { createLogger, sinkConsole, redactSecFn } from "@logfn/core";

const logger = createLogger({
  name: "app",
  pipeline: [
    redactSecFn({
      patterns: [/api_key=\w+/gi, /password=\w+/gi],
      allowlist: ["userId"], // Exception for this stage; terminal policy still applies
    }),
  ],
  sinks: [sinkConsole()],
});

logger.info("API call", { apiKey: "secret-123" });
// Output: { msg: 'API call', ctx: { apiKey: '[redacted]' } }
```

### Context Enrichment

```typescript
import { enrichContext } from "@logfn/core";

const logger = createLogger({
  name: "app",
  pipeline: [
    enrichContext(
      { service: "auth-service", environment: "production" },
      () => ({ hostname: os.hostname() })
    ),
  ],
  sinks: [sinkConsole()],
});

logger.info("Service started");
// Includes service, environment, and hostname in context
```

### Request IDs

```typescript
import { withRequestIds } from "@logfn/core";

const logger = createLogger({
  name: "app",
  pipeline: [withRequestIds()],
  sinks: [sinkConsole()],
});

logger.info("Request processed");
// Includes generated traceId, spanId, requestId
```

### Sampling

```typescript
import { sample } from "@logfn/core";

const logger = createLogger({
  name: "app",
  pipeline: [
    sample({
      error: 1.0, // Keep all errors
      warn: 1.0, // Keep all warnings
      info: 0.1, // Keep 10% of info logs
      debug: 0.01, // Keep 1% of debug logs
      trace: 0.0, // Drop all trace logs
    }),
  ],
  sinks: [sinkConsole()],
});
```

## Sinks

### Console Sink

```typescript
import { sinkConsole } from "@logfn/core";

// Pretty output (development)
const consoleSink = sinkConsole({
  color: true,
  json: false,
});

// JSON output (production)
const jsonSink = sinkConsole({
  color: false,
  json: true,
});
```

### HTTP Sink

```typescript
import { sinkHttp } from "@logfn/core";

const httpSink = sinkHttp({
  url: "https://logs.example.com/ingest",
  batch: 50, // Batch size
  flushIntervalMs: 1000, // Flush every second
  auth: {
    token: "your-api-key",
  },
  retry: {
    attempts: 5,
    backoffMs: 200,
  },
  maxQueue: 5000, // Max events in queue
});

const logger = createLogger({
  name: "app",
  sinks: [sinkConsole(), httpSink],
});
```

## Browser Usage

### Error Capture

```typescript
import { devLogger, captureBrowserErrors, attachFlushHooks } from "@logfn/core";

const logger = devLogger("my-app");

// Capture uncaught errors and promise rejections
captureBrowserErrors(logger);

// Flush on page hide/unload
attachFlushHooks(logger);
```

### Offline Support

The HTTP sink automatically handles offline scenarios in the browser:

```typescript
import { sinkHttp } from "@logfn/core";

const httpSink = sinkHttp({
  url: "https://logs.example.com/ingest",
  offlineBuffer: "memory", // or 'indexeddb'
});
```

## Server Usage

### Graceful Shutdown

```typescript
import { serverLogger, registerProcessHandlers } from "@logfn/core";

const logger = serverLogger({ name: "api-server" });

// Register SIGTERM/SIGINT handlers to flush logs
registerProcessHandlers(logger);
```

## WatchFn Integration

LogFn includes a WatchFn ingest handler for collecting logs:

```typescript
import { watchLogsHandler } from "@logfn/core/http/watch";

// Create an HTTP handler
const handler = watchLogsHandler({
  auth: {
    header: "X-API-Key",
    value: process.env.API_KEY,
  },
  maxBatch: 500,
  ingest: async (events, request) => {
    // Resolve only after your configured WatchFn/store durably accepts this batch.
    await logStore.appendBatch(events);
  },
});

// Use with your HTTP framework
// POST /watch/logs
```

The handler returns 202 only after `ingest` resolves. An absent destination or a
rejected write returns 503 without exposing storage error details. Consumers may
retry failed requests: use stable event identifiers or transactional/idempotent
writes if your destination can partially commit. Authentication callbacks may be
asynchronous. Only POST is accepted; `maxBodyBytes` defaults to 8 MiB and is enforced
while reading the request stream. Invalid events reject the entire batch before
calling the destination. Deployments upgrading the previous placeholder handler
must configure `ingest`; it no longer acknowledges discarded events.

## Log Event Schema

Each log event has the following structure:

```typescript
interface LogEvent {
  ts: string; // ISO8601 timestamp
  level: LogLevel; // trace|debug|info|warn|error|fatal
  msg: string; // Human-readable message
  name: string; // Logger name
  ctx?: Record<string, unknown>; // Context data
  tags?: string[]; // Tags for categorization
  traceId?: string; // W3C TraceContext trace ID
  spanId?: string; // W3C TraceContext span ID
  requestId?: string; // Request correlation ID
  userId?: string; // User identifier
  tenantId?: string; // Tenant identifier
  version: string; // Schema version
}
```

## Configuration Presets

### Development Logger

```typescript
import { devLogger } from "@logfn/core";

const logger = devLogger("my-app");
// - Colored console output
// - Debug level
// - Pretty formatting
```

### Server Logger

```typescript
import { serverLogger } from "@logfn/core";

const logger = serverLogger({
  name: "api-server",
  level: "info",
  url: "https://logs.example.com/ingest", // Optional HTTP sink
});
// - JSON console output
// - Info level
// - Optional HTTP sink
```

## Advanced Usage

### Custom Pipeline Stage

```typescript
import type { PipelineStage } from "@logfn/core";

const addHostname: PipelineStage = (event) => ({
  ...event,
  ctx: {
    ...event.ctx,
    hostname: os.hostname(),
  },
});

const logger = createLogger({
  name: "app",
  pipeline: [addHostname],
  sinks: [sinkConsole()],
});
```

### Custom Sink

```typescript
import type { Sink } from "@logfn/core";

const customSink: Sink = async (batch) => {
  // Process batch of log events
  for (const event of batch) {
    console.log("Custom sink:", event);
  }
};

customSink.flush = async () => {
  // Flush any buffered events
};

const logger = createLogger({
  name: "app",
  sinks: [customSink],
});
```

## HTTP request logging

Import `requestLogger` from `@logfn/core/http/express`, `/http/fastify`, or `/http/hono` and optionally supply a `logger`. Without one, all adapters create request children from a shared `logfn.http` console logger. Request correlation fields appear at the event top level and are inherited by application logs from the request logger. Fastify exposes it as `request.logfn`, preserving the native `request.log`.

`sample` applies one decision to each automatic info-level request/completion pair (`{ info: rate }` or a number from0 to1). It does not disable the attached application logger. Default secret-header redaction remains active alongside custom header names.

Body capture is opt-in with `includeBody: true`. Captured values are bounded to8192 serialized UTF-8 bytes. Hono reads at most8192 bytes from a cloned stream and allows at most `bodyCaptureTimeoutMs` (default100ms) for that capture before entering the route. A truncated prefix reports `_capturedBytes`, not the unknown total body length. Unavailable or timed-out captures contain an `_omitted` reason. The route retains its original request stream; transport buffering and individual incoming chunk sizes are controlled by the runtime.

## API Reference

See full TypeScript definitions in the package. All exports are fully typed.

### Core

- `createLogger(options)` - Create a logger instance
- `devLogger(name?)` - Create a development logger
- `serverLogger(opts)` - Create a server logger
- `Logger` - Logger class

### Pipeline Stages

- `redactSecFn(options?)` - Redact secrets
- `enrichContext(static, dynamic?)` - Add context fields
- `withRequestIds(options?)` - Add correlation IDs
- `sample(rates)` - Sample log events

### Sinks

- `sinkConsole(options?)` - Console output
- `sinkHttp(options)` - HTTP transport

### Browser Utilities

- `captureBrowserErrors(logger)` - Capture uncaught errors
- `attachFlushHooks(logger)` - Flush on visibility change

### Server Utilities

- `registerProcessHandlers(logger)` - Graceful shutdown

## License

MIT

## Contributing

Contributions welcome! Please see the main repository for guidelines.

### HTTP delivery guarantees

`batch` limits each request's event count. Concurrent `flush()` calls wait for the
same active drain, including queued arrivals during delivery. A failed explicit
flush rejects and retains unsent events for a later flush; background failures are
reported to the internal console channel. Overflow continues to discard oldest
queued events at `maxQueue`. Each request attempt gets a fresh timeout; network
failures, timeouts, 408, 429 and 5xx retry within `retry.attempts`, with backoff capped
at five seconds. Other 4xx responses end that send attempt immediately. Requests
may be retried after ambiguous network failure, so destinations should tolerate
duplicate events.

### Event size and serialization

Events are sanitized before delivery. Cycles become `[circular]`, unsupported
values become `[unserializable]`, and nesting beyond 64 levels becomes
`[depth_limit]`. Shared references that are not cycles retain their values.
The 64 KiB event limit is measured as UTF-8 JSON bytes. Oversized events receive
`ctx._truncated`; complete context entries are retained where they fit. If the
envelope itself exceeds the limit, optional metadata is removed and required
text fields are shortened at Unicode code-point boundaries. Inputs are not
mutated. Keep unusually large payloads in external storage and log a reference.

`await logger.flush()` joins outstanding asynchronous sink calls from the logger
and its children before invoking every sink's flush hook. It reports background
delivery failures after all flush hooks settle; synchronous logging still does
not throw sink failures. Redaction handles cyclic context before serialization,
so cycles do not cause the redaction stage to be skipped.

`serverLogger({ name, url })` sends to both the JSON console sink and the supplied
HTTP endpoint. Call `await logger.flush()` before normal shutdown. The opt-in
`registerProcessHandlers(logger)` helper owns SIGTERM/SIGINT termination: it
logs the received signal, drains accepted events, then exits with status 0 on
success or 1 on delivery failure. It does not enqueue another event after the
final flush. Its returned cleanup function removes both signal listeners.

Pass `onError(error, { stage?, sink? })` to `createLogger` to receive pipeline,
sink delivery and flush failures. Child loggers inherit the callback. Logging
calls contain callback exceptions and suppress synchronous recursive error
reporting; an explicit `flush()` still rejects when delivery fails. Without a
callback, failures go to the internal console error channel.

HTTP sinks expose `await sink.close()` to drain accepted events, clear timers,
and remove owned browser listeners. New writes are rejected during close and
after successful close. A failed close retains events and can be retried.
Unload requests with authentication or custom headers use best-effort keepalive
fetch. Header-free beacon attempts are bounded below the browser payload limit;
queued events remain until confirmed HTTP delivery, so duplicates are possible.
Unload transport is not a substitute for durable offline storage.

### Durable browser HTTP queue

`offlineBuffer: "indexeddb"` now persists each accepted batch before delivery.
Direct sink callers must await the returned promise; `Logger.flush()` already
joins these writes. Records are deleted only after a successful HTTP response,
using exact record IDs so concurrent enqueue is not accidentally acknowledged.
Delivery is at least once: a crash after server acceptance but before local
acknowledgement can produce duplicates. Ingestion should deduplicate where needed.

Queues recover on sink creation and retain the newest `maxQueue` waiting events.
IndexedDB must be available; storage errors reject enqueue instead of silently
falling back to volatile memory. For authentication or custom headers, supply a
stable, non-secret `offlineKey` unique to the tenant/credential scope. Reuse it
across token rotation for the same identity; use a different key when switching
identities. Credentials are not stored with queued events. Browser storage
clearing, eviction and private-session policies can still remove local data.

```ts
const sink = sinkHttp({
  url: '/logs',
  offlineBuffer: 'indexeddb',
  offlineKey: 'workspace-123',
  auth: { token },
});
```

The acceptance script `logfn/scripts/browser-offline-acceptance.mjs` checks failed
delivery, Chrome process restart, recovery, and deletion after acknowledgement.
Build first; set `PLAYWRIGHT_MODULE` and `CHROME_PATH` when needed.

Trace-context parsing rejects malformed hexadecimal fields, zero trace/span IDs,
invalid version/flag fields, and extra fields on version00. Additive future
versions preserve the known trace/span fields. `withRequestIds()` fills missing
IDs while preserving supplied IDs. Format rules follow the
[W3C Trace Context specification](https://www.w3.org/TR/trace-context/#traceparent-header-field-values).

Request middleware always redacts `authorization`, `cookie`, `x-api-key` and
`x-auth-token`; custom `redactHeaders` entries extend that baseline. Fastify
middleware exposes the LogFn child as typed `request.logfn`, preserving Fastify's
native `request.log`. Its request event is emitted at `preHandler` so opt-in
body capture sees the parsed body. Register identity hooks before this plugin
when `captureUser` depends on their results.

The WatchFn ingestion handler rejects unsupported event versions with HTTP 400 and events larger than 64 KiB of UTF-8 JSON with HTTP 413. Validation covers the entire batch before invoking the configured ingestion callback, so an invalid event cannot cause partial callback delivery.

## Shared HTTP ingestion router

Install `@superfunctions/http@^0.3.1` when using the ingestion subpath. Create `watchLogsRouter` and pass its router to your framework's `@superfunctions/http-*` adapter directly; LogFn does not re-export framework adapters. The existing `watchLogsHandler` remains available for direct Fetch handlers.

```typescript
import { watchLogsRouter } from "@logfn/core/http/watch";

const router = watchLogsRouter({
  basePath: "/api",
  auth: { header: "authorization", value: "Bearer configured-token" },
  ingest: async (events) => {
    await persistEvents(events); // Application-owned durable storage
  },
});

// Fetch-native runtime entrypoint: POST /api/watch/logs
export default { fetch: router.handler };
```

`path` defaults to `/watch/logs`. Routing, method handling and route metadata use the shared HTTP router; LogFn retains event validation, authentication and awaited ingestion behavior.

## Shared HTTP request logging

Use `requestLogger` from `@logfn/core/http/shared` in a shared HTTP router's middleware list. It adds the request logger to `context.log`, preserving the same correlation fields for automatic start/completion events and application logs. `sample` controls the automatic pair; the application logger remains available. Captured bodies use the same bounded Fetch-stream capture described above.

```typescript
import { createRouter } from "@superfunctions/http";
import { requestLogger, type LogRequestContext } from "@logfn/core/http/shared";

const router = createRouter<LogRequestContext>({
  middleware: [requestLogger({ logger })],
  routes: [{
    method: "GET", path: "/health",
    handler: (_request, context) => {
      context.log?.info("Health checked");
      return new Response("ok");
    },
  }],
});
```

Mount the router through the consumer's shared HTTP framework adapter. Completion records reflect the final response returned by the shared router, including configured error responses.

## Default privacy boundary and migration

Every `Logger`, `createLogger`, `devLogger` and `serverLogger` now applies a
terminal masking policy after custom pipeline stages and serialization, before
console/HTTP/custom sinks. Known secret-bearing keys (including password, token,
API-key, authorization/cookie and common variants) are masked recursively, as are
user/tenant ID keys. Credential assignments, bearer/basic text and email patterns
are scrubbed from strings, including quoted JSON credential fields. Trace/span/
request IDs remain usable unless their string values match a sensitive pattern.

This changes output that previously reached sinks without a redaction stage.
Safe identity/context exceptions require an explicit exact JSON Pointer leaf:

```typescript
const logger = createLogger({
  name: "service",
  sinks: [sinkConsole({ json: true })],
  correlation: { userId: "approved-pseudonymous-id", tenantId: "private-tenant" },
  redaction: { allowlist: ["/userId", "/ctx/publicToken"] },
});
```

`DefaultRedactionOptions` is exported. The policy is copied at construction and
inherited by children. `/ctx/publicToken` permits only that primitive value;
parent/object entries never exempt a subtree. Paths use JSON Pointer escaping
(`~1` for `/`, `~0` for `~`), so a literal key cannot accidentally authorize a
nested unrelated secret. Secret containers remain masked as a whole. Nulls are
preserved. A failed terminal conversion drops the event and reports a fixed
internal failure instead of sending the unsafe value. Each sink receives an
independent snapshot, and final events retain the 64 KiB wire bound.

Existing `redactSecFn` custom patterns/allowlists still control that explicit
pipeline stage; they do not disable the terminal policy. Move intentional safe
field exceptions to `LoggerOptions.redaction.allowlist`. Built-in diagnostics
also apply masking. Explicit `onError` callbacks and rejected `flush()` errors
remain caller-owned and can contain raw exception information.

The policy is a bounded set of key/value heuristics, not a detector for arbitrary
unlabelled credentials or all PII. Prefer structured context over pre-serialized
JSON messages; redacted message text need not remain parseable JSON. Add
application-specific pipeline policies where needed. Calling sinks directly
assumes the caller has already applied its privacy policy. Existing persisted
IndexedDB events are not retroactively rewritten: handle pre-upgrade spool data
under your retention/privacy policy before replaying it. New logger-generated
events are masked before entering the durable queue.

### Queue overflow metric

`HttpSink.overflowEvictions` is a read-only cumulative count of records removed
by this sink instance to keep the newest `maxQueue` events. Poll it from your
metrics collector; it does not emit another log into the overflowing sink.
Enqueue overflow and failed-send requeue overflow both increment the count.
IndexedDB evictions count only after their transaction commits; rollback and
normal acknowledged delivery do not increment it. With cooperating tabs, each
instance counts the evictions committed by its own writes.

The counter resets when the instance is recreated and saturates at
`Number.MAX_SAFE_INTEGER`; it is not a persisted aggregate across browser tabs
or processes. An evicted in-flight record may already have reached the receiver,
so this measures queue eviction, not confirmed remote data loss.

```ts
const transport = sinkHttp({ url: '/watch/logs', maxQueue: 5000 });
// Export this gauge/counter value using the host metrics system.
const evictedRecords = transport.overflowEvictions;
```

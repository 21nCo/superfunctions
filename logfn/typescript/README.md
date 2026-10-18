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
      allowlist: ["userId"], // Don't redact these fields
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

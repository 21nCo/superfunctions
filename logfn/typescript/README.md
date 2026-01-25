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
npm install logfn
```

## Quick Start

```typescript
import { devLogger } from "logfn";

const logger = devLogger("my-app");

logger.info("Application started", { version: "1.0.0" });
logger.warn("Deprecated API used", { api: "/old-endpoint" });
logger.error("Request failed", { statusCode: 500, path: "/api/users" });
```

## Basic Usage

### Creating a Logger

```typescript
import { createLogger, sinkConsole } from "logfn";

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
import { createLogger, sinkConsole, redactSecFn } from "logfn";

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
import { enrichContext } from "logfn";

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
import { withRequestIds } from "logfn";

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
import { sample } from "logfn";

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
import { sinkConsole } from "logfn";

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
import { sinkHttp } from "logfn";

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
import { devLogger, captureBrowserErrors, attachFlushHooks } from "logfn";

const logger = devLogger("my-app");

// Capture uncaught errors and promise rejections
captureBrowserErrors(logger);

// Flush on page hide/unload
attachFlushHooks(logger);
```

### Offline Support

The HTTP sink automatically handles offline scenarios in the browser:

```typescript
import { sinkHttp } from "logfn";

const httpSink = sinkHttp({
  url: "https://logs.example.com/ingest",
  offlineBuffer: "memory", // or 'indexeddb'
});
```

## Server Usage

### Graceful Shutdown

```typescript
import { serverLogger, registerProcessHandlers } from "logfn";

const logger = serverLogger({ name: "api-server" });

// Register SIGTERM/SIGINT handlers to flush logs
registerProcessHandlers(logger);
```

## WatchFn Integration

LogFn includes a WatchFn ingest handler for collecting logs:

```typescript
import { watchLogsHandler } from "logfn/http/watch";

// Create an HTTP handler
const handler = watchLogsHandler({
  auth: {
    header: "X-API-Key",
    value: process.env.API_KEY,
  },
  maxBatch: 500,
});

// Use with your HTTP framework
// POST /watch/logs
```

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
import { devLogger } from "logfn";

const logger = devLogger("my-app");
// - Colored console output
// - Debug level
// - Pretty formatting
```

### Server Logger

```typescript
import { serverLogger } from "logfn";

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
import type { PipelineStage } from "logfn";

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
import type { Sink } from "logfn";

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

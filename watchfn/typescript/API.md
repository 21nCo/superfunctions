# WatchFn TypeScript SDK - API Documentation

**Version**: 0.1.0  
**Type-Safe Observability Platform**

---

## Installation

```bash
npm install @watchfn/sdk
```

---

## Quick Start

```typescript
import { watchFn } from "@watchfn/sdk";

const watcher = watchFn("my-service", {
  storage: "memory",
  enableAPM: true,
  enableErrorTracking: true,
});

watcher.start();
```

---

## Core Modules

### WatchFn Client

Main entry point for the SDK.

```typescript
import { watchFn } from "@watchfn/sdk";

const watcher = watchFn("service-name", {
  storage: "memory" | "database",
  enableAPM: boolean,
  enableErrorTracking: boolean,
  enableRUM: boolean,
  enableTracing: boolean,
});

// Start collecting metrics
watcher.start();

// Track custom events
watcher.track("user.signup", {
  userId: "123",
  plan: "premium",
});

// Capture errors
watcher.captureException(error, { context: "payment" });

// Stop collecting
watcher.stop();
```

---

## Metric Aggregation

Real-time metric aggregation with rolling windows.

```typescript
import { MetricAggregator, MetricPoint } from "@watchfn/sdk";

const aggregator = new MetricAggregator({
  intervals: ["1m", "5m", "1h"],
  maxDataPoints: 10000,
});

// Add metric points
aggregator.add("api.requests", {
  timestamp: Date.now(),
  value: 1,
  tags: { endpoint: "/users" },
});

// Query aggregated data
const results = aggregator.get("api.requests", "5m", from, to, "avg");
```

**Aggregation Functions:**

- `count` - Count of data points
- `sum` - Sum of values
- `avg` - Average value
- `min` / `max` - Min/max values
- `p50` / `p75` / `p90` / `p95` / `p99` - Percentiles

---

## Context Management

Async-safe context tracking for requests.

```typescript
import { ContextManager, Context } from "@watchfn/sdk";

const contextManager = new ContextManager();

await contextManager.run(
  {
    requestId: "req_123",
    userId: "user_456",
    traceId: "trace_789",
  },
  async () => {
    // Context is available throughout async call chain
    const ctx = contextManager.get();
    console.log(ctx.requestId); // 'req_123'

    // Add tags
    contextManager.setTag("environment", "production");

    // Add metadata
    contextManager.setMetadata("user", { name: "John" });
  }
);
```

---

## Framework Adapters

### Express

```typescript
import express from "express";
import {
  watchFn,
  createExpressMiddleware,
  createExpressRouter,
} from "@watchfn/sdk";

const app = express();
const watcher = watchFn("my-api");

// Add automatic request tracking
app.use(createExpressMiddleware(watcher));

// Mount WatchFn routes
app.use("/watch", createExpressRouter(watcher));
```

### Fastify

```typescript
import Fastify from "fastify";
import { watchFn, registerWatchFn } from "@watchfn/sdk";

const fastify = Fastify();
const watcher = watchFn("my-api");

// Register WatchFn with hooks
await registerWatchFn(fastify, watcher, { prefix: "/watch" });
```

### Next.js (App Router)

```typescript
// app/api/watch/[...path]/route.ts
import { watchFn, createNextHandler } from "@watchfn/sdk";

const watcher = watchFn("my-app");
export const { GET, POST } = createNextHandler(watcher, {
  trackRequests: true,
});
```

---

## APM - Application Performance Monitoring

### Database Tracing

```typescript
import { DatabaseTracer } from '@watchfn/sdk';

const tracer = new DatabaseTracer(
  (name, data) => watcher.track(name, data),
  { slowThreshold: 100 } // ms
);

// Trace queries
const result = await tracer.traceQuery(
  'SELECT * FROM users WHERE id = ?',
  async () => db.query(...),
  { userId: 123 }
);
```

### Function Profiling

```typescript
import { FunctionProfiler } from "@watchfn/sdk";

const profiler = new FunctionProfiler(
  (name, data) => watcher.track(name, data),
  { slowThreshold: 1000 } // ms
);

// Profile async functions
await profiler.profileAsync(
  "processOrder",
  async () => {
    // Your code here
  },
  { tags: { priority: "high" } }
);
```

---

## Error Tracking

```typescript
import { ExceptionHandler } from "@watchfn/sdk";

// Capture exceptions
watcher.captureException(error, {
  userId: "123",
  action: "checkout",
});

// Capture messages
watcher.captureMessage("Payment gateway timeout", {
  level: "warning",
});

// Source map support for production
import { SourceMapResolver } from "@watchfn/sdk";

const resolver = new SourceMapResolver();
await resolver.loadSourceMap("bundle.js", sourceMapContent);
const resolvedFrames = await resolver.resolveStackTrace(frames);
```

---

## Distributed Tracing

```typescript
import { TraceContextPropagator, Tracer } from "@watchfn/sdk";

const propagator = new TraceContextPropagator();

// Extract trace context from incoming request
const context = propagator.extract(req.headers);

// Create child span
const childContext = propagator.createChild(context);

// Inject into outgoing request
const headers = propagator.inject(childContext);
await fetch(url, { headers });
```

---

## Alerting

### Define Alerts

```typescript
import { AlertManager, AlertEvaluator } from "@watchfn/sdk";

const alertManager = new AlertManager();

// Threshold alert
alertManager.register({
  id: "high-cpu",
  name: "High CPU Usage",
  enabled: true,
  condition: {
    type: "threshold",
    metric: "cpu.usage",
    operator: "gt",
    threshold: 80,
    window: "5m",
    aggregation: "avg",
  },
  severity: "critical",
  channels: ["slack", "pagerduty"],
});

// Anomaly detection alert
alertManager.register({
  id: "anomaly-requests",
  name: "Anomalous Request Rate",
  enabled: true,
  condition: {
    type: "anomaly",
    metric: "requests.count",
    sensitivity: 0.8,
    minDataPoints: 10,
    algorithm: "moving-average",
  },
  severity: "warning",
  channels: ["slack"],
});
```

### Notification Channels

```typescript
import { SlackChannel, WebhookChannel } from "@watchfn/sdk";

// Slack
const slack = new SlackChannel("https://hooks.slack.com/...");
await slack.send(alert);

// Webhook with retries
const webhook = new WebhookChannel({
  url: "https://api.example.com/alerts",
  headers: { Authorization: "Bearer token" },
  retries: 3,
});
await webhook.send(payload);
```

---

## Business Metrics

```typescript
import { BusinessMetricsTracker } from "@watchfn/sdk";

const tracker = new BusinessMetricsTracker();

// Track events
tracker.track({
  name: "purchase",
  properties: {
    amount: 99.99,
    currency: "USD",
    product: "Premium Plan",
  },
  userId: "user_123",
  value: 99.99,
});

// Create conversion funnel
tracker.createFunnel({
  name: "signup-flow",
  steps: [
    { name: "View Landing", event: "page.view" },
    { name: "Start Signup", event: "signup.start" },
    { name: "Complete Signup", event: "signup.complete" },
  ],
  timeWindow: 30 * 60 * 1000, // 30 minutes
});

// Analyze funnel
const analysis = tracker.analyzeFunnel("signup-flow", from, to);
console.log(analysis.overallConversion); // e.g., 25%

// Calculate KPIs
const kpi = tracker.calculateKPI("revenue", {
  event: "purchase",
  aggregation: "sum",
  valueField: "amount",
  from,
  to,
  target: 100000,
});
```

---

## Anomaly Detection

```typescript
import { AnomalyDetector } from "@watchfn/sdk";

const detector = new AnomalyDetector();

// Detect anomalies using moving average
const anomalies = detector.detectMovingAverage(dataPoints, {
  windowSize: 10,
  threshold: 3, // standard deviations
});

// Seasonal anomaly detection
const seasonalAnomalies = detector.detectSeasonal(
  dataPoints,
  24, // 24-hour seasonality
  2 // threshold
);
```

---

## Storage Options

### Memory Storage (Default)

```typescript
const watcher = watchFn("service", { storage: "memory" });
```

### Database Storage

```typescript
import { Database } from "@superfunctions/db";

const db = new Database({
  /* config */
});
const watcher = watchFn("service", {
  storage: "database",
  database: db,
});
```

### Time-Series Database

```typescript
import { TimeSeriesDatabase } from "@watchfn/sdk";

const tsdb = new TimeSeriesDatabase({
  compressionEnabled: true,
  compressionThreshold: 100,
});

await tsdb.write("metric.name", {
  timestamp: Date.now(),
  value: 42,
  tags: { env: "prod" },
});

const data = await tsdb.read("metric.name", from, to);
```

---

## Best Practices

### 1. Use Context for Tracing

```typescript
await contextManager.run({ requestId, traceId }, async () => {
  // All operations will have access to context
  await processRequest();
});
```

### 2. Sample High-Volume Events

```typescript
import { Sampler } from "@watchfn/sdk";

const sampler = new Sampler({ strategy: "adaptive", rate: 0.1 });

if (sampler.shouldSample()) {
  watcher.track("page.view", data);
}
```

### 3. Set Appropriate Alert Thresholds

```typescript
// Use historical data to set baselines
const baseline = await calculateBaseline("cpu.usage", "7d");
const threshold = baseline * 1.5; // 50% above baseline
```

### 4. Batch Events for Performance

```typescript
const batcher = new Batcher({
  maxSize: 100,
  maxWait: 5000,
  onFlush: (events) => storage.writeBatch(events),
});

batcher.add(event);
```

---

## TypeScript Types

Full TypeScript support with comprehensive types:

```typescript
import type {
  WatchFnConfig,
  Event,
  MetricPoint,
  TimeRange,
  AlertCondition,
  LogEntry,
  Span,
} from "@watchfn/sdk";
```

---

## More Information

- [GitHub Repository](https://github.com/superfunctions/watchfn)
- [Examples](./examples)
- [Changelog](./CHANGELOG.md)

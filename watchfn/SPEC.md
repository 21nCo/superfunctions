# WatchFn Full Specification

> Comprehensive self-hosted monitoring and observability platform for developers

## Overview

WatchFn is a developer-first observability solution that combines application performance monitoring (APM), real-user monitoring (RUM), error tracking, synthetic monitoring, infrastructure monitoring, log aggregation, distributed tracing, and business analytics into a single self-hosted platform. It builds on the super-functions ecosystem with deep integrations into logfn, authfn, billFn, hostfn, and other superfunctions.

**Version**: 1.0.0  
**Target Release**: Q3 2026  
**Status**: Specification

## Core Philosophy

- **Self-hosted first**: Full data ownership, no vendor lock-in, works anywhere
- **Developer-centric**: Built for developers who need actionable insights, not just dashboards
- **Multi-layer observability**: Application + Infrastructure + Business metrics unified
- **Real-time & historical**: Live monitoring with powerful time-series analytics
- **Alert-to-action**: Actionable insights with debugging context, not just notifications
- **Privacy-first**: All data stays within your infrastructure
- **Cost-effective**: No per-event pricing, unlimited data ingestion
- **Ecosystem-native**: Deep integration with other superfunctions
- **Type-safe**: First-class TypeScript support with full type inference
- **Zero-config smart defaults**: Works out of the box, customizable when needed

## Architecture

```
watchfn/
├── .conduct/                         # Artifacts (spec, plans, audits)
│   ├── SPEC.md
│   ├── implementation.md
│   └── walkthrough.md
├── README.md
│
├── typescript/                       # TypeScript SDK
│   ├── package.json                  # Package: watchfn
│   ├── tsconfig.json
│   ├── tsup.config.ts
│   ├── vitest.config.ts
│   ├── src/
│   │   ├── index.ts
│   │   ├── core/
│   │   │   ├── watch-fn.ts           # Main SDK entry
│   │   │   ├── event-router.ts       # Event ingestion & routing
│   │   │   ├── metric-aggregator.ts  # Real-time metric aggregation
│   │   │   └── context-manager.ts    # Request/user context tracking
│   │   ├── collectors/
│   │   │   ├── apm/                  # Application performance monitoring
│   │   │   │   ├── http-interceptor.ts
│   │   │   │   ├── database-tracer.ts
│   │   │   │   └── function-profiler.ts
│   │   │   ├── rum/                  # Real-user monitoring (browser)
│   │   │   │   ├── web-vitals.ts
│   │   │   │   ├── page-load.ts
│   │   │   │   └── user-interactions.ts
│   │   │   ├── errors/               # Error tracking
│   │   │   │   ├── exception-handler.ts
│   │   │   │   ├── source-maps.ts
│   │   │   │   └── breadcrumbs.ts
│   │   │   └── infra/                # Infrastructure monitoring
│   │   │       ├── system-metrics.ts
│   │   │       ├── process-metrics.ts
│   │   │       └── container-stats.ts
│   │   ├── storage/
│   │   │   ├── time-series/          # Time-series database
│   │   │   │   ├── index.ts
│   │   │   │   ├── aggregation.ts
│   │   │   │   ├── retention.ts
│   │   │   │   └── compression.ts
│   │   │   ├── events/               # Event store
│   │   │   │   ├── index.ts
│   │   │   │   └── indexing.ts
│   │   │   └── database.ts           # Uses @superfunctions/db adapters
│   │   ├── http/                     # HTTP endpoints (uses @superfunctions/http)
│   │   │   ├── router.ts             # Generic route definitions
│   │   │   └── handlers.ts           # Request handlers
│   │   ├── adapters/                 # HTTP framework adapters
│   │   │   ├── express.ts            # Uses @superfunctions/http-express
│   │   │   ├── fastify.ts            # Uses @superfunctions/http-fastify
│   │   │   ├── hono.ts               # Uses @superfunctions/http-hono
│   │   │   ├── next.ts               # Uses @superfunctions/http-next
│   │   │   └── sveltekit.ts          # Uses @superfunctions/http-sveltekit
│   │   ├── query/
│   │   │   ├── query-engine.ts       # Query parser & executor
│   │   │   ├── aggregations.ts       # Metric aggregations
│   │   │   ├── filters.ts            # Query filters
│   │   │   └── time-range.ts         # Time range handling
│   │   ├── trace/
│   │   │   ├── tracer.ts             # Distributed tracing
│   │   │   ├── span.ts               # Trace spans
│   │   │   ├── context-propagation.ts
│   │   │   └── trace-viewer.ts
│   │   ├── alerts/
│   │   │   ├── alert-manager.ts      # Alert engine
│   │   │   ├── conditions.ts         # Alert conditions
│   │   │   ├── evaluator.ts          # Threshold evaluation
│   │   │   └── channels/             # Notification channels
│   │   │       ├── email.ts
│   │   │       ├── slack.ts
│   │   │       ├── webhook.ts
│   │   │       └── pagerduty.ts
│   │   ├── synthetics/
│   │   │   ├── monitor.ts            # Synthetic monitoring
│   │   │   ├── http-check.ts         # HTTP uptime checks
│   │   │   ├── browser-script.ts     # Browser-based tests
│   │   │   └── scheduler.ts          # Check scheduler
│   │   ├── dashboards/
│   │   │   ├── dashboard-builder.ts  # Dashboard configuration
│   │   │   ├── widgets/              # Visualization widgets
│   │   │   │   ├── timeseries.ts
│   │   │   │   ├── gauge.ts
│   │   │   │   ├── heatmap.ts
│   │   │   │   ├── table.ts
│   │   │   │   └── logs.ts
│   │   │   └── layouts.ts
│   │   ├── integrations/
│   │   │   ├── plugin-system.ts      # Plugin architecture
│   │   │   ├── logfn.ts              # logfn integration
│   │   │   ├── authfn.ts             # authfn integration
│   │   │   ├── billfn.ts             # billFn integration
│   │   │   ├── hostfn.ts             # hostfn integration
│   │   │   ├── sendfn.ts             # sendFn integration
│   │   │   └── custom.ts             # Custom integrations
│   │   ├── analysis/
│   │   │   ├── anomaly-detection.ts  # ML-based anomaly detection
│   │   │   ├── pattern-recognition.ts
│   │   │   ├── root-cause.ts         # Root cause analysis
│   │   │   └── insights.ts           # Auto-insights
│   │   └── utils/
│   │       ├── sampling.ts           # Smart sampling
│   │       ├── compression.ts        # Data compression
│   │       └── batching.ts           # Event batching
│   ├── examples/
│   └── tests/
│
├── python/                           # Python SDK
│   ├── pyproject.toml                # Package: watchfn
│   ├── README.md
│   ├── watchfn/
│   │   ├── __init__.py
│   │   ├── client.py
│   │   ├── models.py
│   │   ├── core/
│   │   ├── collectors/
│   │   ├── storage/
│   │   ├── http/                     # Uses superfunctions-fastapi/superfunctions-flask
│   │   ├── query/
│   │   ├── trace/
│   │   ├── alerts/
│   │   └── utils/
│   └── tests/
│
├── dashboard/                        # Optional web UI
│   ├── public/
│   ├── src/
│   └── package.json
│
├── agents/                           # Browser/Node agents
│   ├── browser/                      # Browser RUM agent
│   │   ├── src/
│   │   └── package.json
│   ├── node/                         # Node.js APM agent
│   │   ├── src/
│   │   └── package.json
│   └── python/                       # Python APM agent
│       └── pyproject.toml
│
└── cli/                              # CLI tool
    ├── src/
    └── package.json
```

## Technology Stack

### Core Technologies

**TypeScript SDK (`typescript/`):**

- **Language:** TypeScript 5.x (ESM-first)
- **Package Name:** `watchfn` (simple name, not scoped)
- **Build:** tsup for bundling
- **Testing:** Vitest with coverage
- **Validation:** Zod schemas for runtime type safety

**Python SDK (`python/`):**

- **Language:** Python 3.10+
- **Package Name:** `watchfn` (simple name, not scoped)
- **Validation:** Pydantic v2 for data models
- **Build:** hatch or poetry
- **Testing:** pytest with coverage

### Shared Package Dependencies

Following the **superfunctions ecosystem patterns**, WatchFn leverages shared packages for consistency and maintainability:

**Database Abstraction:**

- `@superfunctions/db` (TypeScript)
- `superfunctions` (Python core package)
- Adapter-based architecture supporting:
  - Drizzle ORM
  - Prisma
  - Kysely
  - SQLAlchemy (Python)
  - Memory adapter (for testing)

**HTTP Framework Adapters:**

- `@superfunctions/http` - Core HTTP abstraction layer
- `@superfunctions/http-express` - Express.js integration
- `@superfunctions/http-fastify` - Fastify integration
- `@superfunctions/http-hono` - Hono integration
- `@superfunctions/http-next` - Next.js integration
- `@superfunctions/http-sveltekit` - SvelteKit integration
- `superfunctions-fastapi` (Python) - FastAPI integration
- `superfunctions-flask` (Python) - Flask integration

**Authentication:**

- Optional integration with `authfn` for dashboard authentication
- API key management via `@superfunctions/auth`

### Package Dependencies

**TypeScript (`typescript/package.json`):**

```json
{
  "name": "watchfn",
  "dependencies": {
    "@superfunctions/db": "workspace:*",
    "@superfunctions/http": "workspace:*",
    "zod": "^3.x"
  },
  "peerDependencies": {
    "@superfunctions/http-express": "workspace:*",
    "@superfunctions/http-fastify": "workspace:*",
    "@superfunctions/http-hono": "workspace:*",
    "@superfunctions/http-next": "workspace:*",
    "@superfunctions/http-sveltekit": "workspace:*"
  },
  "devDependencies": {
    "@types/node": "^20.x",
    "tsup": "^8.x",
    "typescript": "^5.x",
    "vitest": "^2.x"
  }
}
```

**Python (`python/pyproject.toml`):**

```toml
[project]
name = "watchfn"
dependencies = [
  "superfunctions>=0.1.0",
  "pydantic>=2.6"
]

[project.optional-dependencies]
fastapi = ["superfunctions-fastapi>=0.1.0"]
flask = ["superfunctions-flask>=0.1.0"]
```

### Storage Backend Options

WatchFn uses the superfunctions database adapter pattern:

1. **PostgreSQL** (recommended for production)
   - Full SQL support
   - Time-series optimizations
   - Partitioning for large datasets
2. **SQLite** (great for development/single-instance)
   - Zero configuration
   - File-based storage
   - Full-text search support

3. **MySQL/MariaDB**
   - Wide compatibility
   - Good performance

4. **Memory** (testing/development)
   - Fast, ephemeral storage
   - Perfect for tests

Example configuration:

```typescript
import { watchFn } from "watchfn";
import { createDrizzleAdapter } from "@superfunctions/db";
import { drizzle } from "drizzle-orm/node-postgres";

const db = drizzle(process.env.DATABASE_URL);
const dbAdapter = createDrizzleAdapter(db);

const watch = watchFn({
  name: "my-app",
  database: dbAdapter,
  storage: "hybrid",
});
```

## Core Features

### 1. Application Performance Monitoring (APM)

Monitor application performance with automatic instrumentation for HTTP requests, database queries, external APIs, and custom operations.

#### Automatic HTTP Tracking

```typescript
import { watchFn } from "watchfn";

const watch = watchFn({
  name: "my-app",
  projectId: "prod-api",
  storage: "hybrid",
  apm: {
    enabled: true,
    autoInstrument: {
      http: true,
      database: true,
      redis: true,
      external: true,
    },
    sampleRate: 1.0,
    slowRequestThreshold: 1000,
  },
});

watch.start();
```

#### HTTP Framework Integration

WatchFn integrates seamlessly with popular HTTP frameworks using superfunctions adapters:

**Express.js:**

```typescript
import express from "express";
import { watchFn } from "watchfn";
import { createExpressRouter } from "watchfn/adapters/express";

const app = express();
const watch = watchFn({ name: "my-app" });

// Mount WatchFn API endpoints
app.use("/watch", createExpressRouter(watch));

// Instrument your app
watch.start();
```

**Fastify:**

```typescript
import Fastify from "fastify";
import { watchFn } from "watchfn";
import { createFastifyPlugin } from "watchfn/adapters/fastify";

const fastify = Fastify();
const watch = watchFn({ name: "my-app" });

await fastify.register(createFastifyPlugin(watch), {
  prefix: "/watch",
});

watch.start();
```

**Hono:**

```typescript
import { Hono } from "hono";
import { watchFn } from "watchfn";
import { createHonoRouter } from "watchfn/adapters/hono";

const app = new Hono();
const watch = watchFn({ name: "my-app" });

app.route("/watch", createHonoRouter(watch));
watch.start();
```

**Next.js:**

```typescript
// app/api/watch/[...watchfn]/route.ts
import { watchFn } from "watchfn";
import { createNextHandler } from "watchfn/adapters/next";

const watch = watchFn({ name: "my-app" });

export const { GET, POST } = createNextHandler(watch);
```

**SvelteKit:**

```typescript
// src/routes/watch/[...path]/+server.ts
import { watchFn } from "watchfn";
import { createSvelteKitHandler } from "watchfn/adapters/sveltekit";

const watch = watchFn({ name: "my-app" });

export const { GET, POST } = createSvelteKitHandler(watch);
```

**Python FastAPI:**

```python
from fastapi import FastAPI
from watchfn import WatchFn
from watchfn.adapters.fastapi import create_router

app = FastAPI()
watch = WatchFn(name="my-app")

# Mount WatchFn API endpoints
app.include_router(create_router(watch), prefix="/watch")

watch.start()
```

**Python Flask:**

```python
from flask import Flask
from watchfn import WatchFn
from watchfn.adapters.flask import create_blueprint

app = Flask(__name__)
watch = WatchFn(name="my-app")

# Register WatchFn blueprint
app.register_blueprint(create_blueprint(watch), url_prefix="/watch")

watch.start()
```

#### Manual Tracking

```typescript
watch.track("api.request", {
  endpoint: "/api/users",
  method: "GET",
  duration: 245,
  statusCode: 200,
  userId: "user123",
  userAgent: "Mozilla/5.0...",
});

const transaction = watch.startTransaction("order.process");

const span1 = transaction.startSpan("validate.order");
await validateOrder(orderData);
span1.finish();

const span2 = transaction.startSpan("payment.process");
await processPayment(paymentData);
span2.finish();

transaction.finish();
```

#### Query Performance Metrics

```typescript
const slowRequests = await watch.query({
  metric: "api.request",
  where: {
    duration: { gt: 1000 },
    statusCode: { gte: 500 },
  },
  timeRange: "last-24h",
  groupBy: "endpoint",
  orderBy: { field: "duration", direction: "desc" },
  limit: 100,
});

const avgResponseTime = await watch.aggregate({
  metric: "api.request.duration",
  aggregation: "avg",
  timeRange: "last-1h",
  groupBy: { interval: "5m" },
});
```

### 2. Error Tracking & Exception Monitoring

Capture, deduplicate, and track errors with full context, source maps, and breadcrumbs.

#### Automatic Error Capture

```typescript
const watch = watchFn({
  name: "my-app",
  errors: {
    enabled: true,
    captureUnhandled: true,
    captureRejections: true,
    beforeSend: (event) => {
      if (event.user?.email?.includes("@internal.com")) {
        return null;
      }
      return event;
    },
    ignoreErrors: [
      "ResizeObserver loop limit exceeded",
      /Network request failed/i,
    ],
  },
});
```

#### Manual Error Capture

```typescript
try {
  await processPayment(data);
} catch (error) {
  watch.captureException(error, {
    level: "error",
    context: {
      userId: "user123",
      action: "checkout",
      environment: "production",
      amount: 99.99,
    },
    breadcrumbs: [
      { type: "navigation", data: { from: "/cart", to: "/checkout" } },
      { type: "api", data: { endpoint: "/api/payment", status: 500 } },
      { type: "user", data: { action: "click", target: "pay-button" } },
    ],
    tags: ["payment", "critical"],
    fingerprint: ["payment-gateway-error"],
  });
}

watch.captureMessage("Payment gateway slow", {
  level: "warning",
  context: { gateway: "stripe", duration: 3500 },
});
```

#### Error Analysis

```typescript
const errorGroups = await watch.errors.query({
  timeRange: "last-7d",
  groupBy: "fingerprint",
  orderBy: { field: "count", direction: "desc" },
  status: "unresolved",
});

await watch.errors.markResolved("error-group-123", {
  resolution: "fixed-in-v1.2.3",
  resolvedBy: "user@example.com",
});

const errorTrend = await watch.errors.getTrend({
  groupId: "error-group-123",
  timeRange: "last-30d",
  interval: "1d",
});
```

### 3. Real-User Monitoring (RUM)

Track real user experience metrics including page loads, Core Web Vitals, and user interactions.

#### Browser Agent Setup

```typescript
import { watchFnRUM } from "watchfn/browser";

const rum = watchFnRUM({
  projectId: "prod-web",
  endpoint: "https://watch.example.com/ingest",
  sampleRate: 0.1,
  trackPageViews: true,
  trackWebVitals: true,
  trackInteractions: true,
  trackErrors: true,
  beforeSend: (event) => {
    event.user = { id: getCurrentUserId() };
    return event;
  },
});

rum.start();
```

#### Manual RUM Events

```typescript
rum.trackPageView({
  path: "/products/123",
  title: "Product Details",
  referrer: document.referrer,
});

rum.trackInteraction({
  type: "click",
  target: "add-to-cart-button",
  metadata: { productId: "123", price: 99.99 },
});

rum.trackCustomMetric("checkout.completed", {
  duration: 4500,
  items: 3,
  total: 299.97,
});
```

#### Web Vitals Analysis

```typescript
const webVitals = await watch.rum.getWebVitals({
  timeRange: "last-7d",
  groupBy: "device",
  metrics: ["LCP", "FID", "CLS", "FCP", "TTFB"],
});

const pageLoadPerformance = await watch.rum.getPageLoads({
  timeRange: "last-24h",
  page: "/checkout",
  percentiles: [50, 75, 90, 95, 99],
});

const userJourney = await watch.rum.getUserJourney({
  userId: "user123",
  timeRange: "last-1h",
});
```

### 4. Synthetic Monitoring & Uptime Checks

Proactively monitor endpoints and user flows with scheduled checks from multiple locations.

#### HTTP/API Monitoring

```typescript
const httpCheck = await watch.synthetics.create({
  name: "api-health-check",
  type: "http",
  url: "https://api.example.com/health",
  method: "GET",
  headers: {
    Authorization: "Bearer ${API_TOKEN}",
  },
  interval: "1m",
  timeout: 5000,
  retries: 2,
  assertions: [
    { type: "status", operator: "eq", value: 200 },
    { type: "responseTime", operator: "lt", value: 500 },
    { type: "body", operator: "contains", value: "healthy" },
    {
      type: "header",
      key: "content-type",
      operator: "contains",
      value: "json",
    },
  ],
  locations: ["us-east", "eu-west", "asia-southeast"],
  alerts: {
    consecutive_failures: 3,
    channels: ["email", "slack", "pagerduty"],
  },
});
```

#### Browser-based User Flow Monitoring

```typescript
const browserCheck = await watch.synthetics.create({
  name: "user-login-flow",
  type: "browser",
  startUrl: "https://example.com/login",
  interval: "5m",
  timeout: 30000,
  script: async (page) => {
    await page.waitForSelector("input[name=email]");
    await page.fill("input[name=email]", "test@example.com");
    await page.fill("input[name=password]", "test-password");

    await page.click("button[type=submit]");

    await page.waitForSelector(".dashboard", { timeout: 5000 });

    const title = await page.textContent("h1");
    expect(title).toBe("Dashboard");

    const apiResponse = await page.waitForResponse((resp) =>
      resp.url().includes("/api/user")
    );
    expect(apiResponse.status()).toBe(200);
  },
  locations: ["us-east"],
  alerts: {
    consecutive_failures: 2,
    channels: ["slack"],
  },
});
```

#### Uptime & Performance Reports

```typescript
const uptime = await watch.synthetics.getUptime({
  checkId: "api-health-check",
  timeRange: "last-30d",
});

const incidents = await watch.synthetics.getIncidents({
  checkId: "api-health-check",
  timeRange: "last-7d",
  status: "resolved",
});

const performanceTrend = await watch.synthetics.getPerformanceTrend({
  checkId: "api-health-check",
  metric: "responseTime",
  timeRange: "last-24h",
  interval: "1h",
});
```

### 5. Infrastructure Monitoring

Monitor system resources, processes, and containers with automatic metric collection.

#### System Metrics

```typescript
const infra = watch.infra.monitor({
  enabled: true,
  interval: "30s",
  metrics: {
    cpu: {
      enabled: true,
      thresholds: {
        warning: 70,
        critical: 90,
      },
    },
    memory: {
      enabled: true,
      thresholds: {
        warning: 80,
        critical: 95,
      },
    },
    disk: {
      enabled: true,
      paths: ["/"],
      thresholds: {
        warning: 85,
        critical: 95,
      },
    },
    network: {
      enabled: true,
      interfaces: ["eth0"],
    },
  },
  tags: {
    server: "prod-server-1",
    region: "us-east",
    environment: "production",
  },
});
```

#### Process Monitoring

```typescript
watch.infra.monitorProcess({
  pid: process.pid,
  name: "api-server",
  metrics: ["cpu", "memory", "handles", "threads"],
  interval: "30s",
});

const processMetrics = await watch.infra.getProcessMetrics({
  name: "api-server",
  timeRange: "last-1h",
  metrics: ["cpu", "memory"],
});
```

#### Infrastructure Health

```typescript
const serverHealth = await watch.infra.getHealth({
  servers: ["prod-server-*"],
  timeRange: "last-1h",
  includeMetrics: true,
});

const resourceUsage = await watch.infra.getResourceUsage({
  server: "prod-server-1",
  metric: "cpu",
  timeRange: "last-24h",
  interval: "5m",
  aggregation: "avg",
});
```

### 6. Distributed Tracing

Track requests across services with distributed tracing and span analysis.

#### Automatic Tracing

```typescript
const watch = watchFn({
  name: "my-service",
  trace: {
    enabled: true,
    sampleRate: 0.1,
    propagation: ["traceparent", "baggage"],
    serviceName: "api-gateway",
  },
});
```

#### Manual Trace Creation

```typescript
const trace = watch.trace.start({
  operation: "order.process",
  traceId: generateTraceId(),
  tags: {
    orderId: "order-123",
    userId: "user-456",
  },
});

const span1 = trace.span("validate.order", async () => {
  await validateOrder(orderData);
});

const span2 = trace.span("inventory.check", async () => {
  await checkInventory(orderData.items);
});

const span3 = trace.span(
  "payment.process",
  async () => {
    await processPayment(paymentData);
  },
  {
    tags: { gateway: "stripe", amount: 99.99 },
  }
);

await trace.finish();
```

#### Trace Queries

```typescript
const slowTraces = await watch.trace.query({
  operation: "order.process",
  duration: { gt: 2000 },
  timeRange: "last-1h",
  orderBy: { field: "duration", direction: "desc" },
  limit: 50,
});

const traceDetails = await watch.trace.getTrace({
  traceId: "trace-abc-123",
  includeSpans: true,
  includeLogs: true,
});

const serviceMap = await watch.trace.getServiceMap({
  timeRange: "last-24h",
  minCalls: 10,
});
```

### 7. Log Aggregation & Analysis

Integrate with logfn for centralized log management and analysis.

#### Log Integration

```typescript
import { logFn } from "@logfn/core";
import { watchFn } from "watchfn";

const logger = logFn({ name: "app" });
const watch = watchFn({ name: "app" });

watch.use(logger, {
  autoIngest: true,
  parseStructured: true,
  indexFields: ["level", "service", "userId", "traceId"],
});

logger.error("Payment failed", {
  userId: "user123",
  orderId: "order-456",
  error: "CARD_DECLINED",
});
```

#### Log Queries

```typescript
const errorLogs = await watch.logs.query({
  level: "error",
  timeRange: "last-24h",
  search: "payment failed",
  filters: {
    service: "api-gateway",
    userId: { exists: true },
  },
  limit: 1000,
});

const logStats = await watch.logs.aggregate({
  timeRange: "last-1h",
  groupBy: ["level", "service"],
  aggregation: "count",
});
```

#### Log Pattern Detection

```typescript
await watch.logs.createPattern({
  name: "auth-failures",
  pattern: /authentication failed/i,
  threshold: {
    count: 10,
    window: "5m",
  },
  alert: {
    enabled: true,
    severity: "warning",
    channels: ["slack"],
  },
});

const patterns = await watch.logs.detectPatterns({
  timeRange: "last-24h",
  minOccurrences: 5,
  fields: ["message", "error"],
});
```

### 8. Business Metrics & KPI Tracking

Track business-critical metrics and KPIs alongside technical metrics.

#### Custom Business Events

```typescript
watch.business.track("signup.completed", {
  userId: "user123",
  plan: "pro",
  revenue: 99,
  source: "organic",
  campaign: "summer-sale",
});

watch.business.track("purchase.completed", {
  userId: "user456",
  orderId: "order-789",
  items: 3,
  subtotal: 249.97,
  tax: 20.0,
  total: 269.97,
  paymentMethod: "credit-card",
});

watch.business.track("feature.used", {
  userId: "user123",
  feature: "export-data",
  plan: "pro",
});
```

#### Goals & Targets

```typescript
await watch.business.createGoal({
  name: "monthly-revenue",
  target: 100000,
  metric: "purchase.completed.total",
  aggregation: "sum",
  period: "month",
  startDate: "2026-01-01",
  alerts: {
    on_track_check: "50%",
    notify_below_pace: true,
    channels: ["email"],
  },
});

const goalProgress = await watch.business.getGoalProgress({
  name: "monthly-revenue",
  date: "2026-01-09",
});
```

#### Conversion Funnels

```typescript
const funnel = await watch.business.createFunnel({
  name: "purchase-funnel",
  steps: [
    { event: "page_view", filters: { page: "/products" } },
    { event: "product.viewed" },
    { event: "cart.add" },
    { event: "checkout.started" },
    { event: "purchase.completed" },
  ],
  timeWindow: "1h",
});

const funnelData = await watch.business.getFunnel({
  name: "purchase-funnel",
  timeRange: "last-30d",
  groupBy: "source",
});

const dropoffAnalysis = await watch.business.getDropoffAnalysis({
  funnel: "purchase-funnel",
  step: 2,
  timeRange: "last-7d",
});
```

#### Revenue Analytics

```typescript
const revenue = await watch.business.getRevenue({
  timeRange: "last-30d",
  interval: "1d",
  groupBy: "plan",
});

const mrr = await watch.business.getMRR({
  date: "2026-01-09",
  breakdown: ["plan", "region"],
});

const churnRate = await watch.business.getChurnRate({
  period: "month",
  date: "2026-01-01",
});

const ltv = await watch.business.getLTV({
  cohort: "signups-2025-12",
  projection: "12-months",
});
```

### 9. Alerting & Notification System

Create sophisticated alerts with multiple channels and smart escalation.

#### Alert Configuration

```typescript
await watch.alerts.create({
  name: "high-error-rate",
  description: "Alert when error rate exceeds 5% for 5 minutes",
  enabled: true,
  condition: {
    metric: "error.rate",
    operator: "gt",
    threshold: 5,
    window: "5m",
    aggregation: "avg",
  },
  channels: [
    {
      type: "email",
      recipients: ["team@example.com", "oncall@example.com"],
    },
    {
      type: "slack",
      webhook: process.env.SLACK_WEBHOOK,
      channel: "#alerts-production",
    },
    {
      type: "pagerduty",
      integrationKey: process.env.PD_INTEGRATION_KEY,
      severity: "critical",
    },
  ],
  severity: "critical",
  tags: ["production", "errors"],
  runbook: "https://docs.example.com/runbooks/high-error-rate",
  autoResolve: {
    enabled: true,
    condition: {
      metric: "error.rate",
      operator: "lt",
      threshold: 1,
      window: "10m",
    },
  },
});
```

#### Complex Alert Conditions

```typescript
await watch.alerts.create({
  name: "api-performance-degradation",
  condition: {
    type: "composite",
    operator: "and",
    conditions: [
      {
        metric: "api.request.duration.p95",
        operator: "gt",
        threshold: 1000,
        window: "5m",
      },
      {
        metric: "api.request.count",
        operator: "gt",
        threshold: 100,
        window: "5m",
      },
    ],
  },
  channels: [{ type: "slack", webhook: process.env.SLACK_WEBHOOK }],
  severity: "warning",
});

await watch.alerts.create({
  name: "anomaly-detection",
  condition: {
    type: "anomaly",
    metric: "api.request.count",
    sensitivity: 0.8,
    minDataPoints: 100,
    algorithm: "moving-average",
  },
  channels: [{ type: "email", recipients: ["team@example.com"] }],
});
```

#### Alert Lifecycle

```typescript
watch.alerts.onTrigger(async (alert, context) => {
  console.log("Alert triggered:", alert.name);
  console.log("Current value:", context.value);
  console.log("Threshold:", context.threshold);

  const relatedLogs = await watch.logs.query({
    timeRange: [context.triggeredAt - 300000, context.triggeredAt],
    level: "error",
  });

  const relatedTraces = await watch.trace.query({
    timeRange: [context.triggeredAt - 300000, context.triggeredAt],
    status: "error",
  });

  await watch.alerts.addNote(alert.id, {
    content: `Found ${relatedLogs.length} error logs and ${relatedTraces.length} failed traces`,
    createdBy: "system",
  });
});

watch.alerts.onResolve(async (alert, context) => {
  console.log("Alert resolved:", alert.name);
  console.log("Duration:", context.duration);
});

await watch.alerts.acknowledge("alert-123", {
  acknowledgedBy: "user@example.com",
  note: "Investigating the issue",
});

await watch.alerts.resolve("alert-123", {
  resolvedBy: "user@example.com",
  resolution: "Fixed by scaling up database connections",
});
```

### 10. Custom Dashboards & Visualizations

Build custom dashboards with flexible widgets and layouts.

#### Dashboard Creation

```typescript
const dashboard = await watch.dashboard.create({
  name: "API Performance Overview",
  description: "Real-time API performance metrics",
  tags: ["api", "production"],
  layout: "grid",
  autoRefresh: "30s",
  timeRange: "last-1h",
  widgets: [
    {
      id: "request-rate",
      type: "timeseries",
      title: "Request Rate",
      position: { x: 0, y: 0, w: 6, h: 3 },
      query: {
        metric: "api.request",
        aggregation: "count",
        groupBy: { interval: "1m" },
      },
      visualization: {
        chartType: "line",
        colors: ["#3b82f6"],
        legend: true,
        yAxis: { label: "Requests/min" },
      },
    },
    {
      id: "error-rate",
      type: "gauge",
      title: "Error Rate",
      position: { x: 6, y: 0, w: 3, h: 3 },
      query: {
        metric: "api.error",
        aggregation: "rate",
      },
      visualization: {
        min: 0,
        max: 10,
        thresholds: [
          { value: 1, color: "green" },
          { value: 2, color: "yellow" },
          { value: 5, color: "red" },
        ],
        unit: "%",
      },
    },
    {
      id: "response-time-heatmap",
      type: "heatmap",
      title: "Response Time by Endpoint",
      position: { x: 0, y: 3, w: 9, h: 4 },
      query: {
        metric: "api.request.duration",
        aggregation: "avg",
        groupBy: ["endpoint", { interval: "5m" }],
      },
      visualization: {
        colorScheme: "blues",
        legend: true,
      },
    },
    {
      id: "top-endpoints",
      type: "table",
      title: "Top 10 Slowest Endpoints",
      position: { x: 9, y: 0, w: 3, h: 7 },
      query: {
        metric: "api.request.duration",
        aggregation: "p95",
        groupBy: "endpoint",
        orderBy: { field: "value", direction: "desc" },
        limit: 10,
      },
      visualization: {
        columns: [
          { field: "endpoint", label: "Endpoint" },
          { field: "value", label: "P95 (ms)", format: "number" },
        ],
      },
    },
    {
      id: "recent-errors",
      type: "logs",
      title: "Recent Errors",
      position: { x: 0, y: 7, w: 12, h: 3 },
      query: {
        level: "error",
        limit: 50,
        orderBy: { field: "timestamp", direction: "desc" },
      },
      visualization: {
        columns: ["timestamp", "level", "message", "service"],
        compact: true,
      },
    },
  ],
});
```

#### Dashboard Sharing & Export

```typescript
const shareUrl = await watch.dashboard.share("dashboard-123", {
  public: false,
  expiry: "7d",
  allowedUsers: ["team-member@example.com"],
});

await watch.dashboard.export("dashboard-123", {
  format: "json",
  outputPath: "./dashboards/api-performance.json",
});

const snapshot = await watch.dashboard.snapshot("dashboard-123", {
  format: "png",
  width: 1920,
  height: 1080,
});
```

## Integrations with Other Superfunctions

### Integration with logfn

```typescript
import { logFn } from "@logfn/core";
import { watchFn } from "watchfn";

const logger = logFn({
  name: "app",
  outputs: ["console", "file"],
});

const watch = watchFn({
  name: "app",
  integrations: {
    logfn: {
      enabled: true,
      autoIngest: true,
      parseStructured: true,
      indexFields: ["level", "service", "userId", "traceId", "error"],
      minLevel: "info",
    },
  },
});

watch.use(logger);

logger.info("User logged in", { userId: "user123", ip: "192.168.1.1" });
logger.error("Database connection failed", {
  error: "ECONNREFUSED",
  host: "db.example.com",
});
```

### Integration with authfn

```typescript
import { authFn } from "authfn";
import { watchFn } from "watchfn";

const auth = authFn({ name: "app" });
const watch = watchFn({
  name: "app",
  integrations: {
    authfn: {
      enabled: true,
      trackEvents: ["login", "logout", "signup", "password_reset", "mfa"],
      detectAnomalies: {
        bruteForce: {
          enabled: true,
          threshold: 5,
          window: "5m",
        },
        accountTakeover: {
          enabled: true,
          multipleLocations: true,
          impossibleTravel: true,
        },
        suspiciousActivity: {
          enabled: true,
          unusualHours: true,
          unusualLocation: true,
        },
      },
    },
  },
});

watch.use(auth);

auth.on("login.success", (event) => {
  watch.track("auth.login", {
    userId: event.userId,
    ip: event.ip,
    userAgent: event.userAgent,
    mfaUsed: event.mfaUsed,
  });
});

auth.on("login.failed", (event) => {
  watch.track("auth.login.failed", {
    email: event.email,
    ip: event.ip,
    reason: event.reason,
  });
});

const suspiciousLogins = await watch.query({
  metric: "auth.login",
  where: {
    mfaUsed: false,
    ip: { notIn: ["known-ip-list"] },
  },
  timeRange: "last-24h",
});
```

### Integration with billFn

```typescript
import { billFn } from "billfn";
import { watchFn } from "watchfn";

const billing = billFn({ name: "app" });
const watch = watchFn({
  name: "app",
  integrations: {
    billfn: {
      enabled: true,
      trackEvents: [
        "subscription_created",
        "subscription_updated",
        "subscription_canceled",
        "payment_succeeded",
        "payment_failed",
        "invoice_created",
      ],
      analytics: {
        mrr: true,
        churn: true,
        ltv: true,
        arr: true,
      },
    },
  },
});

watch.use(billing);

billing.on("payment.succeeded", (event) => {
  watch.business.track("revenue", {
    userId: event.userId,
    amount: event.amount,
    plan: event.plan,
    currency: event.currency,
  });
});

const revenueAnalytics = await watch.business.getRevenue({
  timeRange: "last-30d",
  interval: "1d",
  groupBy: ["plan", "region"],
});

const churnAlerts = await watch.alerts.create({
  name: "high-churn-rate",
  condition: {
    metric: "billing.churn.rate",
    operator: "gt",
    threshold: 5,
    window: "7d",
  },
  channels: [{ type: "email", recipients: ["finance@example.com"] }],
});
```

### Integration with hostfn

```typescript
import { hostFn } from "hostfn";
import { watchFn } from "watchfn";

const host = hostFn({ name: "app" });
const watch = watchFn({
  name: "app",
  integrations: {
    hostfn: {
      enabled: true,
      trackDeployments: true,
      compareBeforeAfter: {
        enabled: true,
        beforeWindow: "5m",
        afterWindow: "5m",
        metrics: ["error_rate", "latency", "request_rate"],
      },
      autoRollback: {
        enabled: true,
        conditions: {
          errorRateIncrease: 50,
          latencyIncrease: 100,
          availability: 95,
        },
      },
    },
  },
});

watch.use(host);

host.on("deploy.started", (event) => {
  watch.track("deployment.started", {
    version: event.version,
    environment: event.environment,
    deployedBy: event.deployedBy,
  });
});

host.on("deploy.completed", async (event) => {
  watch.track("deployment.completed", {
    deploymentId: event.deploymentId,
    version: event.version,
    duration: event.duration,
  });

  const metrics = await watch.compareDeploymentMetrics({
    deploymentId: event.deploymentId,
    beforeWindow: "5m",
    afterWindow: "5m",
  });

  if (metrics.errorRate.increase > 50) {
    await host.rollback(event.deploymentId);
    await watch.alerts.trigger("deployment-rollback", {
      reason: "High error rate after deployment",
      metrics,
    });
  }
});
```

### Integration with sendFn

```typescript
import { sendFn } from "sendfn";
import { watchFn } from "watchfn";

const send = sendFn({ name: "app" });
const watch = watchFn({
  name: "app",
  integrations: {
    sendfn: {
      enabled: true,
      trackEvents: [
        "email.sent",
        "email.delivered",
        "email.opened",
        "email.clicked",
        "email.bounced",
        "sms.sent",
        "sms.delivered",
      ],
      analytics: {
        deliveryRate: true,
        openRate: true,
        clickRate: true,
        bounceRate: true,
      },
    },
  },
});

watch.use(send);

send.on("email.sent", (event) => {
  watch.track("communication.sent", {
    channel: "email",
    userId: event.userId,
    template: event.template,
    campaign: event.campaign,
  });
});

const emailPerformance = await watch.query({
  metric: "communication.sent",
  where: { channel: "email" },
  timeRange: "last-30d",
  groupBy: "template",
});

const deliveryIssues = await watch.alerts.create({
  name: "low-email-delivery-rate",
  condition: {
    metric: "email.delivery.rate",
    operator: "lt",
    threshold: 95,
    window: "1h",
  },
  channels: [{ type: "slack", webhook: process.env.SLACK_WEBHOOK }],
});
```

## Storage & Data Retention

### Multi-Tier Storage Strategy

```typescript
const watch = watchFn({
  name: "app",
  storage: {
    type: "hybrid",
    tiers: [
      {
        name: "hot",
        type: "memory",
        retention: "1h",
        maxSize: 100_000,
        maxBytes: 100 * 1024 * 1024,
      },
      {
        name: "warm",
        type: "indexeddb",
        retention: "24h",
        maxSize: 1_000_000,
        maxBytes: 500 * 1024 * 1024,
      },
      {
        name: "cold",
        type: "database",
        retention: "30d",
        maxSize: 10_000_000,
        compression: true,
      },
      {
        name: "archive",
        type: "file",
        retention: "365d",
        compression: true,
        path: "./watchfn-archive",
      },
    ],
  },
});
```

### Data Aggregation

```typescript
const watch = watchFn({
  name: "app",
  aggregation: {
    enabled: true,
    rules: [
      {
        metric: "api.request",
        intervals: ["1m", "5m", "1h", "1d"],
        aggregations: ["count", "avg", "min", "max", "p50", "p95", "p99"],
        retention: {
          "1m": "24h",
          "5m": "7d",
          "1h": "30d",
          "1d": "365d",
        },
      },
    ],
  },
});
```

### Sampling

```typescript
const watch = watchFn({
  name: "app",
  sampling: {
    traces: {
      strategy: "adaptive",
      baseRate: 0.1,
      errorRate: 1.0,
      slowRate: 1.0,
      slowThreshold: 1000,
    },
    rum: {
      strategy: "fixed",
      rate: 0.1,
    },
    logs: {
      strategy: "level-based",
      rates: {
        error: 1.0,
        warn: 0.5,
        info: 0.1,
        debug: 0.01,
      },
    },
  },
});
```

## Query Language

### Query Syntax

```typescript
const results = await watch.query({
  metric: "api.request.duration",
  where: {
    endpoint: { eq: "/api/users" },
    statusCode: { gte: 200, lt: 300 },
    userId: { exists: true },
    duration: { gt: 1000 },
  },
  timeRange: {
    from: "2026-01-09T00:00:00Z",
    to: "2026-01-09T23:59:59Z",
  },
  groupBy: ["endpoint", { interval: "5m" }],
  aggregations: {
    count: { operation: "count" },
    avg_duration: { operation: "avg", field: "duration" },
    p95_duration: {
      operation: "percentile",
      field: "duration",
      percentile: 95,
    },
    max_duration: { operation: "max", field: "duration" },
  },
  orderBy: { field: "avg_duration", direction: "desc" },
  limit: 100,
});
```

### Time Range Shortcuts

```typescript
watch.query({ timeRange: "last-15m" });
watch.query({ timeRange: "last-1h" });
watch.query({ timeRange: "last-24h" });
watch.query({ timeRange: "last-7d" });
watch.query({ timeRange: "last-30d" });
watch.query({ timeRange: "today" });
watch.query({ timeRange: "yesterday" });
watch.query({ timeRange: "this-week" });
watch.query({ timeRange: "this-month" });
```

### Advanced Aggregations

```typescript
const results = await watch.query({
  metric: "api.request",
  timeRange: "last-24h",
  aggregations: {
    total_requests: { operation: "count" },
    unique_users: { operation: "count_distinct", field: "userId" },
    avg_duration: { operation: "avg", field: "duration" },
    median_duration: {
      operation: "percentile",
      field: "duration",
      percentile: 50,
    },
    p95_duration: {
      operation: "percentile",
      field: "duration",
      percentile: 95,
    },
    p99_duration: {
      operation: "percentile",
      field: "duration",
      percentile: 99,
    },
    error_rate: {
      operation: "rate",
      numerator: { metric: "api.error" },
      denominator: { metric: "api.request" },
    },
  },
  groupBy: "endpoint",
});
```

## CLI Tool

### Installation

```bash
npm install -g watchfn-cli
```

### Usage

```bash
watchfn query "api.request.duration > 1000" --time "last-1h" --limit 100

watchfn tail --follow --filter "level:error"

watchfn alerts list --status active

watchfn alerts acknowledge alert-123

watchfn dashboard view api-performance

watchfn export metrics --metric "api.request" --time "last-30d" --format csv

watchfn analyze errors --group-by fingerprint --time "last-7d"

watchfn trace view trace-abc-123

watchfn synthetics test api-health-check

watchfn infra status --server "prod-*"
```

## Dashboard UI

### Features

- **Real-time Updates**: WebSocket-based live data streaming
- **Custom Dashboards**: Drag-and-drop dashboard builder
- **Interactive Visualizations**: Zoom, pan, and drill-down capabilities
- **Dark Mode**: Eye-friendly dark theme
- **Mobile Responsive**: Works on all devices
- **Shareable**: Public and private dashboard sharing
- **Embeddable**: Embed charts in external applications

### Views

1. **Overview**: High-level system health and key metrics
2. **APM**: Application performance metrics and traces
3. **Errors**: Error tracking and analysis
4. **Traces**: Distributed tracing explorer
5. **Infrastructure**: System and process metrics
6. **Logs**: Log viewer and search
7. **RUM**: Real-user monitoring and web vitals
8. **Business**: Business metrics and KPIs
9. **Alerts**: Alert management and history
10. **Synthetics**: Uptime and synthetic monitoring

## Performance Characteristics

### Ingestion

- **Throughput**: 100,000+ events/second (single instance)
- **Latency**: <10ms (p99) for event ingestion
- **Batching**: Automatic batching for optimal performance
- **Backpressure**: Built-in flow control and rate limiting

### Storage

- **Compression**: 10:1 compression ratio for time-series data
- **Indexing**: Sub-second queries on millions of events
- **Retention**: Configurable per metric type
- **Cost**: Optimized for storage efficiency

### Queries

- **Simple Queries**: <100ms (p95)
- **Aggregations**: <500ms (p95) for 24h of data
- **Complex Queries**: <2s (p95) for 30d of data
- **Concurrent Queries**: 1000+ queries/second

## Security & Privacy

### Data Privacy

- Self-hosted by default
- No data sent to external services
- Configurable data masking
- PII detection and redaction

### Authentication & Authorization

```typescript
const watch = watchFn({
  name: "app",
  auth: {
    enabled: true,
    apiKey: process.env.WATCHFN_API_KEY,
    allowedOrigins: ["https://example.com"],
    rateLimits: {
      ingestion: 10000,
      query: 1000,
    },
  },
});
```

### Encryption

- Data encrypted at rest (optional)
- TLS/SSL for data in transit
- API key rotation
- Audit logging

## Browser Support

- Chrome/Edge 90+
- Firefox 88+
- Safari 14+
- Mobile browsers (iOS Safari, Chrome Mobile)

## Node.js Support

- Node.js 18+
- Works with CommonJS and ESM
- TypeScript 5.0+

## Roadmap

### v1.0 (Q3 2026)

- ✅ Core SDK and API
- ✅ APM with auto-instrumentation
- ✅ Error tracking
- ✅ RUM (browser agent)
- ✅ Distributed tracing
- ✅ Infrastructure monitoring
- ✅ Log integration (logfn)
- ✅ Alerting system
- ✅ Custom dashboards
- ✅ Synthetic monitoring
- ✅ Business metrics
- ✅ Query language
- ✅ CLI tool
- ✅ Dashboard UI

### v1.1 (Q4 2026)

- Session replay
- Advanced anomaly detection
- AI-powered insights
- Mobile SDK (React Native)
- Python agent
- More integrations (Redis, RabbitMQ, Kafka)

### v2.0 (2027)

- Multi-tenant support
- Advanced RBAC
- Custom visualizations
- GraphQL API
- Advanced correlation analysis
- Predictive analytics

## Comparison with Existing Tools

| Feature               | WatchFn | Sentry  | DataDog | New Relic | BetterStack |
| --------------------- | ------- | ------- | ------- | --------- | ----------- |
| Self-hosted           | ✅      | ❌      | ❌      | ❌        | ❌          |
| Open Source           | ✅      | Partial | ❌      | ❌        | ❌          |
| APM                   | ✅      | ✅      | ✅      | ✅        | ✅          |
| Error Tracking        | ✅      | ✅      | ✅      | ✅        | ✅          |
| RUM                   | ✅      | Limited | ✅      | ✅        | ✅          |
| Distributed Tracing   | ✅      | ✅      | ✅      | ✅        | ✅          |
| Infrastructure        | ✅      | ❌      | ✅      | ✅        | ✅          |
| Logs                  | ✅      | ❌      | ✅      | ✅        | ✅          |
| Synthetic Monitoring  | ✅      | Limited | ✅      | ✅        | ✅          |
| Business Metrics      | ✅      | ❌      | Limited | Limited   | ❌          |
| Unlimited Events      | ✅      | ❌      | ❌      | ❌        | ❌          |
| No Vendor Lock-in     | ✅      | ❌      | ❌      | ❌        | ❌          |
| Ecosystem Integration | ✅      | ❌      | ❌      | ❌        | ❌          |

## License

MIT

## Contributing

Contributions welcome! See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## Support

- GitHub Issues: https://github.com/21nCo/super-functions/issues
- Discord: https://discord.com/invite/9HJqKYTZKg
- Email: hello@21n.org

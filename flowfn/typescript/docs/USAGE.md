# FlowFn Usage Guide

Practical guide to building with FlowFn.

## Quick Start

### Installation

```bash
npm install @flowfn/core
```

### Basic Setup

```typescript
import { createFlow } from "@flowfn/core";

const flow = createFlow({
  adapter: "memory", // or 'redis', 'postgres'
});
```

---

## Common Patterns

### 1. Background Job Processing

```typescript
const emailQueue = flow.queue("emails");

// Producer: Add jobs
await emailQueue.add("send-welcome", {
  to: "user@example.com",
  template: "welcome",
});

// Consumer: Process jobs
emailQueue.process(async (job) => {
  await sendEmail(job.data.to, job.data.template);
  return { sent: true };
});
```

### 2. Job with Retries

```typescript
await queue.add(
  "api-call",
  { url: "/api/data" },
  {
    attempts: 5,
    backoff: {
      type: "exponential",
      delay: 1000,
      maxDelay: 60000,
    },
  }
);
```

### 3. Scheduled Jobs

```typescript
await queue.add(
  "daily-report",
  {},
  {
    delay: calculateDelayUntilMidnight(),
  }
);
```

### 4. Job Dependencies

```typescript
const job1 = await queue.add("fetch-data", {});
const job2 = await queue.add(
  "process-data",
  {},
  {
    waitFor: [job1.id], // Waits for job1 to complete
  }
);
```

### 5. Batch Processing

```typescript
queue.processBatch(
  "bulk-import",
  {
    batchSize: 100,
    maxWait: 5000,
  },
  async (jobs) => {
    const data = jobs.map((j) => j.data);
    await bulkInsert(data);
    return jobs.map(() => ({ success: true }));
  }
);
```

---

## Event Streaming

### 1. Pub/Sub Pattern

```typescript
const events = flow.stream("user-events");

// Publisher
await events.publish({
  type: "user.created",
  userId: "123",
  timestamp: Date.now(),
});

// Subscriber
await events.subscribe(async (message) => {
  console.log("Event:", message.data);
  await message.ack();
});
```

### 2. Consumer Groups

```typescript
// Multiple workers processing same stream
const consumer1 = events.createConsumer("worker-1", {
  groupId: "processors",
});

const consumer2 = events.createConsumer("worker-2", {
  groupId: "processors",
});

// Each message goes to only one worker
await consumer1.subscribe(handleEvent);
await consumer2.subscribe(handleEvent);
```

### 3. Event Replay

```typescript
// Replay all historical events
const consumer = stream.createConsumer("replayer", {
  groupId: "replay-group",
  fromBeginning: true, // Start from first message
});

await consumer.subscribe(async (msg) => {
  await reprocessEvent(msg.data);
  await msg.ack();
});
```

### 4. Stream Retention

```typescript
const stream = flow.stream("events", {
  maxLength: 10000, // Keep only newest 10k messages
  retention: 86400000, // 24 hours in ms
});

// Manual trim
await stream.trim({
  maxLength: 5000,
  maxAgeSeconds: 3600,
});
```

---

## Workflow Orchestration

### 1. Simple Workflow

```typescript
const orderFlow = flow
  .workflow<Order>("process-order")
  .step("validate", async (ctx) => {
    const valid = await validateOrder(ctx.input);
    if (!valid) throw new Error("Invalid order");
    ctx.set("validated", true);
  })
  .step("charge", async (ctx) => {
    const charge = await chargePayment(ctx.input);
    ctx.set("chargeId", charge.id);
  })
  .step("fulfill", async (ctx) => {
    await fulfillOrder(ctx.input, ctx.get("chargeId"));
  })
  .build();

const execution = await orderFlow.execute({
  orderId: "123",
  amount: 99.99,
});
```

### 2. Parallel Steps

```typescript
const workflow = flow
  .workflow("notify-user")
  .parallel([
    async (ctx) => await sendEmail(ctx.input),
    async (ctx) => await sendSMS(ctx.input),
    async (ctx) => await sendPushNotification(ctx.input),
  ])
  .build();
```

### 3. Conditional Logic

```typescript
const premiumBranch = flow
  .workflow("premium")
  .step("premium-features", async (ctx) => {});

const standardBranch = flow
  .workflow("standard")
  .step("standard-features", async (ctx) => {});

const workflow = flow
  .workflow("user-onboarding")
  .step("create-account", async (ctx) => {})
  .branch({
    condition: (ctx) => ctx.input.subscription === "premium",
    then: premiumBranch,
    else: standardBranch,
  })
  .build();
```

### 4. Saga Pattern (with Compensation)

```typescript
const workflow = flow
  .workflow("booking")
  .saga("reserve-flight", {
    execute: async (ctx) => {
      const booking = await reserveFlight(ctx.input);
      ctx.set("flightBooking", booking.id);
    },
    compensate: async (ctx) => {
      await cancelFlight(ctx.get("flightBooking"));
    },
  })
  .saga("reserve-hotel", {
    execute: async (ctx) => {
      const booking = await reserveHotel(ctx.input);
      ctx.set("hotelBooking", booking.id);
    },
    compensate: async (ctx) => {
      await cancelHotel(ctx.get("hotelBooking"));
    },
  })
  .saga("charge-payment", {
    execute: async (ctx) => {
      const charge = await chargeCard(ctx.input);
      ctx.set("chargeId", charge.id);
    },
    compensate: async (ctx) => {
      await refundCharge(ctx.get("chargeId"));
    },
  })
  .build();

// If any step fails, compensations run in reverse order
```

### 5. Workflow Management

```typescript
// List executions
const executions = await workflow.listExecutions({
  status: "running",
  limit: 10,
});

// Cancel execution
await workflow.cancelExecution(executionId);

// Retry failed execution
const retried = await workflow.retryExecution(failedExecutionId);

// Get history
const history = await workflow.getExecutionHistory(executionId);

// Get metrics
const metrics = await workflow.getMetrics();
// { totalExecutions, successRate, avgDuration }
```

---

## Advanced Patterns

### 1. Queue → Workflow Integration

```typescript
const queue = flow.queue("orders");
const workflow = flow
  .workflow("process-order")
  .step("validate", async (ctx) => {})
  .step("process", async (ctx) => {})
  .build();

queue.process(async (job) => {
  await workflow.execute(job.data);
  return { workflowStarted: true };
});
```

### 2. Workflow → Stream Integration

```typescript
const stream = flow.stream("order-events");

const workflow = flow
  .workflow("order")
  .step("validate", async (ctx) => {
    await stream.publish({ status: "validating", order: ctx.input });
    // ... validation logic
  })
  .step("process", async (ctx) => {
    await stream.publish({ status: "processing", order: ctx.input });
    // ... processing logic
  })
  .step("complete", async (ctx) => {
    await stream.publish({ status: "completed", order: ctx.input });
  })
  .build();
```

### 3. Dead Letter Queue

```typescript
import { MemoryDLQManager } from "@flowfn/core";

const dlq = new MemoryDLQManager({
  maxRetries: 3,
  onDLQ: async (job, reason) => {
    await notifyTeam(`Job ${job.id} failed: ${reason}`);
  },
});

queue.process(async (job) => {
  try {
    await processJob(job.data);
  } catch (error) {
    if (job.attemptsMade >= 3) {
      await dlq.moveToDLQ(job, error.message);
    }
    throw error;
  }
});

// Later: retry from DLQ
const stats = await dlq.getStats();
console.log(`DLQ has ${stats.total} jobs`);

const retriedCount = await dlq.retryAll("my-queue");
```

### 4. Rate Limiting

```typescript
import { TokenBucketRateLimiter } from "@flowfn/core";

const limiter = new TokenBucketRateLimiter({
  capacity: 100,
  refillRate: 10,
  refillInterval: 1000,
});

queue.process(async (job) => {
  await limiter.acquire(); // Wait if rate limit exceeded
  await callExternalAPI(job.data);
});
```

### 5. Priority Processing

```typescript
// Add with priorities
await queue.add("urgent", data, { priority: 1 });
await queue.add("normal", data, { priority: 5 });
await queue.add("low", data, { priority: 10 });

// Lower number = higher priority
// Jobs processed in priority order
```

---

## Monitoring & Observability

### 1. Health Checks

```typescript
const health = await flow.healthCheck();

if (!health.healthy) {
  console.error("System unhealthy:", health.checks);
}

// Check individual systems
const queueHealth = health.checks.find((c) => c.name === "queues");
```

### 2. Metrics Collection

```typescript
// Record custom metrics
flow.metrics.record("orders.processed", 1, {
  status: "success",
  region: "us-east",
});

// Get time series
const metrics = flow.metrics.getTimeSeries("orders.processed", {
  tags: { status: "success" },
  since: Date.now() - 3600000, // Last hour
});

console.log("Average:", metrics?.avg);
console.log("P95:", metrics?.p95);
```

### 3. Event Tracking

```typescript
const tracker = flow.getEventTracker();

// Track events
tracker.track({
  type: "order.failed",
  category: "queue",
  severity: "error",
  message: "Payment declined",
  metadata: { orderId: "123", reason: "insufficient_funds" },
});

// Query events
const errors = tracker.getEvents({
  severity: "error",
  since: Date.now() - 86400000, // Last 24h
  limit: 100,
});
```

---

## Production Deployment

### 1. Redis Adapter

```typescript
import { createFlow } from "@flowfn/core";
import { RedisAdapter } from "@flowfn/core";
import Redis from "ioredis";

const redis = new Redis({
  host: "localhost",
  port: 6379,
});

const flow = createFlow({
  adapter: new RedisAdapter(redis),
});
```

### 2. Postgres Adapter

```typescript
import { PostgresAdapter } from "@flowfn/core";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

const db = drizzle(pool);
const flow = createFlow({
  adapter: new PostgresAdapter(db),
});
```

### 3. Graceful Shutdown

```typescript
async function shutdown() {
  console.log("Shutting down...");
  await flow.close();
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
```

### 4. Error Handling

```typescript
const flow = createFlow({
  adapter: "redis",
  onError: (error, context) => {
    console.error("FlowFn error:", error, context);
    // Send to error tracking service
  },
});
```

---

## Best Practices

### 1. Job Design

✅ **DO:**

- Keep jobs idempotent
- Use job IDs for deduplication
- Store minimal data in jobs
- Use timeouts for long-running jobs

❌ **DON'T:**

- Store large payloads
- Assume job execution order
- Ignore retry logic
- Skip error handling

### 2. Stream Design

✅ **DO:**

- Set retention policies
- Use consumer groups for scaling
- Implement proper ack/nack
- Monitor lag

❌ **DON'T:**

- Let streams grow unbounded
- Process same message twice
- Skip message acknowledgment

### 3. Workflow Design

✅ **DO:**

- Keep steps small and focused
- Use sagas for distributed transactions
- Store intermediate state
- Add proper error handling

❌ **DON'T:**

- Make workflows too complex
- Skip compensation logic
- Ignore timeouts
- Store sensitive data in state

---

## Troubleshooting

### Jobs Not Processing

```typescript
// Check queue status
const stats = await queue.getJobCounts();
console.log(stats); // { waiting, active, completed, failed }

// Check specific job
const job = await queue.getJob(jobId);
console.log(job?.state, job?.failedReason);
```

### High Memory Usage

```typescript
// Clean old jobs
await queue.clean(86400000, "completed"); // 24h grace
await queue.clean(604800000, "failed"); // 7d grace

// Trim streams
await stream.trim({ maxLength: 10000 });
```

### Workflow Not Completing

```typescript
// Check execution status
const execution = await workflow.getExecution(executionId);
console.log(execution.status, execution.error);

// Check history
const history = await workflow.getExecutionHistory(executionId);
console.log(history);
```

---

## Examples Repository

Full working examples available at: [github.com/flowfn/examples](https://github.com/flowfn/examples)

- E-commerce order processing
- Email notification system
- Data pipeline with ETL
- Microservices orchestration
- Event-driven architecture

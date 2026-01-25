# FlowFn API Reference

Complete API reference for FlowFn TypeScript SDK v1.0.

---

## Table of Contents

- [Core API](#core-api)
- [Queue API](#queue-api)
- [Stream API](#stream-api)
- [Workflow API](#workflow-api)
- [Monitoring API](#monitoring-api)
- [Patterns](#patterns)
- [Utilities](#utilities)
- [Storage](#storage)

---

## Core API

### `createFlow(config)`

Creates and initializes a FlowFn instance.

**Parameters:**

- `config: FlowFnConfig` - Configuration object

**Returns:** `FlowFn` instance

**Example:**

```typescript
import { createFlow } from "@flowfn/core";

const flow = createFlow({
  adapter: "memory",
  namespace: "my-app",
});
```

**FlowFnConfig:**

```typescript
interface FlowFnConfig {
  adapter: FlowAdapter | "memory" | "redis" | "postgres";
  namespace?: string;
  defaultJobOptions?: JobOptions;
  defaultQueueOptions?: QueueOptions;
  defaultStreamOptions?: StreamOptions;
  telemetry?: {
    enabled: boolean;
    provider?: "opentelemetry" | "custom";
  };
  onError?: (error: Error, context: any) => void;
}
```

### FlowFn Methods

#### `flow.queue<T>(name, options?)`

Creates or gets a queue.

**Parameters:**

- `name: string` - Queue name
- `options?: QueueOptions` - Queue configuration

**Returns:** `Queue<T>`

#### `flow.stream<T>(name, options?)`

Creates or gets a stream.

**Parameters:**

- `name: string` - Stream name
- `options?: StreamOptions` - Stream configuration

**Returns:** `Stream<T>`

#### `flow.workflow<T>(name)`

Creates a workflow builder.

**Parameters:**

- `name: string` - Workflow name

**Returns:** `WorkflowBuilder<T>`

#### `flow.healthCheck()`

Performs system health check.

**Returns:** `Promise<HealthStatus>`

#### `flow.close()`

Closes all connections and resources.

**Returns:** `Promise<void>`

---

## Queue API

### Queue Methods

#### `queue.add(name, data, options?)`

Adds a job to the queue.

**Parameters:**

- `name: string` - Job name
- `data: T` - Job payload
- `options?: JobOptions` - Job configuration

**Returns:** `Promise<Job<T>>`

**Example:**

```typescript
const job = await queue.add(
  "process-order",
  {
    orderId: "123",
    amount: 100,
  },
  {
    priority: 1,
    delay: 5000,
    attempts: 3,
  }
);
```

#### `queue.addBulk(jobs)`

Adds multiple jobs at once.

**Parameters:**

- `jobs: Array<{name, data, opts?}>` - Array of jobs

**Returns:** `Promise<Job<T>[]>`

#### `queue.process(handler)` / `queue.process(concurrency, handler)`

Starts processing queue jobs.

**Parameters:**

- `concurrency?: number` - Max concurrent jobs (default: 1)
- `handler: JobHandler<T>` - Job processor function

**Example:**

```typescript
queue.process(5, async (job) => {
  console.log("Processing", job.data);
  return { result: "success" };
});
```

#### `queue.processBatch(name, options, handler)`

Process jobs in batches.

**Parameters:**

- `name: string` - Batch processor name
- `options: BatchOptions` - Batch configuration
- `handler: BatchHandler<T>` - Batch processor

**Example:**

```typescript
queue.processBatch(
  "bulk-process",
  {
    batchSize: 10,
    maxWait: 5000,
  },
  async (jobs) => {
    return await processBatch(jobs.map((j) => j.data));
  }
);
```

#### `queue.getJob(jobId)`

Retrieves a specific job.

**Returns:** `Promise<Job<T> | null>`

#### `queue.getJobs(status)`

Retrieves jobs by status.

**Parameters:**

- `status: JobStatus` - 'waiting', 'active', 'completed', 'failed', 'delayed', 'paused'

**Returns:** `Promise<Job<T>[]>`

#### `queue.clean(grace, status)`

Removes old jobs.

**Parameters:**

- `grace: number` - Grace period in ms
- `status: JobStatus` - Status to clean

**Returns:** `Promise<number>` - Number of jobs cleaned

### JobOptions

```typescript
interface JobOptions {
  priority?: number; // Higher = higher priority
  delay?: number; // Delay in ms before processing
  attempts?: number; // Max retry attempts
  backoff?: BackoffOptions; // Retry backoff strategy
  timeout?: number; // Job timeout in ms
  removeOnComplete?: boolean | number;
  removeOnFail?: boolean | number;
  jobId?: string; // Custom job ID
  preventDuplicates?: boolean;
  deduplicationKey?: string;
  waitFor?: string[]; // Job dependencies
}
```

### QueueOptions

```typescript
interface QueueOptions {
  defaultJobOptions?: JobOptions;
  limiter?: {
    max: number;
    duration: number;
  };
  dlq?: {
    enabled: boolean;
    maxRetries?: number;
    queueName?: string;
  };
}
```

---

## Stream API

### Stream Methods

#### `stream.publish(data, options?)`

Publishes a message to the stream.

**Parameters:**

- `data: T` - Message payload
- `options?: PublishOptions` - Publish configuration

**Returns:** `Promise<string>` - Message ID

**Example:**

```typescript
const messageId = await stream.publish(
  {
    event: "user.created",
    userId: "123",
  },
  {
    key: "user-123",
    headers: { source: "api" },
  }
);
```

#### `stream.publishBatch(messages)`

Publishes multiple messages.

**Returns:** `Promise<string[]>` - Message IDs

#### `stream.subscribe(handler, options?)`

Subscribes to stream messages.

**Parameters:**

- `handler: MessageHandler<T>` - Message handler
- `options?: SubscribeOptions` - Subscribe options

**Returns:** `Promise<Subscription>`

**Example:**

```typescript
await stream.subscribe(async (message) => {
  console.log("Received:", message.data);
  await message.ack();
});
```

#### `stream.createConsumer(consumerId, options)`

Creates a consumer group consumer.

**Parameters:**

- `consumerId: string` - Unique consumer ID
- `options: ConsumerOptions` - Consumer configuration

**Returns:** `Consumer<T>`

**Example:**

```typescript
const consumer = stream.createConsumer("worker-1", {
  groupId: "processors",
  fromBeginning: true,
  autoCommit: true,
});

await consumer.subscribe(async (msg) => {
  await processMessage(msg.data);
  await msg.ack();
});
```

#### `stream.trim(strategy)`

Trims old messages from the stream.

**Parameters:**

- `strategy: TrimStrategy` - Trim configuration

**Returns:** `Promise<number>` - Messages trimmed

**Example:**

```typescript
// Keep only newest 1000 messages
await stream.trim({ maxLength: 1000 });

// Remove messages older than 1 hour
await stream.trim({ maxAgeSeconds: 3600 });
```

#### `stream.getMessages(start, end, count?)`

Retrieves messages by ID range.

**Returns:** `Promise<Message<T>[]>`

#### `stream.replay(fromTimestamp, handler)`

Replays messages from a timestamp.

**Returns:** `Promise<number>` - Messages replayed

### StreamOptions

```typescript
interface StreamOptions {
  maxLength?: number; // Auto-trim to this length
  retention?: number; // Retention period in ms
  partitions?: number; // Number of partitions
}
```

---

## Workflow API

### WorkflowBuilder Methods

#### `workflow.step(name, handler)`

Adds a sequential step.

**Example:**

```typescript
workflow
  .step("validate", async (ctx) => {
    const valid = await validate(ctx.input);
    ctx.set("isValid", valid);
  })
  .step("process", async (ctx) => {
    if (ctx.get("isValid")) {
      await process(ctx.input);
    }
  });
```

#### `workflow.parallel(steps)`

Executes steps in parallel.

**Example:**

```typescript
workflow.parallel([
  async (ctx) => {
    await sendEmail(ctx.input);
  },
  async (ctx) => {
    await sendSMS(ctx.input);
  },
  async (ctx) => {
    await logEvent(ctx.input);
  },
]);
```

#### `workflow.branch(options)`

Adds conditional branching.

**Example:**

```typescript
const thenBranch = flow
  .workflow("premium")
  .step("premium-processing", async (ctx) => {});

const elseBranch = flow
  .workflow("standard")
  .step("standard-processing", async (ctx) => {});

workflow.branch({
  condition: (ctx) => ctx.input.tier === "premium",
  then: thenBranch,
  else: elseBranch,
});
```

#### `workflow.saga(name, saga)`

Adds a saga with compensation.

**Example:**

```typescript
workflow.saga("payment", {
  execute: async (ctx) => {
    const charge = await chargeCard(ctx.input);
    ctx.set("chargeId", charge.id);
  },
  compensate: async (ctx) => {
    await refundCharge(ctx.get("chargeId"));
  },
});
```

#### `workflow.delay(duration)`

Adds a delay step.

**Example:**

```typescript
workflow.delay({ ms: 60000 }); // 1 minute delay
```

#### `workflow.build()`

Builds and returns the workflow.

**Returns:** `Workflow<T>`

### Workflow Methods

#### `workflow.execute(input)`

Executes the workflow.

**Returns:** `Promise<WorkflowExecution>`

#### `workflow.getExecution(executionId)`

Retrieves an execution.

**Returns:** `Promise<WorkflowExecution>`

#### `workflow.listExecutions(options?)`

Lists all executions.

**Returns:** `Promise<WorkflowExecution[]>`

#### `workflow.cancelExecution(executionId)`

Cancels a running execution.

**Returns:** `Promise<void>`

#### `workflow.retryExecution(executionId)`

Retries a failed execution.

**Returns:** `Promise<WorkflowExecution>`

#### `workflow.getExecutionHistory(executionId)`

Gets execution event history.

**Returns:** `Promise<WorkflowEvent[]>`

#### `workflow.getMetrics()`

Gets workflow metrics.

**Returns:** `Promise<WorkflowMetrics>`

---

## Monitoring API

### Metrics

#### `flow.metrics.record(name, value, tags?)`

Records a metric data point.

**Example:**

```typescript
flow.metrics.record("orders.processed", 1, {
  region: "us-east",
  status: "success",
});
```

#### `flow.metrics.getTimeSeries(name, options?)`

Retrieves time-series data.

**Returns:** `TimeSeriesMetrics | null`

#### `flow.metrics.getQueueMetrics(name)`

Gets queue-specific metrics.

**Returns:** `Promise<QueueMetrics>`

### Health Checks

#### Custom Health Checks

```typescript
const health = await flow.healthCheck();

// Add custom check
health.addCheck("database", async () => ({
  name: "database",
  status: (await db.ping()) ? "pass" : "fail",
  message: "Database connection",
}));
```

### Event Tracking

```typescript
const tracker = flow.getEventTracker();

tracker.track({
  type: "order.created",
  category: "queue",
  severity: "info",
  message: "New order received",
  metadata: { orderId: "123" },
});

const events = tracker.getEvents({
  category: "queue",
  severity: "error",
  since: Date.now() - 3600000,
});
```

---

## Patterns

### Rate Limiting

```typescript
import { RateLimiter } from "@flowfn/core";

const limiter = new RateLimiter({
  max: 100,
  window: 60000, // 1 minute
  strategy: "throw", // or 'delay' or 'drop'
});

await limiter.acquire();
```

### Token Bucket

```typescript
import { TokenBucketRateLimiter } from "@flowfn/core";

const limiter = new TokenBucketRateLimiter({
  capacity: 100,
  refillRate: 10,
  refillInterval: 1000,
});
```

### Batching

```typescript
import { BatchAccumulator } from "@flowfn/core";

const batch = new BatchAccumulator({
  maxSize: 10,
  maxWait: 5000,
  processor: async (items) => {
    await processBatch(items);
  },
});

await batch.add(item);
```

### Priority Queue

```typescript
import { PriorityQueue } from "@flowfn/core";

const pq = new PriorityQueue<Task>({
  comparator: (a, b) => a.priority - b.priority,
});

pq.enqueue({ priority: 1, task: "high" });
pq.enqueue({ priority: 5, task: "low" });

const next = pq.dequeue(); // Gets highest priority
```

---

## Utilities

### Hashing

```typescript
import { hashJob, generateDeduplicationKey } from "@flowfn/core";

const hash = hashJob({ userId: "123", action: "process" });
const dedupKey = generateDeduplicationKey("queue-name", hash);
```

### ID Generation

```typescript
import { generateId, generateJobId } from "@flowfn/core";

const jobId = generateJobId(); // UUID v4
const execId = generateId("nanoid"); // Nanoid
const detId = generateId("uuid-v5", "namespace", "name"); // Deterministic
```

### Time Utilities

```typescript
import { toMilliseconds, sleep, parseDuration } from "@flowfn/core";

const ms = toMilliseconds({ hours: 1, minutes: 30 });
await sleep(1000);
const duration = parseDuration("1h30m");
```

### Serialization

```typescript
import { serialize, deserialize, serializeCompressed } from "@flowfn/core";

const json = serialize({ date: new Date(), value: 123 });
const obj = deserialize(json);
const compressed = await serializeCompressed(largeObject);
```

---

## Storage

### Job Storage

```typescript
import { MemoryJobStorage } from "@flowfn/core";

const storage = new MemoryJobStorage();

await storage.save(job);
const job = await storage.get(jobId);
const jobs = await storage.list({ status: "completed" });
await storage.cleanup({ olderThan: Date.now() - 86400000 });
```

### Workflow Storage

```typescript
import { MemoryWorkflowStorage } from "@flowfn/core";

const storage = new MemoryWorkflowStorage();

await storage.save(workflowId, execution);
const executions = await storage.list(workflowId, {
  status: "running",
  limit: 10,
});
```

### Event Log

```typescript
import { MemoryEventLog } from "@flowfn/core";

const log = new MemoryEventLog();

await log.append({
  type: "order.created",
  aggregateId: "order-123",
  aggregateType: "order",
  data: { amount: 100 },
});

const events = await log.getAggregateEvents("order-123");
```

---

## Error Handling

### Job Errors

```typescript
queue.process(async (job) => {
  try {
    await processJob(job.data);
  } catch (error) {
    await job.log(`Error: ${error.message}`);
    throw error; // Will retry based on attempts
  }
});
```

### DLQ (Dead Letter Queue)

```typescript
import { MemoryDLQManager } from "@flowfn/core";

const dlq = new MemoryDLQManager({
  maxRetries: 3,
  onDLQ: async (job, reason) => {
    console.error("Job moved to DLQ:", job.id, reason);
  },
});

// Job automatically moves to DLQ after max retries
const dlqJob = await dlq.moveToDLQ(failedJob, "Max retries exceeded");

// Retry from DLQ
const retriedJob = await dlq.retry(jobId);
```

---

## TypeScript Types

All FlowFn types are fully typed for TypeScript:

```typescript
import {
  FlowFn,
  Queue,
  Stream,
  Workflow,
  Job,
  Message,
  WorkflowExecution,
  HealthStatus,
  MetricsManager,
} from "@flowfn/core";
```

Full type definitions are available in the package's `.d.ts` files.

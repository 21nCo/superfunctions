# FlowFn Full Specification

> Self-hosted flow control platform for developers - Queues, Streams, and Workflows

## Overview

FlowFn is a developer-first flow control solution that unifies queues, streams, and workflows into a single self-hosted platform. Think "BullMQ + Temporal + Kafka" - but framework-agnostic, provider-agnostic, and built for the super-functions ecosystem. It provides a unified interface for async processing, event streaming, and workflow orchestration without vendor lock-in.

**Version**: 1.0.0  
**Target Release**: Q4 2026  
**Status**: Specification

## Core Philosophy

- **Self-hosted first**: No Redis/Kafka/SQS dependencies required (but supported)
- **Provider-agnostic**: Switch between Redis, Postgres, SQS, Kafka without code changes
- **Framework-agnostic**: Works with any framework via @superfunctions/http adapters
- **Developer experience**: Simple SDK, works locally, minimal configuration
- **Type-safe**: Full TypeScript support with type inference
- **Composable**: Built for the super-functions ecosystem
- **Edge-ready**: Works on Cloudflare Workers, Deno Deploy, and traditional servers
- **Observable**: Built-in monitoring, metrics, and debugging
- **Reliable**: Retries, dead-letter queues, and error handling out of the box

## Architecture

```
flowfn/
├── typescript/
│   ├── src/
│   │   ├── core/
│   │   │   ├── flow-fn.ts              # Main SDK entry
│   │   │   ├── queue-manager.ts        # Queue orchestration
│   │   │   ├── stream-manager.ts       # Stream management
│   │   │   ├── workflow-engine.ts      # Workflow orchestration
│   │   │   ├── worker-pool.ts          # Worker management
│   │   │   └── scheduler.ts            # Job scheduling
│   │   ├── queue/
│   │   │   ├── queue.ts                # Queue interface
│   │   │   ├── job.ts                  # Job representation
│   │   │   ├── worker.ts               # Worker implementation
│   │   │   ├── processor.ts            # Job processing
│   │   │   └── types.ts
│   │   ├── stream/
│   │   │   ├── stream.ts               # Stream interface
│   │   │   ├── producer.ts             # Stream producer
│   │   │   ├── consumer.ts             # Stream consumer
│   │   │   ├── consumer-group.ts       # Consumer group
│   │   │   └── types.ts
│   │   ├── workflow/
│   │   │   ├── workflow.ts             # Workflow definition
│   │   │   ├── step.ts                 # Workflow step
│   │   │   ├── execution.ts            # Execution context
│   │   │   ├── saga.ts                 # Saga pattern
│   │   │   ├── state-machine.ts        # State machine
│   │   │   └── types.ts
│   │   ├── adapters/
│   │   │   ├── base.ts                 # Base adapter interface
│   │   │   ├── memory.ts               # In-memory (dev/test)
│   │   │   ├── redis.ts                # Redis adapter
│   │   │   ├── postgres.ts             # Postgres SKIP LOCKED
│   │   │   ├── d1.ts                   # Cloudflare D1
│   │   │   ├── sqs.ts                  # AWS SQS
│   │   │   ├── kafka.ts                # Apache Kafka
│   │   │   ├── pubsub.ts               # Google Pub/Sub
│   │   │   └── rabbitmq.ts             # RabbitMQ
│   │   ├── patterns/
│   │   │   ├── retry.ts                # Retry logic
│   │   │   ├── circuit-breaker.ts      # Circuit breaker
│   │   │   ├── backoff.ts              # Backoff strategies
│   │   │   ├── batching.ts             # Batch processing
│   │   │   ├── priority.ts             # Priority queues
│   │   │   └── rate-limit.ts           # Rate limiting
│   │   ├── middleware/
│   │   │   ├── logging.ts              # Request logging
│   │   │   ├── metrics.ts              # Performance metrics
│   │   │   ├── tracing.ts              # OpenTelemetry
│   │   │   ├── validation.ts           # Input validation
│   │   │   └── error-handler.ts        # Error handling
│   │   ├── storage/
│   │   │   ├── job-storage.ts          # Job persistence
│   │   │   ├── workflow-storage.ts     # Workflow state
│   │   │   ├── event-log.ts            # Event sourcing
│   │   │   └── snapshot.ts             # State snapshots
│   │   ├── scheduler/
│   │   │   ├── cron.ts                 # Cron scheduling
│   │   │   ├── delay.ts                # Delayed jobs
│   │   │   ├── recurring.ts            # Recurring tasks
│   │   │   └── calendar.ts             # Calendar-based
│   │   ├── monitoring/
│   │   │   ├── metrics.ts              # Metrics collection
│   │   │   ├── health.ts               # Health checks
│   │   │   ├── events.ts               # Event tracking
│   │   │   └── dashboard.ts            # Dashboard data
│   │   └── utils/
│   │       ├── serialization.ts        # Job serialization
│   │       ├── hashing.ts              # Job deduplication
│   │       ├── id-generator.ts         # ID generation
│   │       └── time.ts                 # Time utilities
│   └── examples/
├── python/
│   └── flowfn/
│       ├── core/
│       ├── queue/
│       ├── stream/
│       ├── workflow/
│       └── adapters/
├── dashboard/                          # Web dashboard UI
│   └── src/
│       ├── components/
│       │   ├── QueueList.tsx
│       │   ├── JobDetails.tsx
│       │   ├── WorkflowBuilder.tsx
│       │   └── Metrics.tsx
│       └── pages/
└── .conduct/                           # Implementation artifacts
```

## Core Features

### 1. Queue System

#### Basic Queue Operations

**Priority**: P0 (Critical)

Queue-based job processing with reliability guarantees.

**Capabilities**:
- FIFO and priority queues
- Job scheduling and delays
- Automatic retries with backoff
- Dead-letter queues
- Job deduplication
- Rate limiting
- Batch processing
- Job dependencies

**API Design**:

```typescript
import { createFlow } from 'flowfn';
import { RedisAdapter } from 'flowfn/adapters/redis';

const flow = createFlow({
  adapter: new RedisAdapter({
    url: process.env.REDIS_URL
  }),
  // Or use in-memory for development
  // adapter: 'memory'
});

// Define a typed queue
interface EmailJob {
  to: string;
  subject: string;
  body: string;
  template?: string;
}

const emailQueue = flow.queue<EmailJob>('emails', {
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 1000
    },
    removeOnComplete: 100,
    removeOnFail: 1000
  }
});

// Enqueue a job
const job = await emailQueue.add('send-welcome', {
  to: 'user@example.com',
  subject: 'Welcome!',
  body: 'Thanks for signing up'
}, {
  priority: 10,
  delay: 5000, // 5 second delay
  attempts: 5
});

// Process jobs
emailQueue.process('send-welcome', async (job) => {
  console.log(`Processing job ${job.id}`);
  await sendEmail(job.data);
  return { sent: true, messageId: 'msg-123' };
});

// Concurrent processing
emailQueue.process('send-welcome', 5, async (job) => {
  // Process 5 jobs concurrently
  await sendEmail(job.data);
});

// Event listeners
emailQueue.on('completed', (job, result) => {
  console.log(`Job ${job.id} completed:`, result);
});

emailQueue.on('failed', (job, error) => {
  console.error(`Job ${job.id} failed:`, error);
});

emailQueue.on('stalled', (job) => {
  console.warn(`Job ${job.id} stalled`);
});
```

**Job Schema**:

```typescript
interface Job<T = any> {
  id: string;
  name: string;
  data: T;
  opts: JobOptions;
  
  // Status
  state: 'waiting' | 'active' | 'completed' | 'failed' | 'delayed' | 'paused';
  progress: number;
  returnvalue?: any;
  
  // Timing
  timestamp: number;
  processedOn?: number;
  finishedOn?: number;
  delay: number;
  
  // Retries
  attemptsMade: number;
  failedReason?: string;
  stacktrace?: string[];
  
  // Methods
  update(data: Partial<T>): Promise<void>;
  log(message: string): Promise<void>;
  progress(progress: number): Promise<void>;
  moveToCompleted(returnValue: any): Promise<void>;
  moveToFailed(error: Error): Promise<void>;
  retry(): Promise<void>;
  discard(): Promise<void>;
}

interface JobOptions {
  priority?: number;
  delay?: number;
  attempts?: number;
  backoff?: BackoffOptions;
  lifo?: boolean;
  timeout?: number;
  removeOnComplete?: boolean | number;
  removeOnFail?: boolean | number;
  stackTraceLimit?: number;
  jobId?: string;
  preventDuplicates?: boolean;
  deduplicationKey?: string;
}

interface BackoffOptions {
  type: 'fixed' | 'exponential' | 'custom';
  delay: number;
  maxDelay?: number;
}
```

**Priority Queue**:

```typescript
const taskQueue = flow.queue<Task>('tasks');

await taskQueue.add('high-priority-task', data, { priority: 100 });
await taskQueue.add('medium-priority-task', data, { priority: 50 });
await taskQueue.add('low-priority-task', data, { priority: 1 });

// Jobs are processed in priority order (highest first)
```

**Delayed Jobs**:

```typescript
// Delay by milliseconds
await queue.add('job', data, { delay: 60000 }); // 1 minute

// Schedule for specific time
const scheduledTime = new Date('2026-01-15T10:00:00Z');
await queue.add('job', data, { 
  delay: scheduledTime.getTime() - Date.now() 
});
```

**Job Dependencies**:

```typescript
const job1 = await queue.add('fetch-data', { source: 'api' });
const job2 = await queue.add('process-data', { input: 'data' }, {
  waitFor: [job1.id]
});
const job3 = await queue.add('save-results', {}, {
  waitFor: [job2.id]
});
```

**Batch Operations**:

```typescript
// Add multiple jobs
await queue.addBulk([
  { name: 'job1', data: { id: 1 } },
  { name: 'job2', data: { id: 2 } },
  { name: 'job3', data: { id: 3 } }
]);

// Process in batches
queue.processBatch('batch-job', 10, async (jobs) => {
  // Process 10 jobs at once
  const results = await processInParallel(jobs.map(j => j.data));
  return results;
});
```

**Queue Management**:

```typescript
// Pause/resume
await queue.pause();
await queue.resume();

// Drain (wait for all jobs to complete)
await queue.drain();

// Clean completed/failed jobs
await queue.clean(86400000, 'completed'); // Remove completed jobs older than 1 day
await queue.clean(86400000, 'failed');

// Get queue stats
const counts = await queue.getJobCounts();
console.log(counts);
// { waiting: 10, active: 2, completed: 100, failed: 5, delayed: 3 }

// Get specific jobs
const waiting = await queue.getWaiting();
const active = await queue.getActive();
const failed = await queue.getFailed();

// Retry failed jobs
const failed = await queue.getFailed();
await Promise.all(failed.map(job => job.retry()));
```

### 2. Stream Processing

#### Event Streams

**Priority**: P0 (Critical)

Pub/sub event streaming with consumer groups.

**Capabilities**:
- Event publishing and subscription
- Consumer groups for load balancing
- Message acknowledgment
- Stream replay and catch-up
- Message filtering
- Partitioning
- Retention policies

**API Design**:

```typescript
interface OrderEvent {
  orderId: string;
  userId: string;
  amount: number;
  items: Array<{ id: string; quantity: number }>;
}

const orderStream = flow.stream<OrderEvent>('orders', {
  maxLength: 10000,
  retention: 7 * 24 * 60 * 60 * 1000, // 7 days
  partitions: 3
});

// Publish events
await orderStream.publish({
  orderId: 'order_123',
  userId: 'user_456',
  amount: 99.99,
  items: [{ id: 'item_1', quantity: 2 }]
}, {
  key: 'user_456', // Partition key
  headers: { source: 'api', version: '1.0' }
});

// Subscribe to stream
orderStream.subscribe(async (message) => {
  console.log(`Received order: ${message.data.orderId}`);
  await processOrder(message.data);
  await message.ack();
});

// Consumer groups (load balancing)
const consumer = orderStream.createConsumer('order-processor', {
  groupId: 'processors',
  fromBeginning: false,
  autoCommit: true,
  commitInterval: 5000
});

consumer.subscribe(async (message) => {
  await processOrder(message.data);
  // Auto-acked if autoCommit is enabled
});

// Multiple consumers in the same group
const consumer1 = orderStream.createConsumer('worker-1', { groupId: 'workers' });
const consumer2 = orderStream.createConsumer('worker-2', { groupId: 'workers' });
// Each message goes to only one consumer in the group

// Pattern-based subscription
flow.subscribe('order.*', async (message) => {
  console.log(`Order event: ${message.event}`);
});

flow.subscribe('order.created', async (message) => {
  await notifyUser(message.data);
});

flow.subscribe('order.completed', async (message) => {
  await sendReceipt(message.data);
});
```

**Stream Schema**:

```typescript
interface Stream<T = any> {
  name: string;
  
  // Publishing
  publish(data: T, options?: PublishOptions): Promise<MessageId>;
  publishBatch(messages: Array<{ data: T; options?: PublishOptions }>): Promise<MessageId[]>;
  
  // Subscribing
  subscribe(handler: MessageHandler<T>, options?: SubscribeOptions): Promise<Subscription>;
  createConsumer(consumerId: string, options: ConsumerOptions): Consumer<T>;
  
  // Management
  getInfo(): Promise<StreamInfo>;
  trim(strategy: TrimStrategy): Promise<number>;
  getMessages(start: MessageId, end: MessageId, count?: number): Promise<Message<T>[]>;
}

interface Message<T = any> {
  id: string;
  stream: string;
  data: T;
  headers?: Record<string, string>;
  timestamp: number;
  partition?: number;
  offset?: number;
  key?: string;
  
  ack(): Promise<void>;
  nack(requeue?: boolean): Promise<void>;
}

interface PublishOptions {
  key?: string;
  headers?: Record<string, string>;
  partition?: number;
}

interface ConsumerOptions {
  groupId: string;
  fromBeginning?: boolean;
  autoCommit?: boolean;
  commitInterval?: number;
  maxInFlight?: number;
}
```

**Stream Patterns**:

```typescript
// Fan-out (broadcast to all subscribers)
const notificationStream = flow.stream('notifications');

notificationStream.subscribe(async (msg) => {
  await sendEmail(msg.data);
});

notificationStream.subscribe(async (msg) => {
  await sendSMS(msg.data);
});

notificationStream.subscribe(async (msg) => {
  await sendPush(msg.data);
});

await notificationStream.publish({ userId: 'user_123', message: 'Hello!' });
// All three subscribers receive the message

// Fan-in (multiple sources, single consumer)
const metricsStream = flow.stream('metrics');

flow.stream('api-metrics').subscribe(async (msg) => {
  await metricsStream.publish({ source: 'api', ...msg.data });
});

flow.stream('db-metrics').subscribe(async (msg) => {
  await metricsStream.publish({ source: 'db', ...msg.data });
});

metricsStream.subscribe(async (msg) => {
  await saveMetric(msg.data);
});

// Event replay
const consumer = orderStream.createConsumer('replayer', {
  fromBeginning: true
});

consumer.subscribe(async (message) => {
  await reprocessOrder(message.data);
});
```

### 3. Workflow Engine

#### Workflow Orchestration

**Priority**: P0 (Critical)

Multi-step workflow orchestration with error handling and compensation.

**Capabilities**:
- Sequential and parallel steps
- Conditional branching
- Error handling and retries
- Compensation (rollback)
- Long-running workflows
- Human-in-the-loop approvals
- Workflow state persistence
- Saga pattern

**API Design**:

```typescript
interface WorkflowContext<T = any> {
  workflowId: string;
  executionId: string;
  input: T;
  state: Record<string, any>;
  metadata: Record<string, any>;
  
  set(key: string, value: any): void;
  get(key: string): any;
  sleep(ms: number): Promise<void>;
  waitForEvent(event: string, timeout?: number): Promise<any>;
}

// Define a workflow
const checkoutWorkflow = flow.workflow('checkout')
  .input<{ userId: string; orderId: string }>()
  
  // Step 1: Validate order
  .step('validate', async (ctx) => {
    const order = await getOrder(ctx.input.orderId);
    if (!order) throw new Error('Order not found');
    ctx.set('order', order);
    return order;
  })
  
  // Step 2: Reserve inventory
  .step('reserve-inventory', async (ctx) => {
    const order = ctx.get('order');
    const reservation = await reserveInventory(order.items);
    ctx.set('reservation', reservation);
    return reservation;
  })
  
  // Step 3: Charge payment
  .step('charge-payment', async (ctx) => {
    const order = ctx.get('order');
    const charge = await chargeCustomer(order.userId, order.amount);
    ctx.set('charge', charge);
    return charge;
  })
  
  // Step 4: Create shipment
  .step('create-shipment', async (ctx) => {
    const order = ctx.get('order');
    const reservation = ctx.get('reservation');
    const shipment = await createShipment(order, reservation);
    return shipment;
  })
  
  // Error handling
  .onError('reserve-inventory', async (ctx, error) => {
    console.error('Failed to reserve inventory:', error);
    await notifyUser(ctx.input.userId, 'Order failed: Out of stock');
  })
  
  // Compensation (rollback) on failure
  .compensate('charge-payment', async (ctx) => {
    const charge = ctx.get('charge');
    await refundCustomer(charge.id);
  })
  
  .compensate('reserve-inventory', async (ctx) => {
    const reservation = ctx.get('reservation');
    await releaseInventory(reservation.id);
  });

// Execute workflow
const execution = await checkoutWorkflow.execute({
  userId: 'user_123',
  orderId: 'order_456'
});

console.log(`Workflow execution: ${execution.id}`);
console.log(`Status: ${execution.status}`);

// Get execution status
const status = await checkoutWorkflow.getExecution(execution.id);
console.log(status);
```

**Parallel Steps**:

```typescript
const dataProcessing = flow.workflow('process-data')
  .input<{ dataId: string }>()
  
  .step('fetch-data', async (ctx) => {
    const data = await fetchData(ctx.input.dataId);
    ctx.set('data', data);
    return data;
  })
  
  // Run steps in parallel
  .parallel([
    async (ctx) => {
      const data = ctx.get('data');
      return await analyzeData(data);
    },
    async (ctx) => {
      const data = ctx.get('data');
      return await enrichData(data);
    },
    async (ctx) => {
      const data = ctx.get('data');
      return await validateData(data);
    }
  ])
  
  .step('aggregate-results', async (ctx, results) => {
    const [analysis, enriched, validation] = results;
    return { analysis, enriched, validation };
  });
```

**Conditional Branching**:

```typescript
const approvalWorkflow = flow.workflow('approval')
  .input<{ amount: number; userId: string }>()
  
  .step('check-amount', async (ctx) => {
    return ctx.input.amount;
  })
  
  .branch({
    condition: (ctx) => ctx.input.amount > 10000,
    
    // High-value path
    then: flow.steps()
      .step('require-manager-approval', async (ctx) => {
        const approval = await requestApproval('manager', ctx.input);
        return approval;
      })
      .step('require-director-approval', async (ctx) => {
        const approval = await requestApproval('director', ctx.input);
        return approval;
      }),
    
    // Standard path
    else: flow.steps()
      .step('auto-approve', async (ctx) => {
        return { approved: true, auto: true };
      })
  })
  
  .step('process-approval', async (ctx, approval) => {
    if (approval.approved) {
      await processTransaction(ctx.input);
    }
  });
```

**Saga Pattern**:

```typescript
const bookingWorkflow = flow.workflow('book-travel')
  .input<{ userId: string; flightId: string; hotelId: string }>()
  
  // Book flight
  .saga('book-flight', {
    execute: async (ctx) => {
      const booking = await bookFlight(ctx.input.flightId);
      ctx.set('flightBooking', booking);
      return booking;
    },
    compensate: async (ctx) => {
      const booking = ctx.get('flightBooking');
      await cancelFlight(booking.id);
    }
  })
  
  // Book hotel
  .saga('book-hotel', {
    execute: async (ctx) => {
      const booking = await bookHotel(ctx.input.hotelId);
      ctx.set('hotelBooking', booking);
      return booking;
    },
    compensate: async (ctx) => {
      const booking = ctx.get('hotelBooking');
      await cancelHotel(booking.id);
    }
  })
  
  // Charge customer
  .saga('charge-customer', {
    execute: async (ctx) => {
      const flight = ctx.get('flightBooking');
      const hotel = ctx.get('hotelBooking');
      const total = flight.price + hotel.price;
      
      const charge = await chargeCustomer(ctx.input.userId, total);
      ctx.set('charge', charge);
      return charge;
    },
    compensate: async (ctx) => {
      const charge = ctx.get('charge');
      await refundCustomer(charge.id);
    }
  });

// If any step fails, all previous steps are compensated automatically
```

**Long-Running Workflows**:

```typescript
const trialWorkflow = flow.workflow('trial-reminder')
  .input<{ userId: string; trialEnds: number }>()
  
  .step('send-welcome', async (ctx) => {
    await sendEmail(ctx.input.userId, 'welcome');
  })
  
  // Wait 3 days
  .delay({ days: 3 })
  
  .step('send-reminder-1', async (ctx) => {
    await sendEmail(ctx.input.userId, 'trial-ends-soon');
  })
  
  // Wait 4 more days
  .delay({ days: 4 })
  
  .step('send-reminder-2', async (ctx) => {
    await sendEmail(ctx.input.userId, 'last-chance');
  })
  
  // Wait until trial ends
  .delayUntil((ctx) => ctx.input.trialEnds)
  
  .step('check-subscription', async (ctx) => {
    const user = await getUser(ctx.input.userId);
    if (!user.subscribed) {
      await disableTrial(ctx.input.userId);
    }
  });
```

**Human-in-the-Loop**:

```typescript
const reviewWorkflow = flow.workflow('content-review')
  .input<{ contentId: string }>()
  
  .step('fetch-content', async (ctx) => {
    const content = await getContent(ctx.input.contentId);
    ctx.set('content', content);
    return content;
  })
  
  // Wait for human approval
  .waitForApproval('reviewer', {
    timeout: 24 * 60 * 60 * 1000, // 24 hours
    data: (ctx) => ({ content: ctx.get('content') }),
    onTimeout: async (ctx) => {
      await notifyManager('Review timeout', ctx.input.contentId);
    }
  })
  
  .step('process-approval', async (ctx, approval) => {
    if (approval.approved) {
      await publishContent(ctx.input.contentId);
    } else {
      await rejectContent(ctx.input.contentId, approval.reason);
    }
  });

// Provide approval from external source
await flow.approveWorkflow(executionId, {
  approved: true,
  reviewedBy: 'user_123',
  notes: 'Looks good!'
});
```

**Workflow Management**:

```typescript
// List workflows
const workflows = await flow.listWorkflows();

// Get workflow executions
const executions = await checkoutWorkflow.listExecutions({
  status: 'running',
  limit: 100
});

// Cancel execution
await checkoutWorkflow.cancelExecution(executionId);

// Retry failed execution
await checkoutWorkflow.retryExecution(executionId);

// Get execution history
const history = await checkoutWorkflow.getExecutionHistory(executionId);
for (const event of history) {
  console.log(`${event.timestamp}: ${event.type} - ${event.step}`);
}

// Workflow metrics
const metrics = await checkoutWorkflow.getMetrics();
console.log(`Total executions: ${metrics.totalExecutions}`);
console.log(`Success rate: ${metrics.successRate}%`);
console.log(`Avg duration: ${metrics.avgDuration}ms`);
```

### 4. Integration with Other SuperFunctions

#### With SendFn

```typescript
import { createSendFn } from 'sendfn';

const send = createSendFn({ ... });

// Queue email sending
const emailQueue = flow.queue<EmailJob>('emails');

emailQueue.process(async (job) => {
  await send.email({
    to: job.data.to,
    subject: job.data.subject,
    body: job.data.body
  });
});

// Use in workflow
const signupWorkflow = flow.workflow('user-signup')
  .input<{ email: string; name: string }>()
  
  .step('create-user', async (ctx) => {
    return await createUser(ctx.input);
  })
  
  .step('send-welcome-email', async (ctx, user) => {
    await send.email({
      to: user.email,
      subject: 'Welcome to our platform!',
      template: 'welcome',
      data: { name: user.name }
    });
  });
```

#### With PlugFn

```typescript
import { plugFn } from 'plugfn';

const plug = plugFn({ ... });

// Queue integration events
const integrationQueue = flow.queue('integrations');

plug.github.on('issues.opened', async (event) => {
  await integrationQueue.add('sync-to-linear', {
    issue: event.issue,
    userId: event.installation.userId
  });
});

integrationQueue.process('sync-to-linear', async (job) => {
  await plug.linear.issues.create({
    userId: job.data.userId,
    params: {
      teamId: 'team-123',
      title: job.data.issue.title,
      description: job.data.issue.body
    }
  });
});

// Workflow with external APIs
const deployWorkflow = flow.workflow('deploy')
  .input<{ branch: string; environment: string }>()
  
  .step('create-github-deployment', async (ctx) => {
    return await plug.github.deployments.create({
      userId: 'system',
      params: {
        owner: 'myorg',
        repo: 'myrepo',
        ref: ctx.input.branch,
        environment: ctx.input.environment
      }
    });
  })
  
  .step('deploy-to-server', async (ctx, deployment) => {
    // Deploy logic
  })
  
  .step('update-deployment-status', async (ctx, result) => {
    await plug.github.deployments.updateStatus({
      userId: 'system',
      params: {
        deployment_id: ctx.get('deployment').id,
        state: result.success ? 'success' : 'failure'
      }
    });
  });
```

#### With CacheFn

```typescript
import { cacheFn } from 'cachefn';

const cache = cacheFn({ storage: 'redis', url: process.env.REDIS_URL });

// Cache job results
const apiQueue = flow.queue('api-calls', {
  cache: {
    enabled: true,
    ttl: 300000, // 5 minutes
    keyGenerator: (job) => `api:${job.data.endpoint}`
  }
});

apiQueue.process(async (job) => {
  const cached = await cache.get(job.id);
  if (cached) return cached;
  
  const result = await fetch(job.data.endpoint);
  await cache.set(job.id, result, { ttl: 300000 });
  return result;
});

// Workflow with caching
const dataWorkflow = flow.workflow('fetch-and-process')
  .input<{ userId: string }>()
  
  .step('fetch-user-data', async (ctx) => {
    return await cache.getOrFetch(`user:${ctx.input.userId}`, {
      fetcher: async () => await fetchUserData(ctx.input.userId),
      ttl: 600000
    });
  })
  
  .step('process-data', async (ctx, userData) => {
    return await processUserData(userData);
  });
```

#### With SecFn

```typescript
import { secFn } from 'secfn';

const security = secFn.create({ ... });
const limiter = security.createRateLimiter({ ... });

// Rate-limit queue processing
const queue = flow.queue('rate-limited');

queue.process(async (job) => {
  const result = await limiter.check({
    userId: job.data.userId,
    endpoint: 'api-call'
  });
  
  if (!result.allowed) {
    // Re-queue with delay
    throw new Error(`Rate limited, retry after ${result.retryAfter}ms`);
  }
  
  await processJob(job.data);
});

// Audit workflow executions
const sensitiveWorkflow = flow.workflow('process-payment')
  .input<{ userId: string; amount: number }>()
  
  .step('log-start', async (ctx) => {
    await security.monitoring.logEvent({
      type: 'workflow_started',
      severity: 'info',
      userId: ctx.input.userId,
      metadata: { workflow: 'process-payment', amount: ctx.input.amount }
    });
  })
  
  .step('process-payment', async (ctx) => {
    // Payment logic
  })
  
  .step('log-completion', async (ctx) => {
    await security.monitoring.logEvent({
      type: 'payment_processed',
      severity: 'info',
      userId: ctx.input.userId,
      metadata: { amount: ctx.input.amount }
    });
  });
```

### 5. Provider Adapters

#### Adapter Interface

```typescript
interface FlowAdapter {
  // Queue operations
  enqueue(queue: string, job: Job): Promise<string>;
  dequeue(queue: string): Promise<Job | null>;
  ack(queue: string, jobId: string): Promise<void>;
  nack(queue: string, jobId: string, requeue?: boolean): Promise<void>;
  
  // Stream operations
  publish(stream: string, message: Message): Promise<string>;
  subscribe(stream: string, handler: MessageHandler): Promise<Subscription>;
  createConsumerGroup(stream: string, group: string): Promise<void>;
  
  // Workflow operations
  saveWorkflowState(workflowId: string, state: WorkflowState): Promise<void>;
  loadWorkflowState(workflowId: string): Promise<WorkflowState | null>;
  
  // Management
  getQueueStats(queue: string): Promise<QueueStats>;
  getStreamInfo(stream: string): Promise<StreamInfo>;
  cleanup(): Promise<void>;
}
```

#### Memory Adapter (Development)

```typescript
const flow = createFlow({
  adapter: 'memory'
});

// Great for development, testing, and edge environments
// No external dependencies
// In-process only (not distributed)
```

#### Redis Adapter

```typescript
import { RedisAdapter } from 'flowfn/adapters/redis';
import Redis from 'ioredis';

const flow = createFlow({
  adapter: new RedisAdapter({
    connection: new Redis(process.env.REDIS_URL),
    prefix: 'flow:',
    
    // Redis Streams for streams
    useStreams: true,
    
    // BullMQ-compatible queues
    bullmq: {
      connection: {
        host: 'localhost',
        port: 6379
      }
    }
  })
});
```

#### Postgres Adapter (SKIP LOCKED pattern)

```typescript
import { PostgresAdapter } from 'flowfn/adapters/postgres';
import { drizzleAdapter } from '@superfunctions/db/adapters';

const flow = createFlow({
  adapter: new PostgresAdapter({
    database: drizzleAdapter({ db, dialect: 'postgres' }),
    schema: 'flowfn',
    
    // Use SKIP LOCKED for queues
    lockTimeout: 30000,
    
    // Polling interval for queues
    pollInterval: 1000
  })
});

// Schema automatically created:
// flowfn.jobs (id, queue, data, status, priority, attempts, ...)
// flowfn.messages (id, stream, data, partition, offset, ...)
// flowfn.workflows (id, name, state, status, ...)
```

#### Cloudflare D1 Adapter

```typescript
import { D1Adapter } from 'flowfn/adapters/d1';

const flow = createFlow({
  adapter: new D1Adapter({
    database: env.DB, // Cloudflare D1 binding
    
    // Edge-optimized settings
    maxConcurrency: 10,
    pollInterval: 5000
  })
});

// Perfect for edge workers
// Built-in replication
// Automatic scaling
```

#### AWS SQS Adapter

```typescript
import { SQSAdapter } from 'flowfn/adapters/sqs';
import { SQSClient } from '@aws-sdk/client-sqs';

const flow = createFlow({
  adapter: new SQSAdapter({
    client: new SQSClient({ region: 'us-east-1' }),
    
    queuePrefix: 'flow-',
    
    // SQS-specific settings
    visibilityTimeout: 30,
    waitTimeSeconds: 20,
    maxNumberOfMessages: 10
  })
});

// Automatic queue creation
// Dead-letter queue support
// FIFO queue support
```

#### Apache Kafka Adapter

```typescript
import { KafkaAdapter } from 'flowfn/adapters/kafka';
import { Kafka } from 'kafkajs';

const flow = createFlow({
  adapter: new KafkaAdapter({
    client: new Kafka({
      clientId: 'flowfn',
      brokers: ['kafka1:9092', 'kafka2:9092']
    }),
    
    // Topic prefix
    topicPrefix: 'flow.',
    
    // Kafka-specific settings
    partitions: 3,
    replicationFactor: 2
  })
});

// High-throughput streaming
// Durable message log
// Consumer group support
```

### 6. Advanced Patterns

#### Circuit Breaker

```typescript
import { circuitBreaker } from 'flowfn/patterns';

const queue = flow.queue('external-api');

queue.process(circuitBreaker({
  threshold: 5,        // Open circuit after 5 failures
  timeout: 60000,      // Try again after 60s
  resetTimeout: 30000  // Close after 30s of success
}, async (job) => {
  return await callExternalAPI(job.data);
}));
```

#### Bulk Processing

```typescript
const queue = flow.queue('bulk-inserts');

queue.processBatch('insert', {
  batchSize: 100,
  maxWait: 5000  // Process batch after 5s or 100 items
}, async (jobs) => {
  const records = jobs.map(j => j.data);
  await db.insertMany(records);
});
```

#### Job Chaining

```typescript
const step1Queue = flow.queue('step1');
const step2Queue = flow.queue('step2');
const step3Queue = flow.queue('step3');

step1Queue.process(async (job) => {
  const result = await processStep1(job.data);
  await step2Queue.add('step2', result);
});

step2Queue.process(async (job) => {
  const result = await processStep2(job.data);
  await step3Queue.add('step3', result);
});

step3Queue.process(async (job) => {
  await processStep3(job.data);
});
```

#### Fan-Out / Fan-In

```typescript
// Fan-out: One job creates multiple child jobs
const mainQueue = flow.queue('main');
const childQueue = flow.queue('child');

mainQueue.process(async (job) => {
  const items = job.data.items;
  
  const childJobs = await Promise.all(
    items.map(item => childQueue.add('process', item))
  );
  
  // Wait for all children to complete
  await Promise.all(childJobs.map(j => j.waitUntilFinished()));
  
  return { processed: childJobs.length };
});

// Fan-in: Aggregate results from multiple queues
const resultsQueue = flow.queue('results');

childQueue.process(async (job) => {
  const result = await processItem(job.data);
  await resultsQueue.add('aggregate', result);
});

resultsQueue.process(async (job) => {
  await aggregateResult(job.data);
});
```

#### Exponential Backoff

```typescript
const queue = flow.queue('retryable', {
  defaultJobOptions: {
    attempts: 5,
    backoff: {
      type: 'exponential',
      delay: 1000    // 1s, 2s, 4s, 8s, 16s
    }
  }
});

// Custom backoff
queue.process(async (job) => {
  try {
    return await unstableAPI(job.data);
  } catch (error) {
    // Calculate custom delay
    const delay = Math.min(1000 * Math.pow(2, job.attemptsMade), 60000);
    throw error; // Will retry with calculated delay
  }
});
```

### 7. Monitoring & Observability

#### Metrics Collection

```typescript
const metrics = flow.metrics;

// Queue metrics
const queueMetrics = await metrics.getQueueMetrics('emails');
console.log(queueMetrics);
// {
//   waiting: 10,
//   active: 2,
//   completed: 1000,
//   failed: 5,
//   throughput: 100,  // jobs/minute
//   avgDuration: 250,  // ms
//   p95Duration: 500   // ms
// }

// Stream metrics
const streamMetrics = await metrics.getStreamMetrics('orders');
console.log(streamMetrics);
// {
//   messages: 10000,
//   consumers: 3,
//   lag: 5,  // messages behind
//   throughput: 1000,  // messages/second
//   avgLatency: 50  // ms
// }

// Workflow metrics
const workflowMetrics = await metrics.getWorkflowMetrics('checkout');
console.log(workflowMetrics);
// {
//   totalExecutions: 500,
//   running: 10,
//   completed: 480,
//   failed: 10,
//   successRate: 96,  // %
//   avgDuration: 5000  // ms
// }

// Overall system metrics
const systemMetrics = await metrics.getSystemMetrics();
console.log(systemMetrics);
// {
//   queues: 5,
//   streams: 3,
//   workflows: 10,
//   workers: 20,
//   memoryUsage: 256 * 1024 * 1024  // bytes
// }
```

#### Event Tracking

```typescript
flow.on('job:created', (event) => {
  console.log(`Job created: ${event.queue}/${event.jobId}`);
});

flow.on('job:active', (event) => {
  console.log(`Job started: ${event.jobId}`);
});

flow.on('job:completed', (event) => {
  console.log(`Job completed: ${event.jobId} in ${event.duration}ms`);
});

flow.on('job:failed', (event) => {
  console.error(`Job failed: ${event.jobId}`, event.error);
});

flow.on('job:stalled', (event) => {
  console.warn(`Job stalled: ${event.jobId}`);
});

flow.on('workflow:started', (event) => {
  console.log(`Workflow started: ${event.workflowName}/${event.executionId}`);
});

flow.on('workflow:completed', (event) => {
  console.log(`Workflow completed: ${event.executionId}`);
});

flow.on('workflow:failed', (event) => {
  console.error(`Workflow failed: ${event.executionId}`, event.error);
});

flow.on('stream:message', (event) => {
  console.log(`Message published to ${event.stream}: ${event.messageId}`);
});
```

#### Health Checks

```typescript
// Health check endpoint
app.get('/health/flow', async (req, res) => {
  const health = await flow.healthCheck();
  
  res.status(health.healthy ? 200 : 503).json(health);
});

// Health check result
interface HealthCheck {
  healthy: boolean;
  timestamp: number;
  adapter: {
    type: string;
    connected: boolean;
    latency: number;  // ms
  };
  queues: Array<{
    name: string;
    healthy: boolean;
    waiting: number;
    active: number;
    workers: number;
  }>;
  streams: Array<{
    name: string;
    healthy: boolean;
    lag: number;
    consumers: number;
  }>;
  workflows: Array<{
    name: string;
    running: number;
    stalled: number;
  }>;
}
```

#### OpenTelemetry Integration

```typescript
import { trace } from '@opentelemetry/api';
import { FlowInstrumentation } from 'flowfn/instrumentation';

const instrumentation = new FlowInstrumentation();
instrumentation.enable();

// Automatic tracing of:
// - Job execution
// - Workflow steps
// - Stream messages
// - Adapter operations

const queue = flow.queue('traced');

queue.process(async (job) => {
  const span = trace.getActiveSpan();
  span?.addEvent('Processing started');
  
  const result = await processJob(job.data);
  
  span?.addEvent('Processing completed');
  return result;
});
```

### 8. Scheduling

#### Cron Jobs

```typescript
import { createScheduler } from 'flowfn/scheduler';

const scheduler = flow.scheduler();

// Cron syntax
scheduler.schedule('cleanup-job', '0 0 * * *', async () => {
  await cleanupOldData();
});

// Every 5 minutes
scheduler.schedule('health-check', '*/5 * * * *', async () => {
  await performHealthCheck();
});

// Flexible scheduling
scheduler.schedule('report', {
  pattern: '0 9 * * MON',  // Every Monday at 9 AM
  timezone: 'America/New_York',
  data: { type: 'weekly' }
}, async (data) => {
  await generateReport(data.type);
});

// List scheduled jobs
const jobs = await scheduler.list();

// Cancel scheduled job
await scheduler.cancel('cleanup-job');

// Pause/resume
await scheduler.pause('report');
await scheduler.resume('report');
```

#### Recurring Tasks

```typescript
// Run every hour
const hourlyTask = flow.queue('hourly');

scheduler.repeat('hourly-task', {
  every: 60 * 60 * 1000,  // 1 hour in ms
  startDate: new Date('2026-01-15T00:00:00Z')
}, async () => {
  await hourlyTask.add('task', { timestamp: Date.now() });
});

// Run X times
scheduler.repeat('limited-task', {
  every: 5000,  // 5 seconds
  limit: 10     // Stop after 10 runs
}, async () => {
  console.log('Task running...');
});
```

### 9. Worker Management

#### Worker Configuration

```typescript
import { createWorker } from 'flowfn';

const worker = createWorker({
  flow,
  queues: ['emails', 'notifications', 'analytics'],
  
  // Concurrency per queue
  concurrency: {
    emails: 5,
    notifications: 10,
    analytics: 2
  },
  
  // Worker settings
  settings: {
    stalledInterval: 30000,
    maxStalledCount: 2,
    lockDuration: 30000,
    lockRenewTime: 15000
  },
  
  // Graceful shutdown
  signals: ['SIGTERM', 'SIGINT'],
  shutdownTimeout: 30000
});

await worker.run();

// Worker events
worker.on('ready', () => {
  console.log('Worker ready');
});

worker.on('active', (job) => {
  console.log(`Processing job ${job.id}`);
});

worker.on('error', (error) => {
  console.error('Worker error:', error);
});

worker.on('closing', () => {
  console.log('Worker shutting down...');
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  await worker.close();
  process.exit(0);
});
```

#### Worker Pools

```typescript
import { createWorkerPool } from 'flowfn';

const pool = createWorkerPool({
  flow,
  queues: ['tasks'],
  
  // Auto-scaling
  minWorkers: 2,
  maxWorkers: 10,
  
  // Scale up when queue length > threshold
  scaleUpThreshold: 100,
  
  // Scale down when queue is empty for X ms
  scaleDownDelay: 60000,
  
  // Worker configuration
  workerOptions: {
    concurrency: 5
  }
});

await pool.start();

// Monitor pool
setInterval(async () => {
  const stats = await pool.getStats();
  console.log(`Workers: ${stats.activeWorkers}/${stats.maxWorkers}`);
  console.log(`Processing: ${stats.activeJobs} jobs`);
}, 10000);
```

## Database Schema

### Queue Tables

```sql
CREATE TABLE flowfn_jobs (
  id VARCHAR(255) PRIMARY KEY,
  queue VARCHAR(255) NOT NULL,
  name VARCHAR(255) NOT NULL,
  data JSONB NOT NULL,
  opts JSONB,
  
  state VARCHAR(50) NOT NULL,
  priority INTEGER DEFAULT 0,
  progress INTEGER DEFAULT 0,
  return_value JSONB,
  
  timestamp BIGINT NOT NULL,
  processed_on BIGINT,
  finished_on BIGINT,
  delay BIGINT DEFAULT 0,
  
  attempts_made INTEGER DEFAULT 0,
  failed_reason TEXT,
  stacktrace JSONB,
  
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  
  INDEX idx_queue_state (queue, state),
  INDEX idx_queue_priority (queue, priority DESC),
  INDEX idx_timestamp (timestamp),
  INDEX idx_finished_on (finished_on)
);
```

### Stream Tables

```sql
CREATE TABLE flowfn_messages (
  id VARCHAR(255) PRIMARY KEY,
  stream VARCHAR(255) NOT NULL,
  data JSONB NOT NULL,
  headers JSONB,
  
  partition INTEGER,
  offset BIGINT,
  key VARCHAR(255),
  
  timestamp BIGINT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  
  INDEX idx_stream_timestamp (stream, timestamp),
  INDEX idx_stream_partition_offset (stream, partition, offset),
  INDEX idx_key (key)
);

CREATE TABLE flowfn_consumer_groups (
  id VARCHAR(255) PRIMARY KEY,
  stream VARCHAR(255) NOT NULL,
  group_id VARCHAR(255) NOT NULL,
  consumer_id VARCHAR(255) NOT NULL,
  
  last_message_id VARCHAR(255),
  last_offset BIGINT,
  lag INTEGER,
  
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  
  UNIQUE INDEX idx_stream_group_consumer (stream, group_id, consumer_id),
  INDEX idx_group (group_id)
);
```

### Workflow Tables

```sql
CREATE TABLE flowfn_workflows (
  id VARCHAR(255) PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  definition JSONB NOT NULL,
  version INTEGER DEFAULT 1,
  
  status VARCHAR(50) NOT NULL,
  metadata JSONB,
  
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  
  INDEX idx_name (name),
  INDEX idx_status (status)
);

CREATE TABLE flowfn_workflow_executions (
  id VARCHAR(255) PRIMARY KEY,
  workflow_id VARCHAR(255) NOT NULL,
  workflow_name VARCHAR(255) NOT NULL,
  
  status VARCHAR(50) NOT NULL,
  input JSONB,
  state JSONB,
  output JSONB,
  error TEXT,
  
  current_step VARCHAR(255),
  completed_steps JSONB,
  
  started_at BIGINT NOT NULL,
  updated_at BIGINT,
  completed_at BIGINT,
  duration_ms INTEGER,
  
  INDEX idx_workflow (workflow_id),
  INDEX idx_status (status),
  INDEX idx_started_at (started_at),
  FOREIGN KEY (workflow_id) REFERENCES flowfn_workflows(id) ON DELETE CASCADE
);

CREATE TABLE flowfn_workflow_events (
  id VARCHAR(255) PRIMARY KEY,
  execution_id VARCHAR(255) NOT NULL,
  
  type VARCHAR(50) NOT NULL,
  step VARCHAR(255),
  timestamp BIGINT NOT NULL,
  data JSONB,
  
  INDEX idx_execution (execution_id),
  INDEX idx_timestamp (timestamp),
  FOREIGN KEY (execution_id) REFERENCES flowfn_workflow_executions(id) ON DELETE CASCADE
);
```

## API Reference

### Core API

```typescript
interface FlowFnConfig {
  adapter: FlowAdapter | 'memory' | 'redis' | 'postgres' | 'd1' | 'sqs' | 'kafka';
  namespace?: string;
  
  // Default options
  defaultJobOptions?: JobOptions;
  defaultQueueOptions?: QueueOptions;
  defaultStreamOptions?: StreamOptions;
  
  // Telemetry
  telemetry?: {
    enabled: boolean;
    provider?: 'opentelemetry' | 'custom';
  };
  
  // Error handling
  onError?: (error: Error, context: any) => void;
}

interface FlowFn {
  // Queues
  queue<T = any>(name: string, options?: QueueOptions): Queue<T>;
  listQueues(): Promise<string[]>;
  
  // Streams
  stream<T = any>(name: string, options?: StreamOptions): Stream<T>;
  listStreams(): Promise<string[]>;
  
  // Workflows
  workflow<T = any>(name: string): WorkflowBuilder<T>;
  listWorkflows(): Promise<Workflow[]>;
  
  // Scheduling
  scheduler(): Scheduler;
  
  // Monitoring
  metrics: MetricsManager;
  healthCheck(): Promise<HealthCheck>;
  
  // Events
  on(event: string, handler: EventHandler): void;
  off(event: string, handler: EventHandler): void;
  
  // Lifecycle
  close(): Promise<void>;
}
```

### Queue API

```typescript
interface Queue<T = any> {
  name: string;
  
  // Adding jobs
  add(name: string, data: T, opts?: JobOptions): Promise<Job<T>>;
  addBulk(jobs: Array<{ name: string; data: T; opts?: JobOptions }>): Promise<Job<T>[]>;
  
  // Processing
  process(handler: JobHandler<T>): void;
  process(name: string, handler: JobHandler<T>): void;
  process(concurrency: number, handler: JobHandler<T>): void;
  process(name: string, concurrency: number, handler: JobHandler<T>): void;
  
  // Batch processing
  processBatch(name: string, batchSize: number, handler: BatchHandler<T>): void;
  processBatch(name: string, options: BatchOptions, handler: BatchHandler<T>): void;
  
  // Management
  pause(): Promise<void>;
  resume(): Promise<void>;
  drain(): Promise<void>;
  clean(grace: number, status: JobStatus): Promise<number>;
  
  // Queries
  getJob(jobId: string): Promise<Job<T> | null>;
  getJobs(status: JobStatus): Promise<Job<T>[]>;
  getJobCounts(): Promise<JobCounts>;
  
  // Events
  on(event: QueueEvent, handler: EventHandler): void;
  
  // Lifecycle
  close(): Promise<void>;
}

type JobHandler<T> = (job: Job<T>) => Promise<any>;
type BatchHandler<T> = (jobs: Job<T>[]) => Promise<any[]>;
```

### Stream API

```typescript
interface Stream<T = any> {
  name: string;
  
  // Publishing
  publish(data: T, options?: PublishOptions): Promise<MessageId>;
  publishBatch(messages: Array<{ data: T; options?: PublishOptions }>): Promise<MessageId[]>;
  
  // Subscribing
  subscribe(handler: MessageHandler<T>, options?: SubscribeOptions): Promise<Subscription>;
  createConsumer(consumerId: string, options: ConsumerOptions): Consumer<T>;
  
  // Management
  getInfo(): Promise<StreamInfo>;
  trim(strategy: TrimStrategy): Promise<number>;
  
  // Lifecycle
  close(): Promise<void>;
}

type MessageHandler<T> = (message: Message<T>) => Promise<void>;

interface Consumer<T = any> {
  subscribe(handler: MessageHandler<T>): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  close(): Promise<void>;
}
```

### Workflow API

```typescript
interface WorkflowBuilder<T = any> {
  input<I>(): WorkflowBuilder<I>;
  
  // Steps
  step<R>(name: string, handler: StepHandler<T, R>): WorkflowBuilder<T>;
  parallel(steps: StepHandler<T, any>[]): WorkflowBuilder<T>;
  branch(options: BranchOptions<T>): WorkflowBuilder<T>;
  
  // Saga
  saga(name: string, saga: SagaDefinition<T>): WorkflowBuilder<T>;
  
  // Timing
  delay(duration: Duration): WorkflowBuilder<T>;
  delayUntil(condition: (ctx: WorkflowContext<T>) => number): WorkflowBuilder<T>;
  
  // Approvals
  waitForApproval(approver: string, options: ApprovalOptions<T>): WorkflowBuilder<T>;
  waitForEvent(event: string, options?: EventOptions): WorkflowBuilder<T>;
  
  // Error handling
  onError(step: string, handler: ErrorHandler<T>): WorkflowBuilder<T>;
  compensate(step: string, handler: CompensateHandler<T>): WorkflowBuilder<T>;
  
  // Build
  build(): Workflow<T>;
}

interface Workflow<T = any> {
  id: string;
  name: string;
  
  execute(input: T): Promise<WorkflowExecution>;
  getExecution(executionId: string): Promise<WorkflowExecution>;
  listExecutions(options?: ListOptions): Promise<WorkflowExecution[]>;
  
  cancelExecution(executionId: string): Promise<void>;
  retryExecution(executionId: string): Promise<WorkflowExecution>;
  
  getExecutionHistory(executionId: string): Promise<WorkflowEvent[]>;
  getMetrics(): Promise<WorkflowMetrics>;
}

type StepHandler<T, R> = (ctx: WorkflowContext<T>, ...args: any[]) => Promise<R>;
type ErrorHandler<T> = (ctx: WorkflowContext<T>, error: Error) => Promise<void>;
type CompensateHandler<T> = (ctx: WorkflowContext<T>) => Promise<void>;
```

## Performance Targets

**Queues**:
- Enqueue: <5ms (p99)
- Dequeue: <10ms (p99)
- Throughput: 10,000+ jobs/sec (Redis), 1,000+ jobs/sec (Postgres)
- Latency: <100ms queue-to-processing

**Streams**:
- Publish: <5ms (p99)
- Consume: <10ms (p99)
- Throughput: 100,000+ messages/sec (Kafka), 10,000+ messages/sec (Redis)
- Lag: <1s (p99)

**Workflows**:
- Step execution: <50ms overhead per step
- State persistence: <20ms
- Workflow scheduling: <100ms
- Concurrent workflows: 1,000+ active workflows

**System**:
- Memory footprint: <100MB (base), <1KB per job in memory
- CPU usage: <5% idle, scales linearly with load
- Worker startup: <1s
- Graceful shutdown: <30s

## Security Considerations

- **Job data encryption**: Optional encryption at rest for sensitive job data
- **Authentication**: Integration with authfn for worker authentication
- **Access control**: Queue/stream-level permissions via secfn
- **Audit logging**: All job/workflow operations logged for compliance
- **Rate limiting**: Built-in rate limiting to prevent abuse
- **Secret management**: Integration with secfn vault for credentials

## Testing Strategy

### Unit Tests

- Queue operations (enqueue, dequeue, retry, failure)
- Stream publishing and consumption
- Workflow step execution and state management
- Adapter implementations
- Pattern implementations (circuit breaker, retry, backoff)

### Integration Tests

- End-to-end job processing
- Workflow execution with multiple steps
- Stream consumer groups
- Adapter compatibility (Redis, Postgres, etc.)
- Framework integrations (Express, Hono, Fastify)

### Performance Tests

- Queue throughput (10,000+ jobs/sec)
- Stream throughput (100,000+ messages/sec)
- Concurrent workflow execution
- Worker pool scaling
- Memory usage under load

### Reliability Tests

- Failure recovery (worker crashes, network failures)
- Retry logic and backoff strategies
- Dead-letter queue handling
- Workflow compensation
- State persistence and recovery

## Documentation Requirements

### Getting Started

- Installation guide
- Quick start tutorial
- Core concepts (queues, streams, workflows)
- Configuration guide
- Choosing an adapter

### API Reference

- Complete TypeScript API docs
- Queue API
- Stream API
- Workflow API
- Adapter API
- Pattern APIs

### Guides

- Queue patterns (priority, delay, retry)
- Stream patterns (fan-out, fan-in, replay)
- Workflow patterns (saga, state machine, approval)
- Adapter guide (Redis, Postgres, SQS, Kafka)
- Monitoring and observability
- Error handling and debugging
- Scaling and performance optimization

### Integration Examples

- With SendFn (email queues)
- With PlugFn (webhook processing)
- With CacheFn (result caching)
- With SecFn (access control, rate limiting)
- With BotFn (command processing)

### Framework Guides

- Express integration
- Fastify integration
- Hono integration
- Next.js integration
- SvelteKit integration
- Cloudflare Workers
- Deno Deploy

## Development Roadmap

### Phase 1 (Q1 2026) - Core Foundation

- Core queue system
- Memory adapter
- Redis adapter
- Job processing and retry logic
- Event system
- Basic monitoring

### Phase 2 (Q2 2026) - Streaming

- Stream interface
- Redis Streams adapter
- Consumer groups
- Pattern-based subscriptions
- Stream management

### Phase 3 (Q3 2026) - Workflows

- Workflow engine
- Step execution
- State persistence
- Error handling
- Compensation (saga)
- Postgres adapter

### Phase 4 (Q4 2026) - Advanced Features

- Cloud adapters (SQS, Kafka, Pub/Sub)
- Scheduler (cron, recurring)
- Worker pools and auto-scaling
- Advanced patterns (circuit breaker, rate limiting)
- Dashboard UI
- D1 adapter (edge support)
- OpenTelemetry integration

### Phase 5 (Q1 2027) - Ecosystem Integration

- Deep integration with other superfunctions
- Python SDK
- Community adapters
- Performance optimization
- Enterprise features (multi-tenancy, RBAC)

## Unique Differentiators

### 1. Unified Interface

Single API for queues, streams, and workflows - no need to learn BullMQ + Kafka + Temporal

```typescript
const flow = createFlow({ adapter: 'redis' });

const queue = flow.queue('tasks');
const stream = flow.stream('events');
const workflow = flow.workflow('process');
```

### 2. Provider Agnostic

Switch from Redis to Postgres to SQS without changing code:

```typescript
// Development
const flow = createFlow({ adapter: 'memory' });

// Production
const flow = createFlow({ adapter: 'redis', url: process.env.REDIS_URL });

// Cloud
const flow = createFlow({ adapter: 'sqs', region: 'us-east-1' });
```

### 3. Edge-Ready

Works on Cloudflare Workers, Deno Deploy, and traditional servers:

```typescript
// Cloudflare Worker
const flow = createFlow({ 
  adapter: new D1Adapter({ database: env.DB })
});
```

### 4. Self-Hosted First

No external services required (but supported when needed):

```typescript
// No Redis, no Kafka, no cloud services needed
const flow = createFlow({ adapter: 'memory' });
```

### 5. Type-Safe

Full TypeScript support with type inference:

```typescript
interface EmailJob {
  to: string;
  subject: string;
  body: string;
}

const queue = flow.queue<EmailJob>('emails');

// TypeScript knows job.data is EmailJob
queue.process(async (job) => {
  await sendEmail(job.data);
});
```

### 6. Composable

Built for the superfunctions ecosystem:

```typescript
// Works seamlessly with sendfn, plugfn, cachefn, secfn, etc.
const workflow = flow.workflow('onboarding')
  .step('send-email', async (ctx) => {
    await send.email({ ... });
  })
  .step('create-github-issue', async (ctx) => {
    await plug.github.issues.create({ ... });
  });
```

### 7. Observable

Built-in monitoring, metrics, and debugging:

```typescript
const metrics = await flow.metrics.getQueueMetrics('tasks');
console.log(`Throughput: ${metrics.throughput} jobs/min`);
```

## Comparison Matrix

| Feature | FlowFn | BullMQ | Temporal | Kafka | Celery |
|---------|--------|--------|----------|-------|--------|
| Queues | ✅ | ✅ | ❌ | ❌ | ✅ |
| Streams | ✅ | ❌ | ❌ | ✅ | ❌ |
| Workflows | ✅ | ❌ | ✅ | ❌ | ❌ |
| Self-hosted | ✅ | ✅ | ✅ | ✅ | ✅ |
| No Redis required | ✅ | ❌ | ✅ | ✅ | ❌ |
| Edge support | ✅ | ❌ | ❌ | ❌ | ❌ |
| TypeScript-first | ✅ | ✅ | ✅ | ❌ | ❌ |
| Multi-provider | ✅ | ❌ | ❌ | ❌ | ❌ |
| Unified API | ✅ | ❌ | ❌ | ❌ | ❌ |

## License

MIT License

## Contributing

Contributions welcome! See CONTRIBUTING.md for guidelines.

### Adding a New Adapter

1. Create adapter file in `src/adapters/[name].ts`
2. Implement `FlowAdapter` interface
3. Add tests
4. Add documentation
5. Submit PR

### Provider Template

```bash
npx flowfn create-adapter --name custom-db --type queue
```

---

**Last Updated**: 2026-01-13  
**Monorepo Version**: 0.1.0  
**Package Manager**: npm@10.2.0  
**Build Tool**: Turbo v2.0.0

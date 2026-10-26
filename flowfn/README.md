# FlowFn

> Self-hosted flow control platform for developers - Queues, Streams, and Workflows

## Overview

FlowFn is a developer-first flow control solution that unifies queues, streams, and workflows into a single self-hosted platform. Think "BullMQ + Temporal + Kafka" - but framework-agnostic, provider-agnostic, and built for the super-functions ecosystem.

**Status**: Specification  
**Target Release**: Q4 2026  
**Version**: 1.0.0

## Features

### 🎯 Unified Interface

Single API for all async processing needs:

```typescript
import { createFlow } from 'flowfn';

const flow = createFlow({ adapter: 'redis' });

// Queues
const queue = flow.queue<EmailJob>('emails');
await queue.add('send', { to: 'user@example.com', subject: 'Welcome!' });

// Streams
const stream = flow.stream<OrderEvent>('orders');
await stream.publish({ orderId: '123', userId: '456', amount: 99.99 });

// Workflows
const workflow = flow.workflow('checkout')
  .step('validate', async (ctx) => { ... })
  .step('charge', async (ctx) => { ... })
  .step('fulfill', async (ctx) => { ... });
  
await workflow.execute({ orderId: '123' });
```

### 🔄 Provider Agnostic

Switch providers without changing code:

```typescript
// Development
const flow = createFlow({ adapter: 'memory' });

// Production (Redis)
const flow = createFlow({ adapter: 'redis', url: process.env.REDIS_URL });

// Production (Postgres)
const flow = createFlow({ adapter: 'postgres', database: adapter });

// Cloud (AWS SQS)
const flow = createFlow({ adapter: 'sqs', region: 'us-east-1' });

// Cloud (Kafka)
const flow = createFlow({ adapter: 'kafka', brokers: ['localhost:9092'] });

// Edge (Cloudflare D1)
const flow = createFlow({ adapter: 'd1', database: env.DB });
```

### ⚡ Key Features

- **Queues**: Job processing, retries, priorities, delays, dead-letter queues
- **Streams**: Event streaming, consumer groups, replay, partitioning
- **Workflows**: Multi-step orchestration, sagas, compensation, approvals
- **Type-Safe**: Full TypeScript support with type inference
- **Self-Hosted**: No external dependencies required (but supported)
- **Edge-Ready**: Works on Cloudflare Workers, Deno Deploy, and servers
- **Observable**: Built-in metrics, monitoring, and debugging
- **Composable**: Seamless integration with other superfunctions

## Installation

```bash
npm install flowfn
```

### With Adapters

```bash
# Redis
npm install flowfn ioredis

# Postgres
npm install flowfn @superfunctions/db drizzle-orm

# AWS SQS
npm install flowfn @aws-sdk/client-sqs

# Kafka
npm install flowfn kafkajs
```

## Quick Start

### 1. Queue Processing

```typescript
import { createFlow } from 'flowfn';

const flow = createFlow({ adapter: 'memory' });

// Define a queue
interface EmailJob {
  to: string;
  subject: string;
  body: string;
}

const emailQueue = flow.queue<EmailJob>('emails');

// Add jobs
await emailQueue.add('send-welcome', {
  to: 'user@example.com',
  subject: 'Welcome!',
  body: 'Thanks for signing up'
});

// Process jobs
emailQueue.process('send-welcome', async (job) => {
  console.log(`Sending email to ${job.data.to}`);
  await sendEmail(job.data);
  return { sent: true };
});
```

### 2. Event Streaming

```typescript
const orderStream = flow.stream<OrderEvent>('orders');

// Publish events
await orderStream.publish({
  orderId: 'order_123',
  userId: 'user_456',
  amount: 99.99,
  items: [{ id: 'item_1', quantity: 2 }]
});

// Subscribe to events
orderStream.subscribe(async (message) => {
  console.log(`Received order: ${message.data.orderId}`);
  await processOrder(message.data);
  await message.ack();
});

// Consumer groups (load balancing)
const consumer = orderStream.createConsumer('worker-1', { 
  groupId: 'processors' 
});

consumer.subscribe(async (message) => {
  await processOrder(message.data);
});
```

### 3. Workflow Orchestration

```typescript
const checkoutWorkflow = flow.workflow('checkout')
  .input<{ userId: string; orderId: string }>()
  
  .step('validate', async (ctx) => {
    const order = await getOrder(ctx.input.orderId);
    ctx.set('order', order);
    return order;
  })
  
  .step('charge', async (ctx) => {
    const order = ctx.get('order');
    const charge = await chargeCustomer(order.userId, order.amount);
    return charge;
  })
  
  .step('fulfill', async (ctx) => {
    const order = ctx.get('order');
    await createShipment(order);
  })
  
  // Compensation on failure
  .compensate('charge', async (ctx) => {
    const charge = ctx.get('charge');
    await refundCustomer(charge.id);
  });

// Execute
const execution = await checkoutWorkflow.execute({
  userId: 'user_123',
  orderId: 'order_456'
});
```

## Integration with SuperFunctions

### With SendFn

```typescript
import { createSendFn } from 'sendfn';

const send = createSendFn({ ... });
const emailQueue = flow.queue('emails');

emailQueue.process(async (job) => {
  await send.email(job.data);
});
```

### With PlugFn

```typescript
import { plugFn } from 'plugfn';

const plug = plugFn({ ... });

plug.github.on('issues.opened', async (event) => {
  await flow.queue('sync-to-linear').add('sync', {
    issue: event.issue,
    userId: event.installation.userId
  });
});
```

### With CacheFn

```typescript
import { cacheFn } from 'cachefn';

const cache = cacheFn({ ... });

const apiQueue = flow.queue('api-calls');

apiQueue.process(async (job) => {
  return await cache.getOrFetch(job.id, {
    fetcher: async () => await callAPI(job.data),
    ttl: 300000
  });
});
```

### With SecFn

```typescript
import { secFn } from 'secfn';

const security = secFn.create({ ... });
const limiter = security.createRateLimiter({ ... });

queue.process(async (job) => {
  const result = await limiter.check({
    userId: job.data.userId,
    endpoint: 'api-call'
  });
  
  if (!result.allowed) {
    throw new Error('Rate limited');
  }
  
  await processJob(job.data);
});
```

## Adapters

### Memory (Development)

```typescript
const flow = createFlow({ adapter: 'memory' });
```

- No dependencies
- In-memory only
- Perfect for development and testing
- Great for edge environments

### Redis

```typescript
import { RedisAdapter } from 'flowfn/adapters/redis';
import Redis from 'ioredis';

const flow = createFlow({
  adapter: new RedisAdapter({
    connection: new Redis(process.env.REDIS_URL)
  })
});
```

- High performance
- Queues via lists
- Streams via Redis Streams
- Widely deployed

### Postgres

```typescript
import { PostgresAdapter } from 'flowfn/adapters/postgres';
import { drizzleAdapter } from '@superfunctions/db/adapters';

const flow = createFlow({
  adapter: new PostgresAdapter({
    database: drizzleAdapter({ db, dialect: 'postgres' })
  })
});
```

- SKIP LOCKED for queues
- JSONB for job data
- No additional infrastructure
- Good for lower throughput

### Cloudflare D1

```typescript
import { D1Adapter } from 'flowfn/adapters/d1';

const flow = createFlow({
  adapter: new D1Adapter({
    database: env.DB
  })
});
```

- Edge-native
- SQLite-based
- Built-in replication
- Perfect for Cloudflare Workers

### AWS SQS

```typescript
import { SQSAdapter } from 'flowfn/adapters/sqs';
import { SQSClient } from '@aws-sdk/client-sqs';

const flow = createFlow({
  adapter: new SQSAdapter({
    client: new SQSClient({ region: 'us-east-1' })
  })
});
```

- Managed service
- Automatic scaling
- Dead-letter queues
- FIFO support

### Apache Kafka

```typescript
import { KafkaAdapter } from 'flowfn/adapters/kafka';
import { Kafka } from 'kafkajs';

const flow = createFlow({
  adapter: new KafkaAdapter({
    client: new Kafka({
      brokers: ['kafka1:9092', 'kafka2:9092']
    })
  })
});
```

- High throughput
- Durable message log
- Consumer groups
- Stream replay

## Monitoring

```typescript
// Queue metrics
const queueMetrics = await flow.metrics.getQueueMetrics('emails');
console.log(`Throughput: ${queueMetrics.throughput} jobs/min`);
console.log(`Avg duration: ${queueMetrics.avgDuration}ms`);

// Stream metrics
const streamMetrics = await flow.metrics.getStreamMetrics('orders');
console.log(`Messages: ${streamMetrics.messages}`);
console.log(`Lag: ${streamMetrics.lag}`);

// Workflow metrics
const workflowMetrics = await flow.metrics.getWorkflowMetrics('checkout');
console.log(`Success rate: ${workflowMetrics.successRate}%`);

// Health check
const health = await flow.healthCheck();
console.log(`Healthy: ${health.healthy}`);
```

## Worker Management

```typescript
import { createWorker } from 'flowfn';

const worker = createWorker({
  flow,
  queues: ['emails', 'notifications'],
  concurrency: {
    emails: 5,
    notifications: 10
  },
  signals: ['SIGTERM', 'SIGINT']
});

await worker.run();
```

## Scheduling

```typescript
const scheduler = flow.scheduler();

// Cron syntax
scheduler.schedule('cleanup', '0 0 * * *', async () => {
  await cleanupOldData();
});

// Every 5 minutes
scheduler.schedule('health-check', '*/5 * * * *', async () => {
  await performHealthCheck();
});
```

## Documentation

- **[Full Specification](./SPEC.md)**: Complete technical specification
- **API Reference**: (Coming soon)
- **Examples**: (Coming soon)
- **Migration Guides**: (Coming soon)

## Architecture

```
flowfn/
├── typescript/          # TypeScript implementation
│   ├── src/
│   │   ├── core/        # Core queue/stream/workflow
│   │   ├── adapters/    # Provider adapters
│   │   ├── patterns/    # Retry, circuit breaker, etc.
│   │   ├── middleware/  # Logging, metrics, tracing
│   │   └── utils/       # Utilities
│   └── examples/
├── python/              # Python implementation (future)
├── dashboard/           # Web dashboard
└── .conduct/            # Implementation artifacts
```

## Roadmap

### Phase 1 (Q1 2026) - Core Foundation
- Core queue system
- Memory and Redis adapters
- Job processing and retries
- Basic monitoring

### Phase 2 (Q2 2026) - Streaming
- Stream interface
- Consumer groups
- Redis Streams adapter

### Phase 3 (Q3 2026) - Workflows
- Workflow engine
- Saga pattern
- Postgres adapter

### Phase 4 (Q4 2026) - Advanced Features
- Cloud adapters (SQS, Kafka)
- Scheduler
- Worker pools
- Dashboard UI
- D1 adapter

## Contributing

Contributions welcome! This project is part of the [superfunctions](https://github.com/21nCo/super-functions) monorepo.

### Development Setup

```bash
# Clone the monorepo
git clone https://github.com/21nCo/super-functions.git
cd super-functions/flowfn

# Install dependencies
npm install

# Build
npm run build

# Test
npm test

# Watch mode
npm run dev
```

## License

MIT License - See [LICENSE](../LICENSE) for details

## Related Projects

- **[AuthFn](../authfn)**: Authentication & API key management
- **[CacheFn](../cachefn)**: Multi-tier caching with memoization
- **[PlugFn](../plugfn)**: Integration platform (OAuth, webhooks, 75+ providers)
- **[SearchFn](../searchfn)**: Browser-first full-text search
- **[SecFn](../secfn)**: Security functions (secrets, rate limiting, monitoring)
- **[SendFn](../sendfn)**: Email/messaging utilities
- **[BotFn](../botfn)**: Bot framework (Discord, GitHub, Linear)

## Support

- **Documentation**: [Full SPEC](./SPEC.md)
- **Issues**: [GitHub Issues](https://github.com/21nCo/super-functions/issues)
- **Discussions**: [GitHub Discussions](https://github.com/21nCo/super-functions/discussions)
- **Email**: hello@21n.org

---

Built with ❤️ by [21n](https://21n.org) as part of the superfunctions ecosystem.

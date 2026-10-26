# FlowFn Implementation Plan

> Implementation roadmap for building FlowFn - Self-hosted flow control platform

**Created**: 2026-01-13  
**Status**: Planning  
**Target Release**: Q4 2026

## Overview

FlowFn is a unified flow control platform providing queues, streams, and workflows with a provider-agnostic API. This document outlines the implementation strategy, architecture decisions, and development phases.

## Architecture Decisions

### 1. Monorepo Structure

Following superfunctions conventions:

```
flowfn/
├── typescript/           # Main TypeScript implementation
│   ├── src/
│   ├── package.json      # Package name: flowfn
│   ├── tsconfig.json
│   └── vitest.config.ts
├── python/               # Python implementation (Phase 5+)
├── dashboard/            # Web UI (Phase 4)
├── .conduct/             # This directory - artifacts
└── README.md
```

### 2. Core Abstractions

**Base Interface Pattern** (inspired by plugfn and authfn):

```typescript
// Core adapter interface
interface FlowAdapter {
  // Queue operations
  enqueue(queue: string, job: Job): Promise<string>;
  dequeue(queue: string): Promise<Job | null>;
  ack(queue: string, jobId: string): Promise<void>;
  nack(queue: string, jobId: string): Promise<void>;
  
  // Stream operations
  publish(stream: string, message: Message): Promise<string>;
  subscribe(stream: string, handler: MessageHandler): Promise<Subscription>;
  
  // Workflow operations
  saveWorkflowState(workflowId: string, state: WorkflowState): Promise<void>;
  loadWorkflowState(workflowId: string): Promise<WorkflowState | null>;
}
```

**Adapter Registry Pattern** (like plugfn providers):

```typescript
const adapters = new Map<string, FlowAdapter>();
adapters.set('memory', new MemoryAdapter());
adapters.set('redis', new RedisAdapter());
adapters.set('postgres', new PostgresAdapter());
```

### 3. Storage Strategy

**Inspired by searchfn and cachefn**:

- **Memory**: LRU cache for in-memory queue/stream (reuse `searchfn/src/cache/lru-cache.ts`)
- **IndexedDB**: Browser persistence (reuse `searchfn/src/storage/indexeddb-manager.ts`)
- **Database**: Via `@superfunctions/db` adapters (like authfn)
- **External**: Redis, SQS, Kafka via dedicated adapters

### 4. Type Safety

**Full TypeScript support** (inspired by cachefn type-safe patterns):

```typescript
// Typed queues
interface EmailJob {
  to: string;
  subject: string;
  body: string;
}

const queue = flow.queue<EmailJob>('emails');

// TypeScript infers job.data is EmailJob
queue.process(async (job) => {
  // job.data.to is string
  // job.data.subject is string
  // job.data.body is string
});
```

### 5. Event System

**Event-driven architecture** (similar to botfn):

```typescript
flow.on('job:created', (event) => { ... });
flow.on('job:completed', (event) => { ... });
flow.on('workflow:started', (event) => { ... });
```

## Implementation Phases

### Phase 1: Core Queue System (Weeks 1-4)

**Goal**: Basic queue functionality with memory and Redis adapters

**Tasks**:

1. **Project Setup**
   - [ ] Create `flowfn/typescript/` directory structure
   - [ ] Setup `package.json` with dependencies
   - [ ] Configure TypeScript (`tsconfig.json`)
   - [ ] Setup Vitest for testing
   - [ ] Create basic exports in `src/index.ts`

2. **Core Queue Implementation**
   - [ ] `src/core/flow-fn.ts` - Main entry point
   - [ ] `src/queue/queue.ts` - Queue interface
   - [ ] `src/queue/job.ts` - Job representation
   - [ ] `src/queue/worker.ts` - Worker implementation
   - [ ] `src/queue/processor.ts` - Job processing logic
   - [ ] `src/queue/types.ts` - TypeScript types

3. **Memory Adapter**
   - [ ] `src/adapters/base.ts` - Base adapter interface
   - [ ] `src/adapters/memory.ts` - In-memory implementation
   - [ ] Use LRU cache from searchfn patterns
   - [ ] Job queue using array/Map
   - [ ] Priority queue implementation

4. **Redis Adapter**
   - [ ] `src/adapters/redis.ts` - Redis implementation
   - [ ] Use Redis lists for queues
   - [ ] BRPOP for blocking dequeue
   - [ ] Redis hashes for job storage
   - [ ] Priority using sorted sets

5. **Retry & Error Handling**
   - [ ] `src/patterns/retry.ts` - Retry logic
   - [ ] `src/patterns/backoff.ts` - Backoff strategies
   - [ ] Exponential backoff implementation
   - [ ] Dead-letter queue support
   - [ ] Job failure tracking

6. **Basic Monitoring**
   - [ ] `src/monitoring/metrics.ts` - Metrics collection
   - [ ] Queue stats (waiting, active, completed, failed)
   - [ ] Job duration tracking
   - [ ] Throughput calculation

7. **Tests**
   - [ ] Unit tests for queue operations
   - [ ] Memory adapter tests
   - [ ] Redis adapter tests (with ioredis-mock or real Redis)
   - [ ] Retry logic tests
   - [ ] Error handling tests

**Dependencies**:
```json
{
  "dependencies": {
    "ioredis": "^5.3.2"
  },
  "devDependencies": {
    "typescript": "^5.6.0",
    "vitest": "^1.0.0",
    "@types/node": "^20.0.0"
  }
}
```

**Deliverables**:
- Working queue system
- Memory adapter (no dependencies)
- Redis adapter (ioredis)
- Retry and backoff logic
- Basic metrics
- 90%+ test coverage

### Phase 2: Stream Processing (Weeks 5-8)

**Goal**: Event streaming with Redis Streams adapter

**Tasks**:

1. **Stream Interface**
   - [ ] `src/stream/stream.ts` - Stream interface
   - [ ] `src/stream/producer.ts` - Message publishing
   - [ ] `src/stream/consumer.ts` - Message consumption
   - [ ] `src/stream/consumer-group.ts` - Consumer group support
   - [ ] `src/stream/types.ts` - TypeScript types

2. **Memory Stream Adapter**
   - [ ] In-memory message log
   - [ ] Simple pub/sub implementation
   - [ ] Consumer group simulation

3. **Redis Streams Adapter**
   - [ ] Extend `src/adapters/redis.ts` with stream support
   - [ ] XADD for publishing
   - [ ] XREAD/XREADGROUP for consuming
   - [ ] Consumer group management (XGROUP)
   - [ ] Acknowledgment (XACK)

4. **Pattern Matching**
   - [ ] Event pattern matching (e.g., `order.*`)
   - [ ] Subscription management
   - [ ] Event routing

5. **Stream Management**
   - [ ] Stream trimming (XTRIM)
   - [ ] Message range queries (XRANGE)
   - [ ] Stream info (XINFO)
   - [ ] Consumer lag tracking

6. **Tests**
   - [ ] Stream publish/subscribe tests
   - [ ] Consumer group tests
   - [ ] Pattern matching tests
   - [ ] Lag tracking tests

**Deliverables**:
- Stream interface
- Memory stream adapter
- Redis Streams adapter
- Consumer groups
- Pattern-based subscriptions
- Stream management tools

### Phase 3: Workflow Engine (Weeks 9-14)

**Goal**: Multi-step workflow orchestration with state persistence

**Tasks**:

1. **Workflow Core**
   - [ ] `src/workflow/workflow.ts` - Workflow definition
   - [ ] `src/workflow/step.ts` - Workflow step
   - [ ] `src/workflow/execution.ts` - Execution context
   - [ ] `src/workflow/builder.ts` - Builder pattern API
   - [ ] `src/workflow/types.ts` - TypeScript types

2. **Workflow Engine**
   - [ ] `src/core/workflow-engine.ts` - Execution engine
   - [ ] Step execution
   - [ ] State management
   - [ ] Context passing between steps
   - [ ] Step result handling

3. **Control Flow**
   - [ ] Sequential steps
   - [ ] Parallel steps
   - [ ] Conditional branching
   - [ ] Loops (future)

4. **Error Handling**
   - [ ] Step-level error handlers
   - [ ] Workflow-level error handlers
   - [ ] Retry logic for steps
   - [ ] Error propagation

5. **Saga Pattern**
   - [ ] `src/workflow/saga.ts` - Saga implementation
   - [ ] Compensation logic
   - [ ] Automatic rollback on failure
   - [ ] Transaction boundaries

6. **State Persistence**
   - [ ] `src/storage/workflow-storage.ts` - State persistence
   - [ ] Workflow execution history
   - [ ] Event sourcing for workflow events
   - [ ] State snapshots

7. **Postgres Adapter**
   - [ ] `src/adapters/postgres.ts` - Postgres implementation
   - [ ] SKIP LOCKED for queue dequeue
   - [ ] JSONB for job/workflow data
   - [ ] Schema creation via Drizzle
   - [ ] Integration with `@superfunctions/db`

8. **Tests**
   - [ ] Workflow execution tests
   - [ ] Parallel step tests
   - [ ] Branching tests
   - [ ] Saga compensation tests
   - [ ] State persistence tests
   - [ ] Postgres adapter tests

**Dependencies**:
```json
{
  "dependencies": {
    "@superfunctions/db": "workspace:*",
    "drizzle-orm": "^0.29.0"
  }
}
```

**Deliverables**:
- Workflow engine
- Builder API
- Saga pattern support
- State persistence
- Postgres adapter
- Comprehensive tests

### Phase 4: Advanced Features (Weeks 15-20)

**Goal**: Cloud adapters, scheduling, worker pools, dashboard

**Tasks**:

1. **Cloud Adapters**
   - [ ] `src/adapters/sqs.ts` - AWS SQS adapter
   - [ ] `src/adapters/kafka.ts` - Apache Kafka adapter
   - [ ] `src/adapters/pubsub.ts` - Google Pub/Sub adapter
   - [ ] `src/adapters/rabbitmq.ts` - RabbitMQ adapter
   - [ ] `src/adapters/d1.ts` - Cloudflare D1 adapter

2. **Scheduler**
   - [ ] `src/scheduler/cron.ts` - Cron scheduling
   - [ ] `src/scheduler/delay.ts` - Delayed jobs
   - [ ] `src/scheduler/recurring.ts` - Recurring tasks
   - [ ] Cron expression parsing
   - [ ] Timezone support

3. **Worker Management**
   - [ ] `src/core/worker-pool.ts` - Worker pool
   - [ ] Auto-scaling logic
   - [ ] Worker health monitoring
   - [ ] Graceful shutdown
   - [ ] Distributed worker coordination

4. **Advanced Patterns**
   - [ ] `src/patterns/circuit-breaker.ts` - Circuit breaker
   - [ ] `src/patterns/rate-limit.ts` - Rate limiting
   - [ ] `src/patterns/batching.ts` - Batch processing
   - [ ] `src/patterns/priority.ts` - Priority queues

5. **Dashboard UI**
   - [ ] `dashboard/` - React/Svelte dashboard
   - [ ] Queue visualization
   - [ ] Stream monitoring
   - [ ] Workflow builder (visual)
   - [ ] Metrics charts
   - [ ] Real-time updates (WebSocket)

6. **OpenTelemetry**
   - [ ] `src/middleware/tracing.ts` - Tracing integration
   - [ ] Span creation for jobs/workflows
   - [ ] Automatic instrumentation
   - [ ] Context propagation

7. **Tests**
   - [ ] Cloud adapter tests
   - [ ] Scheduler tests
   - [ ] Worker pool tests
   - [ ] Pattern tests
   - [ ] Integration tests

**Dependencies**:
```json
{
  "dependencies": {
    "@aws-sdk/client-sqs": "^3.0.0",
    "kafkajs": "^2.2.4",
    "@google-cloud/pubsub": "^4.0.0",
    "amqplib": "^0.10.0",
    "@opentelemetry/api": "^1.7.0"
  }
}
```

**Deliverables**:
- Cloud adapters (SQS, Kafka, Pub/Sub, RabbitMQ, D1)
- Cron scheduler
- Worker pools with auto-scaling
- Advanced patterns
- Dashboard UI
- OpenTelemetry integration

### Phase 5: Ecosystem Integration (Weeks 21-24)

**Goal**: Deep integration with other superfunctions, Python SDK, polish

**Tasks**:

1. **SuperFunction Integrations**
   - [ ] SendFn integration examples
   - [ ] PlugFn integration (webhook processing)
   - [ ] CacheFn integration (result caching)
   - [ ] SecFn integration (rate limiting, access control)
   - [ ] BotFn integration (command queues)
   - [ ] AuthFn integration (worker authentication)

2. **Python SDK**
   - [ ] `python/flowfn/` - Python implementation
   - [ ] Queue API
   - [ ] Stream API
   - [ ] Workflow API
   - [ ] Adapter implementations
   - [ ] Type hints (typing)
   - [ ] Tests with pytest

3. **Framework Adapters**
   - [ ] Express middleware
   - [ ] Fastify plugin
   - [ ] Hono middleware
   - [ ] Next.js API routes helpers
   - [ ] SvelteKit hooks helpers

4. **Documentation**
   - [ ] Complete API reference
   - [ ] Getting started guide
   - [ ] Adapter guide
   - [ ] Pattern guide
   - [ ] Integration examples
   - [ ] Migration guides

5. **Performance Optimization**
   - [ ] Benchmarking suite
   - [ ] Memory optimization
   - [ ] Connection pooling
   - [ ] Batch operations
   - [ ] Lazy loading

6. **Polish**
   - [ ] Error messages
   - [ ] Logging improvements
   - [ ] CLI improvements
   - [ ] TypeScript strict mode
   - [ ] Bundle size optimization

**Deliverables**:
- SuperFunction integration examples
- Python SDK
- Framework adapters
- Complete documentation
- Performance benchmarks
- Production-ready release

## Technical Decisions

### 1. Dependencies Strategy

**Minimal Core Dependencies**:
- TypeScript (dev)
- Vitest (dev)
- No runtime dependencies for core

**Adapter-Specific Dependencies**:
- ioredis (Redis adapter)
- @superfunctions/db (Postgres adapter)
- @aws-sdk/client-sqs (SQS adapter)
- kafkajs (Kafka adapter)

**Peer Dependencies**:
- Allow users to bring their own Redis/DB clients

### 2. Testing Strategy

**Unit Tests** (Vitest):
- 90%+ coverage target
- Fast (<1s for unit tests)
- Mock external dependencies

**Integration Tests**:
- Real adapter tests (optional, via env vars)
- End-to-end workflow tests
- Framework integration tests

**Performance Tests**:
- Benchmark suite
- Throughput tests (jobs/sec, messages/sec)
- Latency tests (p50, p95, p99)
- Memory profiling

### 3. Versioning Strategy

**Semantic Versioning**:
- 0.x.x during development
- 1.0.0 for first stable release
- Breaking changes → major version
- New features → minor version
- Bug fixes → patch version

**Adapter Versioning**:
- Core and adapters versioned together
- Breaking adapter changes → breaking core change

### 4. Documentation Strategy

**Code Documentation**:
- TSDoc comments for all public APIs
- Examples in docstrings
- Type definitions as documentation

**External Documentation**:
- README.md (overview, quick start)
- SPEC.md (complete specification)
- API docs (generated from TSDoc)
- Integration guides
- Migration guides

### 5. Performance Targets

**Phase 1 (Core Queue)**:
- Memory adapter: 10,000+ jobs/sec
- Redis adapter: 5,000+ jobs/sec
- Dequeue latency: <10ms (p99)

**Phase 2 (Streams)**:
- Memory adapter: 50,000+ messages/sec
- Redis Streams: 10,000+ messages/sec
- Consume latency: <10ms (p99)

**Phase 3 (Workflows)**:
- Workflow step overhead: <50ms per step
- State persistence: <20ms
- Concurrent workflows: 1,000+ active

## Risk Mitigation

### Risk 1: Adapter Compatibility

**Risk**: Different providers have different semantics

**Mitigation**:
- Clear adapter interface contract
- Extensive adapter tests
- Document provider-specific behavior
- Provide adapter comparison matrix

### Risk 2: Performance

**Risk**: Abstraction overhead impacts performance

**Mitigation**:
- Benchmark against raw providers
- Target <10% overhead vs native
- Optimize hot paths
- Provide escape hatches for advanced users

### Risk 3: State Management Complexity

**Risk**: Workflow state management is complex

**Mitigation**:
- Event sourcing pattern
- State snapshots
- Comprehensive tests
- Clear state machine documentation

### Risk 4: Edge Environment Constraints

**Risk**: Cloudflare Workers has limitations (CPU time, no TCP)

**Mitigation**:
- D1 adapter designed for Workers
- HTTP-based adapters (SQS, Pub/Sub)
- Clear documentation of limitations
- Memory adapter as fallback

## Success Criteria

### Phase 1 Success
- [ ] Queue operations working
- [ ] Memory and Redis adapters complete
- [ ] 90%+ test coverage
- [ ] Basic docs written
- [ ] Can process 5,000+ jobs/sec (Redis)

### Phase 2 Success
- [ ] Stream operations working
- [ ] Consumer groups functional
- [ ] Pattern matching works
- [ ] 90%+ test coverage
- [ ] Can handle 10,000+ messages/sec (Redis)

### Phase 3 Success
- [ ] Workflows execute successfully
- [ ] Saga compensation works
- [ ] State persists correctly
- [ ] Postgres adapter functional
- [ ] 90%+ test coverage

### Phase 4 Success
- [ ] Cloud adapters working
- [ ] Scheduler functional
- [ ] Dashboard deployed
- [ ] Advanced patterns implemented
- [ ] OpenTelemetry integrated

### Phase 5 Success
- [ ] All integrations documented
- [ ] Python SDK released
- [ ] Complete documentation
- [ ] Performance benchmarks published
- [ ] 1.0.0 release candidate ready

## Open Questions

1. **Should we support multiple workflows per execution?**
   - Pro: More flexible
   - Con: Adds complexity
   - Decision: Start simple, add if needed

2. **How to handle long-running workflows (days/weeks)?**
   - Option A: Durable timers (like Temporal)
   - Option B: External cron + workflow resume
   - Decision: Option B for Phase 1, Option A for Phase 4

3. **Should we support workflow versioning?**
   - Pro: Allow workflow updates without breaking running instances
   - Con: Complexity
   - Decision: Yes, but Phase 5+

4. **How to handle distributed transactions across adapters?**
   - Option A: Two-phase commit
   - Option B: Saga pattern only
   - Decision: Saga pattern (simpler, more reliable)

5. **Should we provide a hosted version?**
   - Pro: Easier onboarding
   - Con: Against self-hosted philosophy
   - Decision: Self-hosted first, hosted optional (future)

## Resources

### Code References
- **searchfn**: Storage patterns (IndexedDB, LRU cache)
- **cachefn**: Type-safe patterns, multi-tier storage
- **plugfn**: Provider/adapter pattern, OAuth flows
- **authfn**: Database adapter integration
- **secfn**: Rate limiting patterns
- **botfn**: Event-driven architecture, shared types

### External References
- **BullMQ**: Queue patterns and API design
- **Temporal**: Workflow orchestration patterns
- **Kafka**: Stream processing concepts
- **AWS Step Functions**: State machine patterns
- **Celery**: Task queue patterns (Python)

### Learning Resources
- Redis Streams documentation
- SKIP LOCKED pattern (Postgres)
- Saga pattern
- Event sourcing
- CQRS pattern

---

**Next Steps**:
1. Review this plan with team
2. Setup initial project structure
3. Start Phase 1 implementation
4. Create GitHub project board for tracking
5. Setup CI/CD pipeline

**Last Updated**: 2026-01-13  
**Authors**: AI Agent (with human review pending)

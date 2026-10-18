# @flowfn/core

Typed queues, streams and workflows with memory, Redis and PostgreSQL adapters.
Requires Node.js 20 or newer. Install with `npm install @flowfn/core`.

```ts
import { createFlow } from '@flowfn/core';
import { MemoryAdapter } from '@flowfn/core/adapters/memory';

const flow = createFlow({ adapter: new MemoryAdapter() });
const queue = flow.queue<{ recipient: string }>('mail');
queue.process('send', async job => ({ recipient: job.data.recipient, sent: true }));
await queue.add('send', { recipient: 'person@example.com' });
await queue.drain();
await flow.close();
```

Both CommonJS and ESM entry points include declarations. Adapter entry points are
`@flowfn/core/adapters/memory`, `/adapters/redis` and `/adapters/postgres`.
The PostgreSQL adapter accepts an initialized Drizzle database and owns its
namespaced tables; call its `initialize()` before use. Memory state is not durable.

See [queue ownership](docs/queue-ownership.md) for lease recovery, atomic
deduplication and at-least-once delivery; [retry strategies](docs/retry-strategies.md)
for custom backoff; and [usage](docs/USAGE.md) for the broader API.

D1, SQS and Kafka adapters are not implemented. Stream partition assignment,
distributed trace propagation, global bounded shutdown and the original performance targets
remain incomplete. Workflow ownership and scheduler coordination are durable on
Redis and PostgreSQL. This package is not yet a production-readiness claim.

### Workers and autoscaling

`createWorker({ flow, queues, concurrency, shutdownTimeout, signals })` owns only
its registered processors. `await worker.close()` aborts those jobs' signals and
waits up to `shutdownTimeout` (30 seconds by default); producers and other workers
on the queue remain usable. On timeout it rejects, stops renewing the abandoned
leases and fences late results. JavaScript callbacks and external side effects
cannot be forcibly stopped: handlers must observe `job.signal` and use idempotent
external operations. Recovery remains at least once.

`createWorkerPool({ flow, queues, minWorkers, maxWorkers, scaleUpThreshold,
scaleDownDelay, pollInterval, workerOptions, signals })` creates in-process worker
groups. Register queue handlers, then call `start()`. The pool adds one worker per
poll while waiting jobs exceed the threshold, and removes idle workers after the
configured delay, respecting the bounds. A zero-worker pool wakes when work
arrives. `getStats()` reports workers and active jobs; `close()` stops scaling and
closes its workers. This does not provision machines or operating-system processes.

Worker settings accept `leaseDuration` (or `lockDuration`), `lockRenewTime`,
`stalledInterval` and `maxStalledCount`. Workers sharing a queue must use compatible
lease settings. Signal handlers are opt-in and are removed on close. Bounded
shutdown here covers worker processors; non-cooperative workflow or scheduler
callbacks still need separate lifecycle handling.

### Errors and tracing

`createFlow({ adapter, onError(error, context) { ... } })` reports failed adapter
operations and job, stream, workflow-step, compensation, and schedule callbacks.
The context contains the operation name and identifying attributes. Failures are
reported at each failed operation boundary; a nested operation can therefore
produce more than one notification. Throwing or returning a rejected promise from
`onError` does not replace the application error.

After configuring your application's OpenTelemetry SDK and context manager,
enable tracing for a flow with `telemetry: { enabled: true }`, or enable it across
runtimes using the instrumentation entry point:

```ts
import { FlowInstrumentation } from '@flowfn/core/instrumentation';
const instrumentation = new FlowInstrumentation();
instrumentation.enable();
// Jobs, workflow steps, stream handlers, schedules and flow-managed adapter
// operations now create active spans using the application's global tracer.
instrumentation.disable();
```

An explicit `telemetry: { enabled: false }` opts a flow out of global tracing.
For a custom OpenTelemetry tracer, pass
`telemetry: { enabled: true, provider: 'custom', tracer }`. Span attributes include
resource and execution identifiers, never job payloads, workflow inputs or message
bodies. Failed spans record exception messages. Configure the SDK's exporter and
sampling policy in the application; FlowFn does not install an exporter or context
manager. Cross-process trace-context propagation remains outstanding.

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
namespaced tables; call its `initialize()` before use. Existing queue tables without
`enqueue_order` require the explicit quiesced ordering migration documented below.
For existing current-schema installations, initialization also installs the
claim-order index with ordinary `CREATE INDEX`, which blocks writes while the
index is built. Schedule a maintenance window for populated queues; this is not
a zero-downtime migration. The index adds storage and write maintenance;
benefits vary with delayed jobs, dependency filters and queue shape. An operator can instead prebuild the exact index
concurrently outside a transaction, then verify its definition and `indisvalid`
before starting workers. A failed concurrent build can leave an invalid named
index that `IF NOT EXISTS` will not repair. Existing legacy/ordering migrations
still require their documented stopped-writer procedure.
Memory state is not durable.

See [queue ownership](docs/queue-ownership.md) for lease recovery, atomic
deduplication and at-least-once delivery; [retry strategies](docs/retry-strategies.md)
for custom backoff; and [usage](docs/USAGE.md) for the broader API.

D1, SQS and Kafka adapters are not implemented. Python stream partition assignment,
distributed trace propagation and the original performance targets
remain incomplete. Workflow ownership and scheduler coordination are durable on
Redis and PostgreSQL. This package is not yet a production-readiness claim.

### Workers and autoscaling

`createWorker({ flow, queues, concurrency, shutdownTimeout, signals })` owns only
its registered processors. `await worker.close()` aborts those jobs' signals and
waits up to `shutdownTimeout` (25 seconds by default); producers and other workers
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
lease settings. Signal handlers are opt-in and are removed on close.

### Shutdown

`await flow.close({ timeout: 25_000 })` shares one deadline across workers, queues,
workflows, schedules, streams and adapter cleanup. Closing rejects new work, aborts
active callback signals, removes polling and signal handlers, and attempts storage
cleanup even when a component times out. The default is 25 seconds. A timeout
rejects with `ShutdownTimeoutError` and fences late callback results. Individual
resources also accept `close({ timeout })`.

Handlers must cooperate with cancellation; shutdown cannot undo external side
effects or storage requests already issued. Redis connections are disconnected
when cleanup fails or times out. PostgreSQL connections belong to the caller, who
must close their own pool after closing the flow.

### Stream retention and ownership

PostgreSQL supports `flow.stream('orders', { partitions: 3 })`. Configure the
count before publishing or creating a consumer group. The persisted count is
immutable; reopening without a count adopts the stored policy. A conflicting
count or an attempt to partition a populated legacy stream fails. A FlowFn instance
caches stream handles: repeating `stream(name)` reuses the handle, while changing
its explicit partition setting fails instead of being ignored. Use a new FlowFn
instance to validate an explicit count against an already persisted policy. Drain all old
writers before enabling this feature: older binaries do not enforce the policy.
`initialize()` adds policy, partition-progress and partition-barrier tables. Run
it in a controlled migration window before starting new workers. The repository
retains equivalent Drizzle schema metadata for migration tooling; it is not a
published package export. Existing
streams remain unpartitioned, and historical explicit labels are not rerouted.

Keys route by SHA-256 of exact UTF-8 bytes, using the unsigned big-endian first
four bytes modulo the partition count. Explicit `partition` overrides the key;
unkeyed messages use their generated ID. Invalid ranges and malformed Unicode
are rejected. Each group has independent partition progress. An unacknowledged
message blocks later messages in its partition while other partitions can run.
A bounded receipt/expiry barrier survives payload retention, so trimming an active
message does not release its partition early. Its lease cannot renew after payload
deletion; an authorized acknowledgment/requeue or storage-clock expiry releases
the barrier. Payload retention is not extended. Drain partition consumers when
upgrading from builds without this barrier table before initializing and resuming.
Expired receipts can be reassigned; stale acknowledgments are fenced, but
uncooperative handler side effects cannot be forcibly stopped. Public message
IDs, global offsets, ranges and retention remain unchanged.

Memory supports the same configured partition routing, immutable count, group
progress and current-receipt fencing within one adapter instance. Reopening a
stream handle on that instance preserves its policy/cursors; a new adapter or
process has no durable history. Configured Memory partition consumers renew a
monotonic local lease while their handler runs. Manual unacknowledged deliveries
expire after the handler returns; trimming prevents renewal without releasing the
barrier early. Active callbacks still own their delivered snapshots. Pending/retry
registries retain identities, not additional payload copies. Unsubscribe aborts
owned signals and releases current receipts; stale settlement cannot affect a
successor. Visibility timeout for legacy unpartitioned Memory streams remains an
unfinished behavior and is not implied by this partition support.

Redis supports the same immutable routing policy with independent group progress
and Redis-clock receipt barriers. Global Redis Stream IDs and payload history are
preserved; sparse partition indices contain IDs only. Trimming removes those
indices together with history, while a live barrier survives until authorized
settlement or expiry. A claim examines at most 64 populated partitions and advances
its scan position, rather than allocating for every configured partition. Returned
manual callbacks stop renewal while retaining expiry observation. Drain old writers
before enabling partitioning: older binaries do not maintain these indices/barriers.
Use a dedicated key prefix; external key mutation is outside the supported contract.
Server persistence, failover and Redis Cluster acceptance are not established by
local worker-crash tests. Retention and statistics work scales with populated
partitions/retained IDs; no stream throughput guarantee follows from these tests.

Python partition support remains unfinished. The TypeScript stream API rejects
configured partitioning or explicit partition publication when the adapter lacks
this capability. PostgreSQL policy coordination adds transactional work to
publication; stream throughput has not been qualified by this correctness acceptance.

Configured `maxLength` and millisecond `retention` policies run after publishing,
before history reads, and before subscription acquisition. An idle stream's next
read therefore removes expired history without requiring another publish. Redis
age trimming uses its server clock. Retention configuration remains local to the
stream instance; applications must supply the policy when reopening a stream.

Redis consumer deliveries carry an atomic attempt token. Acknowledgment, requeue,
and unsubscribe cannot change a replacement delivery, even when consumers reuse a
name. A delivery past its visibility timeout cannot acknowledge until it is
reclaimed as a new attempt. Redis and PostgreSQL renew the receipt while its
handler is running. `message.signal` aborts when ownership is lost, renewal cannot
be confirmed before the last lease deadline, or the consumer unsubscribes.
Callbacks must cooperate with the signal; late acknowledgments remain fenced.
After the handler returns, expiry observation releases local consumer capacity and
aborts the old signal when its receipt expires; polling must obtain a fresh receipt.
Renewal stops when the handler returns, so delayed manual acknowledgment and
`commitInterval` must fit within the remaining visibility lease.

### Message filters

`stream.subscribe(handler, { filter })` and
`stream.createConsumer(id, { groupId, filter })` accept synchronous or asynchronous
predicates receiving the typed message. A false result skips the handler. For a
consumer group it acknowledges that delivery even with `autoCommit: false`, so
filtered records cannot block later messages. Retained history and other groups
are unchanged. Predicate errors follow normal delivery retries and `onError`
reporting. Consumers in one group should use the same predicate.

### Remote workflow cancellation

`workflow.cancelExecution(id)` accepts executions owned by another registered
runtime. The request is persisted in the execution inbox and applied by the owner
at a step boundary, while waiting, or after lease renewal. A queued request also
survives owner failure and is applied when the execution resumes. The owning
runtime aborts `context.signal` and runs recorded compensations under its lease.
The admin cancellation operation uses the same path. Await `waitForCompletion`
to observe final settlement; accepting a cancellation request does not mean a
non-cooperative callback or external side effect has stopped.

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

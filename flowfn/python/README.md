# FlowFn Python SDK

Distributed job queues, event streams, and workflow orchestration for Python.

## Features

- **Queues**: Background job processing with retries, priorities, and batch processing
- **Streams**: Pub/sub event streaming with consumer groups and replay
- **Workflows**: Multi-step orchestration with state management and compensation
- **Patterns**: Rate limiting, batching, priority queues, circuit breakers
- **Storage**: Pluggable storage backends (Memory, Redis, PostgreSQL)
- **Monitoring**: Health checks, metrics, and event tracking

## Installation

```bash
pip install flowfn
```

With optional adapters:

```bash
pip install flowfn[redis]     # Redis adapter
pip install flowfn[postgres]  # PostgreSQL adapter
pip install flowfn[all]       # All adapters
```

## Quick Start

### Queue Example

```python
from flowfn import create_flow

flow = create_flow(adapter='memory')

# Create a queue
queue = flow.queue('emails')

# Add jobs
await queue.add('send-welcome', {
    'to': 'user@example.com',
    'template': 'welcome'
})

# Process jobs
@queue.process()
async def process_email(job):
    await send_email(job.data['to'], job.data['template'])
    return {'sent': True}
```

### Stream Example

```python
# Create a stream
stream = flow.stream('events')

# Publish events
await stream.publish({
    'type': 'user.created',
    'user_id': '123'
})

# Subscribe to events
@stream.subscribe()
async def handle_event(message):
    print(f"Received: {message.data}")
    await message.ack()
```

### Workflow Example

```python
# Define a workflow
workflow = (
    flow.workflow('process-order')
    .step('validate', validate_order)
    .step('charge', charge_payment)
    .step('fulfill', fulfill_order)
    .build()
)

# Execute workflow
execution = await workflow.execute({
    'order_id': '123',
    'amount': 99.99
})
```

## Documentation

- [API Reference](docs/API.md)
- [Usage Guide](docs/USAGE.md)
- [Examples](examples/)

## Development

```bash
# Install development dependencies
pip install -e ".[dev]"

# Run tests
pytest

# Format code
black flowfn tests

# Type checking
mypy flowfn
```

## License

MIT

## Stream delivery and lifecycle

Use `await stream.subscribe(handler)` when you need registration to finish before an external producer sends messages. Decorator registration starts asynchronously; `await stream.ready()` provides the same barrier. Publishing through that stream instance waits for its registrations. Close streams and the owning FlowFn instance to unsubscribe and await background cleanup.

Memory streams retain independent progress and fenced receipts for each consumer group. Each message goes to one member of each group. With `auto_commit=False`, call `await message.ack()` to release its in-flight slot. `await message.nack(requeue=True)` schedules another delivery; `requeue=False` discards that delivery. Disconnecting a member returns its unacknowledged work to the group. A new group with `from_beginning=True` starts from the retained history; reconnecting an existing group continues its pending work. Memory state is process-local and does not survive process termination. Handlers should tolerate redelivery.

`await stream.get_message_count()`, replay and trimming read the adapter's retained stream state, including messages published by another instance. For all Memory streams, zero `max_length` removes held and unread payloads from retained history while current receipts remain until authorized settlement or expiry. Deleted payloads are not redelivered from hidden queues. This changes the older unconfigured Memory behavior that protected pending/unread payloads against retention. Set retention long enough for the required processing/replay window; use a durable provider for restart persistence. Python Redis/PostgreSQL still have their older pending-payload retention behavior and require parity work.

### Partitioned Memory streams

```python
from flowfn.stream.types import ConsumerOptions, PublishOptions

stream = flow.stream('orders', {'partitions': 8})
await stream.publish({'order': 123}, PublishOptions(key='customer-42'))
consumer = stream.create_consumer('worker', ConsumerOptions(
    group_id='billing', from_beginning=True, visibility_timeout=30000,
))
await consumer.subscribe(handle_order)  # handler explicitly awaits message.ack()
```

Python Memory supports immutable counts from 1 through 2,147,483,647. Keys use exact UTF-8 SHA-256, first four bytes interpreted as unsigned big-endian, modulo count (`sha256-utf8-u32be-v1`), matching TypeScript. Omitted keys route by the stable message ID; explicit partition indices must be within the configured range. Sparse progress uses only encountered partitions. Global message IDs, retained history, range reads, and replay remain available across partitions.

Configured groups have one current receipt per partition; different groups and partitions progress independently. Unconfigured groups use one receipt per message and preserve concurrency across different messages. Both modes share the same lifecycle. An active callback renews its receipt. After a manual callback returns, renewal stops and the last confirmed `visibility_timeout` (milliseconds) bounds its remaining ownership. Expiry permits redelivery of retained messages; stale ACK/NACK closures cannot settle a replacement receipt. Trimming removes payloads without releasing a live partition barrier. Trimmed deliveries cannot renew, and their callbacks are cancelled when renewal fails; their barriers remain until authorized settlement or the original deadline. Unsubscribe cancels and awaits owned callbacks before releasing their receipts. A callback that suppresses cancellation can delay shutdown; fencing cannot undo its external side effects.

The count persists only in the same Memory adapter instance. Reopening an unconfigured stream handle adopts it; changing it or converting a previously used legacy stream fails. Changing a cached handle's requested count also fails; use a new Flow instance with the same adapter to adopt an existing policy. Process termination loses Memory state.

Python Redis/PostgreSQL partition implementations are still pending. Explicit `partitions` requests fail before publication, retention, or consumer-group mutation on unsupported adapters. Existing unconfigured provider behavior remains available. This does not establish cross-language durable-store compatibility or Python performance targets.

Custom Python adapters must implement `update_job`, `get_stream_messages`, `trim_stream`, and consumer options in `consume`. Consumer subscriptions provide `pause`, `resume`, and `unsubscribe`. Custom backoff callbacks are process-local configuration; hosts restoring serialized jobs must restore their strategy callable.

## Failed jobs and retention

Terminal failures are recorded in the adapter's dead-letter store. `await flow.dlq().retry(job_id, original_queue='emails')` atomically restores the job to its queue with its original options and resets its attempt state. Specify the queue when job IDs occur in multiple queues. `retry_all(queue_name)` requeues each record; a storage error propagates and leaves unsuccessful records available for recovery.

`remove_on_complete` and `remove_on_fail` accept `True` for immediate removal, `False` to retain jobs, or a nonnegative integer to keep that many newest terminal jobs of the corresponding status. Failed-job removal does not erase its dead letter. Dependency outcomes remain available while existing nonterminal jobs need them, then are released. A newly added dependency on a previously removed job cannot recover its old outcome.

Custom adapters must implement dead-letter save/list/delete and atomic `retry_dead_letter` operations in addition to normal job transitions. The memory adapter keeps all state only for the lifetime of the adapter.

## Scheduling

`flow.scheduler()` uses the FlowFn adapter to persist schedules and coordinate owners. `Scheduler()` without an adapter remains process-local. Register schedules inside a running asyncio loop; callbacks are async functions receiving the configured `data` (or `None`). Cron expressions have five fields and accept an IANA timezone; repeat intervals are milliseconds.

```python
scheduler = flow.scheduler()
scheduler.schedule('weekly-report', '0 9 * * MON', report,
                   timezone_name='America/New_York', data={'type': 'weekly'})
scheduler.repeat('health-check', 5000, check_health, limit=10)
await scheduler.ready()  # definitions are now durably registered
await scheduler.pause('weekly-report')
await scheduler.resume('weekly-report')
await scheduler.cancel('weekly-report')
```

`await scheduler.list()` returns detached snapshots with next run time, attempted run count and the latest callback error. Callback failures count toward the optional run limit and do not stop subsequent scheduled runs. Invocations of the same schedule never overlap; missed repeat intervals are skipped. `start_date` must be timezone-aware. Pausing prevents new invocations; an already running callback continues. Closing the scheduler or FlowFn cancels and awaits its callbacks. With a durable adapter, definitions, run counts, pause state and next-run timestamps survive process termination. Register the same names/configuration and callback code after restart; call `ready()` to validate registration. Multiple processes may register an identical schedule; storage leases admit one owner. A changed configuration under the same name is rejected. Closing a scheduler releases ownership while preserving its schedules; `cancel(name)` persistently cancels that schedule. An interrupted callback can be retried, so callbacks must tolerate repeated external side effects.

## Redis adapter

Install `flowfn[redis]` and pass an adapter explicitly:

```python
from flowfn.adapters.redis import RedisAdapter
flow = create_flow(RedisAdapter('redis://localhost:6379', namespace='my-app'))
```

Redis 6.2 or newer is required. Independent clients share queue transitions, dependency outcomes, dead letters, workflow snapshots, and stream consumer groups. Namespace keys isolate applications. Common independent queue operations use atomic Redis scripts; dependency/retention transitions use optimistic transactions over per-job records with per-queue ready, due, lease, status, deduplication, and dependency indexes. Mutations write changed records; retained jobs in unrelated queues do not enter the claim path. Persistence across Redis server restarts depends on Redis persistence configuration.

Consumer groups use pending-message recovery with lease heartbeats and ownership-checked acknowledgements. Closing a consumer leaves its unacknowledged deliveries recoverable after `reclaim_after_ms` (default 30 seconds). Handlers must tolerate redelivery after failures or network partitions. Trimming preserves entries still unread or pending in any group, so requested retention bounds may be exceeded until groups acknowledge those messages. Plain subscriptions deliver publications after registration without durable group state.

Active queue jobs receive renewable leases; abandoned jobs become eligible for another claim after lease expiry, and stale completion writes are rejected. Queue handlers receive asyncio cancellation when renewal reports lost ownership or exceeds the conservative local lease deadline, including a hung renewal request. Cancellation is cooperative: handlers that suppress it or perform blocking external work can still continue side effects, so handlers must remain idempotent. Lease loss does not consume the retry budget or write stale completion/DLQ state. Custom adapters provide `lease_loss_event(queue, job)` and `release_job_lease(queue, job)` to expose and clean up their claim monitor (unleased adapters return `None`). `update_job` must atomically persist FAILED state and its dead letter; the queue does not issue a second DLQ write that could resurrect a concurrently retried record. Workflow snapshots persist, but hosts must restore workflow definitions and resume orchestration. Native queue storage still requires workload-specific performance validation against the original latency and throughput targets. Dependency-heavy transitions currently project dependency-connected records, and numeric terminal retention inspects matching terminal history.

Custom Redis backoff functions must be supplied on every producer and worker adapter as `backoff_strategies={job_name: callback}`. Only serializable options are stored; each worker restores the callable by job name before claiming work. Missing registration fails without claiming the job.


## PostgreSQL adapter

Install `flowfn[postgres]` and construct `PostgresAdapter(url, namespace='my-app')` from `flowfn.adapters.postgres`. Pass it to `create_flow` just like the Redis adapter. The adapter installs namespaced `flowfn_py_*` tables and indexes on first use; the database role needs schema-creation permissions. It uses indexed per-job records with per-queue transactional locks and server-side common-operation functions, persisted workflow snapshots and event rows, and leased consumer-group deliveries. Stream operations serialize publication and cursor transitions to avoid skipping concurrently committed messages. Acknowledgement waits for the durable deletion of the pending delivery.

Both durable adapters share queue dependency, deduplication, retention, DLQ, backoff restoration and lease rules. They use the storage server clock for queue lease ownership. Queue state uses native per-job records; same-queue contention and dependency-heavy performance remain validation/implementation gates. PostgreSQL data survives client restarts; database persistence, backups and failover are deployment responsibilities. Consumer-group trimming preserves unread and pending deliveries just as Redis does.

For real local integration tests, point `FLOWFN_REDIS_URL` and `FLOWFN_POSTGRES_URL` at disposable services and run `pytest tests/test_durable_adapters.py`. Tests create unique namespaces and delete their records on teardown. Without those variables, integration cases are explicitly skipped.

Workflow execution discovery reads the adapter's persisted states, so a fresh workflow instance can list executions created by another instance. Lookup/cancellation rejects executions belonging to a different workflow name. Custom adapters must implement `list_workflow_states(workflow_id)` alongside save/load. Listing persisted snapshots does not automatically resume their handlers.

Workflow event history is persisted inside execution snapshots, including compensation failures, and metrics use persisted executions. History survives reconstruction of the workflow object. Event histories and execution snapshots currently have no automatic retention policy; applications with unbounded workflow volume need a retention mechanism before production deployment.


## Workflow ownership and restart recovery

Use `.version('v1')` on the workflow builder and increment it whenever handler semantics change. A structural fingerprint also checks step names/types, parallel layout, delays and nested branches. `await workflow.resume_execution(execution_id)` claims an abandoned running execution after its lease expires; it rejects a different version/structure, an active owner, or a terminal execution. `.lease(milliseconds)` configures renewal/expiry (default 30 seconds). Lease clocks and atomic transitions belong to the storage adapter.

Completed sequential and parallel child steps are checkpointed by path. Branch decisions, delay deadlines, context and pending saga compensation paths are persisted. Recovery skips completed paths and resumes an interrupted compensation phase. Handlers and compensators must be idempotent: a crash between an external side effect and its checkpoint may cause that operation to repeat. Checkpoints cannot make external services transactional. Old owners cannot overwrite a takeover or cancellation. Remote cancellation invalidates ownership; its worker stops when renewal observes the cancellation. Closing FlowFn explicitly cancels its running workflows; a process crash leaves them eligible for recovery.

Custom adapters must implement atomic `transition_workflow_state` create/save/claim/renew/release/cancel/schedule-control operations in addition to snapshot storage and listing. See the shared transition implementation for ownership/version invariants. Recovery requires the application to register the matching handler definitions; Python functions are not serialized into storage.


### Migrating legacy durable queues

The native queue layout is version 2. If a namespace contains a legacy JSON queue snapshot, normal queue operations reject it with migration instructions. Stop every old-layout writer first, then call `await adapter.migrate_legacy_queues()`. Migration atomically imports jobs (including active lease tokens/deadlines), dependency outcomes and dead letters, and commits the layout marker. Repeated or concurrent migration calls are idempotent. The old snapshot remains unchanged as rollback evidence; after new workers start, it is stale and must not be used to resume an old version. Mixed old/new queue writers are unsupported. Workflow and stream layouts are unchanged.

Run `PYTHONPATH=. python benchmarks/native_queues.py` with disposable `FLOWFN_REDIS_URL` / `FLOWFN_POSTGRES_URL` services to compare 0 versus 5,000 unrelated retained jobs, API p50/p99 latency, and concurrent enqueue plus claim-and-complete throughput. The benchmark uses a fresh namespace and removes its records afterward. Passing correctness tests does not establish the specified 10,000 Redis / 1,000 PostgreSQL jobs-per-second targets.

### Stream retention

Configure `flow.stream("events", {"max_length": 10000, "retention": 86400000})` to limit retained entries and age (`retention` is milliseconds). Policies run after publication and before subscription registration, stream information, range reads, and replay; an idle stream has no background cleanup timer. Explicit `stream.trim(TrimStrategy(max_age_seconds=...))` also supports fractional seconds. Redis and PostgreSQL use their storage clock for age, so client clock skew does not prematurely delete fresh entries. Unread and pending consumer-group deliveries remain protected even when they exceed a limit; acknowledgment makes them eligible for the next trim. Invalid limits are rejected before publishing.

Redis and PostgreSQL consumer groups allow concurrent handlers while serializing polling within each subscription, leaving connection-pool capacity for acknowledgment and renewal. Every delivery attempt has a separate ownership token; expired or replaced attempts cannot acknowledge or renew a newer claim. Renewal loss or a hung renewal cancels cooperative handler work by the conservative local lease deadline. External side effects still require idempotency, and noncooperative handlers can outlive cancellation.

Redis stream attempts store a separate token alongside the pending entry. Deploy this ownership format only after stopping older stream workers; mixed old/new workers do not provide per-attempt fencing. Expired pending entries are reclaimed with a new token, and acknowledgment removes the token. Redis consumer names remain stable per subscription.

### Global shutdown

`await flow.close(timeout=30.0)` stops new admission immediately and closes resources concurrently before closing their adapter. Enqueues, stream publications, and workflow startup already admitted finish their storage transitions before cleanup. Workflow startup that races shutdown does not begin a new handler. All close callers share one cleanup operation. If the wait exceeds the timeout (seconds), `TimeoutError` is raised while cleanup continues; call `close()` again to await it. Cancelling one close waiter does not cancel cleanup. A handler that suppresses cancellation can outlive the deadline, so the adapter remains open until that work finishes rather than closing beneath it.

Workflow shutdown cancels persisted execution state only while the local attempt still owns an unexpired lease. A stale runtime stops its local task without cancelling a replacement worker's execution. Explicit `cancel_execution()` remains an administrative cancellation operation.

Workflow renewals retry transient storage errors only within the existing conservative local lease deadline. Explicit ownership loss or a hung renewal cancels cooperative execution without writing stale terminal state; a claim reply arriving after its deadline never starts a handler. `resume_execution()` rejects a second active runtime for the same execution on one workflow object.


### Metrics scope and units

`await flow.metrics.get_queue_metrics(name)` combines persisted job counts with measurements from this FlowFn instance. `throughput` counts successfully committed completions in the current second and preceding 59 whole-second buckets (jobs/minute); failed or fenced completions do not count. Duration averages and p95 values use the most recent 1,000 terminal job durations in milliseconds and survive job removal for the lifetime of this instance.

`get_stream_metrics(name)` reports retained messages and consumer-group lag (unread plus pending deliveries, summed across groups), alongside local publications in the current wall-clock second and average publish latency in milliseconds. Redis versions without group lag support return `None` for lag. Consumer counts are adapter-specific: memory reports active consumers, Redis reports registered consumer metadata, and PostgreSQL returns `None` because it has no durable consumer roster.

`get_workflow_metrics(name)` reads persisted executions, including executions created by other instances; success rate is completed executions divided by all executions, expressed as a percentage. Terminal execution duration is reported in milliseconds. `get_system_metrics()` counts resources and live queue worker tasks registered on this instance. `memory_usage` is current process RSS in bytes when `psutil` is installed, otherwise `None`. Missing latency/duration measurements are `None`. Local counters and duration samples reset on restart and are not cross-process totals; persisted gauges and workflow counts survive restart with durable adapters.


### Optional telemetry

Install `flowfn[telemetry]` and configure your application's OpenTelemetry SDK/exporter, then pass `telemetry={"enabled": True}` to `create_flow`. You can pass `tracer_provider` to avoid changing the global provider, or use `{"enabled": True, "provider": "custom", "tracer": tracer}` with a tracer implementing OpenTelemetry's `start_as_current_span` context manager. W3C propagation uses the optional OpenTelemetry API's trace-context propagator; custom tracers can still emit local spans without that API installed. FlowFn never installs or shuts down a global provider or exporter. Disabled telemetry requires no OpenTelemetry dependency.

Spans cover job handlers, sequential/parallel/saga workflow steps and compensation, stream subscriber/consumer handlers and replay, and public asynchronous adapter operations. Nested adapter calls inherit the active handler span through Python async context. Span attributes contain resource names and IDs, never job input, workflow context, stream payloads, credentials, or adapter arguments. Application exceptions are recorded by the configured tracer and may contain application-supplied text. Producer W3C context is serialized into optional `trace_context` mappings on jobs/workflow snapshots and `traceparent`/`tracestate` stream headers. Consumer handlers extract from an empty root context, so an unrelated worker span cannot become their parent. Missing or malformed carriers start a new trace. Capture runs only when telemetry is enabled; baggage is not automatically propagated.

`on_error(error, context)` receives operation failures with an operation name and resource identifiers; it works independently of tracing and may be synchronous or asynchronous. Callback/tracer exceptions do not replace application results or cause work to execute twice. Callback execution is awaited, so callbacks should return promptly. Nested failing operations can each notify the callback. Cancellation propagates without an error callback. Install `flowfn[monitoring]` to include process memory measurements.


### Storage health

`await flow.health_check(timeout=5.0)` probes the adapter even when no resources are registered. Redis and PostgreSQL return their storage clock; unavailable storage makes `healthy` false. The result includes persisted counts for registered queues/streams, local queue-worker counts, and running/stalled counts for registered workflow names. A running workflow with an absent or expired ownership lease is stalled, using the sampled storage time rather than the client clock. Resource read errors and stalled workflows make the overall result unhealthy. This is a sampled diagnostic, not an atomic snapshot or a discovery scan of all names in storage.

The timeout cancels cooperative provider operations and reports a failed timeout check. Closing/closed instances report unhealthy without probing storage. Missing optional memory instrumentation reports a warning instead of pretending a measurement passed. Custom adapters implement `health_probe()` returning `type`, `connected`, and `server_time` (epoch milliseconds); adapters without a probe are reported unhealthy. PostgreSQL's first probe initializes its normal schema through the same connection path as other operations.


### Lifecycle notifications

`unsubscribe = flow.on("job:completed", callback)` registers a synchronous or asynchronous local callback; call `unsubscribe()` or `flow.off(event_type, callback)` to remove it. Supported notifications include `job:created`, `job:active`, `job:completed`, `job:failed`, `job:stalled`, `stream:message`, and `workflow:started/completed/failed`. Metadata uses Python names such as `job_id`, `execution_id`, `workflow_name`, and `message_id`. Payload/context objects are not included. `flow.get_event_tracker().get_events()` returns detached snapshots of up to 10,000 recent notifications.

Creation, terminal-job, publication and workflow-state notifications follow successful storage operations. Built-in adapters mark the enqueue input with a transient atomic creation receipt, so explicit-ID duplicates and deduplication races produce only the winning creation notification. The private receipt is excluded from serialized jobs; custom adapters should set the input job's `_enqueue_created` to `True` only when that enqueue inserted a new record and `False` when returning an existing job. A missing receipt suppresses creation notification. PostgreSQL's new enqueue reply function retains the previous function for existing clients; stored queue layout remains version 2.

These notifications are local, best-effort observations, not a durable event delivery service: a crash or cancellation between commit and notification can lose a callback. Remote workers notify their own FlowFn instance. Listeners are awaited and should return promptly; listener exceptions are reported through `on_error` and do not undo committed work or replace its result. Workflow persisted history remains separate from this bounded local tracker.

### Trace propagation validation (2026-10-20)

Python 3.9 source and a fresh Python 3.12 installed wheel each pass 89 tests,
with 94 native-provider/environment cases explicitly skipped. The wheel run
imports FlowFn from `site-packages`, outside this checkout. Focused telemetry and
propagation checks pass 13 tests, with four native-provider cases skipped. They
cover producer-to-consumer queue/stream context, persisted workflow context,
unrelated worker spans, missing/malformed/zero identifiers, and baggage exclusion.
At that checkpoint, strict mypy 1.18.2 on Python 3.9 passed all 47 source files. Older mypy 1.14
reported an unchanged PostgreSQL Optional-narrowing diagnostic; running the
Python 3.9 target against Python 3.12's newer Pydantic instead hit dependency
syntax incompatibility. These tool configurations are not the passing gate.

The Docker sockets for both available contexts were unavailable, so this
checkpoint does not establish native Redis/PostgreSQL propagation. Original
provider, partition, persisted policy, throughput/latency, and deployment
requirements remain separate readiness gates.

### Reproducible type checks

The dev extra pins mypy to the 1.18 series, which supports the declared Python
3.9 floor, and includes the optional monitoring library's type stubs. Mypy uses
the interpreter version of the environment being checked, so dependencies
resolved for Python 3.12 are not parsed as Python 3.9 source. Check both runtimes
from `flowfn/python`:

```sh
uv run --isolated --no-project --python 3.9 --with '.[dev,redis,postgres]' mypy flowfn
uv run --isolated --no-project --python 3.12 --with '.[dev,redis,postgres]' mypy flowfn
```

Both pass all 47 source files. The Redis adapter explicitly selects decoded
RESP2 responses, validates stream entry shapes, and uses a typed asynchronous
command boundary for Lua rather than depending on version-specific sync/async
overloads. Redis dependency versions remain unconstrained beyond the existing
supported minimum; this does not claim every intervening version was tested.

### Disposable native-provider acceptance

Run `node flowfn/typescript/scripts/provider-acceptance.mjs --python` from the
repository root with Docker and uv installed. It creates loopback-only Redis and
PostgreSQL containers, runs the complete Python source suite with declared native
extras, and removes/verifies its own containers. Set `FLOWFN_PYTHON_VERSION=3.9`
to test the minimum Python version (default: 3.12). This is source acceptance,
not an installed-wheel or hosted deployment claim.

A durable stream acknowledgment after its subscription loses ownership raises
`RuntimeError("Stream delivery ownership changed")`; it does not release pending
retention. A replacement consumer may reclaim and acknowledge that entry.

### Relative queue delays and storage clocks

`Queue.add(..., JobOptions(delay=...))` and automatic backoff retries measure the
chosen delay from the Redis/PostgreSQL storage clock at admission. Retry backoff
is passed separately from the job's original `delay`, so a different retry
interval is not confused with the initial delay. Fractional custom backoff is
rounded up to the next millisecond. Dependency-aware transactions follow the same
rule. Claims record `processed_on` from storage; worker duration metrics compare
worker-local start/end times instead of mixing the two clocks.

The relative-duration intent is private, used once, and not serialized into job
payloads. Existing stored schedules and legacy migration retain their absolute
due times. Direct adapter callers that supply `Job.available_at` keep the
existing absolute-schedule semantics; omitting it starts a relative `Job.delay`
from storage time. Explicitly re-enqueue old incorrectly scheduled work rather
than expecting this release to rewrite its due time. Memory/custom adapters keep
their existing local-clock behavior.

PostgreSQL automatically installs versioned enqueue/claim/update functions within
its existing initialization transaction. Older function signatures remain
available; table layout and stored payload fields are unchanged. New Redis
scripts preserve JSON payloads and add the duration as a separate script argument.
These changes do not fix jumps in the storage server's own clock or establish
completion/retention timestamps as storage-authoritative.

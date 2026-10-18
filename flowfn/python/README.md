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

The memory adapter retains a separate pending queue for each consumer group. Each message goes to one member of each group. With `auto_commit=False`, call `await message.ack()` to release its in-flight slot. `await message.nack(requeue=True)` schedules another delivery; `requeue=False` discards that delivery. Disconnecting a member returns its unacknowledged work to the group. A new group with `from_beginning=True` starts from the retained history; reconnecting an existing group continues its pending work. Memory state is process-local and does not survive process termination. Handlers should tolerate redelivery.

`await stream.get_message_count()`, replay and trimming read the adapter's retained stream state, including messages published by another instance. A zero `max_length` removes all retained history; pending group deliveries remain available for acknowledgement.

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

Redis 6.2 or newer is required. Independent clients share queue transitions, dependency outcomes, dead letters, workflow snapshots, and stream consumer groups. Namespace keys isolate applications. Queue mutations use Redis optimistic transactions; queue state currently occupies one JSON snapshot per namespace, so queue size and concurrent-writer scalability require workload-specific validation. Persistence across Redis server restarts depends on Redis persistence configuration.

Consumer groups use pending-message recovery with lease heartbeats and ownership-checked acknowledgements. Closing a consumer leaves its unacknowledged deliveries recoverable after `reclaim_after_ms` (default 30 seconds). Handlers must tolerate redelivery after failures or network partitions. Trimming preserves entries still unread or pending in any group, so requested retention bounds may be exceeded until groups acknowledge those messages. Plain subscriptions deliver publications after registration without durable group state.

Active queue jobs receive renewable leases; abandoned jobs become eligible for another claim after lease expiry, and stale completion writes are rejected. Queue handlers receive asyncio cancellation when renewal reports lost ownership or exceeds the conservative local lease deadline, including a hung renewal request. Cancellation is cooperative: handlers that suppress it or perform blocking external work can still continue side effects, so handlers must remain idempotent. Lease loss does not consume the retry budget or write stale completion/DLQ state. Custom adapters provide `lease_loss_event(queue, job)` and `release_job_lease(queue, job)` to expose and clean up their claim monitor (unleased adapters return `None`). Workflow snapshots persist, but hosts must restore workflow definitions and resume orchestration. Scalable queue storage remains a readiness gate.

Custom Redis backoff functions must be supplied on every producer and worker adapter as `backoff_strategies={job_name: callback}`. Only serializable options are stored; each worker restores the callable by job name before claiming work. Missing registration fails without claiming the job.


## PostgreSQL adapter

Install `flowfn[postgres]` and construct `PostgresAdapter(url, namespace='my-app')` from `flowfn.adapters.postgres`. Pass it to `create_flow` just like the Redis adapter. The adapter installs namespaced `flowfn_py_*` tables and indexes on first use; the database role needs schema-creation permissions. It uses row-locked queue snapshots, persisted workflow snapshots and event rows, and leased consumer-group deliveries. Stream operations serialize publication and cursor transitions to avoid skipping concurrently committed messages. Acknowledgement waits for the durable deletion of the pending delivery.

Both durable adapters share queue dependency, deduplication, retention, DLQ, backoff restoration and lease rules. They use the storage server clock for queue lease ownership. Queue state is currently a snapshot per namespace; contention and large-queue performance remain validation/implementation gates. PostgreSQL data survives client restarts; database persistence, backups and failover are deployment responsibilities. Consumer-group trimming preserves unread and pending deliveries just as Redis does.

For real local integration tests, point `FLOWFN_REDIS_URL` and `FLOWFN_POSTGRES_URL` at disposable services and run `pytest tests/test_durable_adapters.py`. Tests create unique namespaces and delete their records on teardown. Without those variables, integration cases are explicitly skipped.

Workflow execution discovery reads the adapter's persisted states, so a fresh workflow instance can list executions created by another instance. Lookup/cancellation rejects executions belonging to a different workflow name. Custom adapters must implement `list_workflow_states(workflow_id)` alongside save/load. Listing persisted snapshots does not automatically resume their handlers.

Workflow event history is persisted inside execution snapshots, including compensation failures, and metrics use persisted executions. History survives reconstruction of the workflow object. Event histories and execution snapshots currently have no automatic retention policy; applications with unbounded workflow volume need a retention mechanism before production deployment.


## Workflow ownership and restart recovery

Use `.version('v1')` on the workflow builder and increment it whenever handler semantics change. A structural fingerprint also checks step names/types, parallel layout, delays and nested branches. `await workflow.resume_execution(execution_id)` claims an abandoned running execution after its lease expires; it rejects a different version/structure, an active owner, or a terminal execution. `.lease(milliseconds)` configures renewal/expiry (default 30 seconds). Lease clocks and atomic transitions belong to the storage adapter.

Completed sequential and parallel child steps are checkpointed by path. Branch decisions, delay deadlines, context and pending saga compensation paths are persisted. Recovery skips completed paths and resumes an interrupted compensation phase. Handlers and compensators must be idempotent: a crash between an external side effect and its checkpoint may cause that operation to repeat. Checkpoints cannot make external services transactional. Old owners cannot overwrite a takeover or cancellation. Remote cancellation invalidates ownership; its worker stops when renewal observes the cancellation. Closing FlowFn explicitly cancels its running workflows; a process crash leaves them eligible for recovery.

Custom adapters must implement atomic `transition_workflow_state` create/save/claim/renew/release/cancel/schedule-control operations in addition to snapshot storage and listing. See the shared transition implementation for ownership/version invariants. Recovery requires the application to register the matching handler definitions; Python functions are not serialized into storage.

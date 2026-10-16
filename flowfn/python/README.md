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

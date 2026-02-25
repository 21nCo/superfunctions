# CiFn Python SDK

Typed HTTP client for the [CiFn](https://github.com/21nCo/super-functions) control plane API. Use it to trigger runs, list runs, fetch logs and artifacts, and register runners from Python.

## Installation

```bash
pip install cifn
```

Requires Python 3.10+. Dependencies: `pydantic>=2.5.0`, `httpx>=0.27.0`.

## Quick start

### Async usage

```python
import asyncio
from cifn import create_cifn, CiFnConfig, TriggerInput, TriggerType
from cifn.types import OnPush, OnTriggers, PipelineSpec, JobSpec, RunStep

async def main():
    config = CiFnConfig(base_url="http://localhost:3100", api_key="your-api-key")
    client = create_cifn(config)

    async with client:
        # Create a run
        result = await client.create_run(
            trigger=TriggerInput(type=TriggerType.PUSH),
            pipeline_spec=PipelineSpec(
                on=OnTriggers(push=OnPush(branches=["main"])),
                jobs={"build": JobSpec(runs_on="default", steps=[RunStep(run="npm ci")])},
            ),
        )
        print(result.run_id, result.status)

        # List runs
        runs_result = await client.list_runs(limit=10)
        for run in runs_result.runs:
            print(run.id, run.status)

        # Get a run
        run = await client.get_run(result.run_id)
        print(run.jobs)

asyncio.run(main())
```

### Sync usage

If you're not in an async context, use the sync wrappers. They work even when an event loop is already running (e.g. in Jupyter).

```python
from cifn import create_cifn, CiFnConfig

config = CiFnConfig(base_url="http://localhost:3100", api_key="your-api-key")
client = create_cifn(config)

# Sync wrappers
runs = client.list_runs_sync(limit=5)
run = client.get_run_sync("run-abc-123")
ok = client.health_sync()

client.close()
```

## Configuration

```python
from cifn import CiFnConfig

config = CiFnConfig(
    base_url="http://localhost:3100",  # default
    api_key="your-api-key",           # or token=...
    timeout=30.0,
    verify_ssl=True,
)
```

- **base_url**: CiFn control plane URL.
- **api_key** / **token**: Sent as `Authorization: Bearer <value>` on all requests except `/health`. Either can be used; if both are set, `api_key` wins.
- **timeout**: Per-request timeout in seconds.
- **verify_ssl**: Set to `False` only for development (e.g. self-signed certs).

Credentials are never logged; `repr(config)` redacts them.

## Error handling

The client raises typed exceptions for API errors:

```python
from cifn import create_cifn, CiFnConfig
from cifn.errors import CiFnRunNotFoundError, CiFnPipelineInvalidError

client = create_cifn(CiFnConfig())

try:
    run = client.get_run_sync("nonexistent")
except CiFnRunNotFoundError as e:
    print(e.code, e.message, e.http_status)
except CiFnPipelineInvalidError as e:
    print("Invalid pipeline:", e.details)
```

Common exception types: `CiFnBadRequestError`, `CiFnUnauthorizedError`, `CiFnRunNotFoundError`, `CiFnRunAlreadyFinishedError`, `CiFnPipelineInvalidError`, `CiFnConnectionError` (network/transport), and others. All inherit from `CiFnError` and expose `code`, `message`, `details`, and `http_status`.

## API reference summary

| Method | Description |
|--------|-------------|
| `create_run(trigger, pipeline_spec=None, pipeline_ref=None)` | POST /api/v1/runs |
| `list_runs(limit=20, cursor=None, status=None)` | GET /api/v1/runs |
| `get_run(run_id)` | GET /api/v1/runs/:runId |
| `cancel_run(run_id)` | POST /api/v1/runs/:runId/cancel |
| `get_job_logs(run_id, job_key)` | GET /api/v1/runs/:runId/jobs/:jobKey/logs |
| `get_artifacts(run_id)` | GET /api/v1/runs/:runId/artifacts |
| `register_runner(token, labels=None)` | POST /api/v1/runners/register |
| `runner_heartbeat(runner_id, runner_secret)` | POST /api/v1/runners/heartbeat |
| `health()` | GET /health (returns bool) |

Sync versions: `create_run_sync`, `list_runs_sync`, `get_run_sync`, etc.

For full types and envelope behavior, see the [CiFn Python SDK spec](../../.conduct/specs/) in the repository.

## Development

```bash
pip install -e ".[dev]"
pytest tests/ -v --cov=cifn
ruff check cifn/
black --check cifn/
mypy cifn/
```

## License

MIT.

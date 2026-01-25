# PlugFn Python SDK

> Self-hosted integration platform for Python applications

Native Python SDK with async/await support for building integrations with 75+ APIs.

## Installation

```bash
pip install plugfn
```

## Quick Start

```python
import asyncio
from plugfn import PlugFn
from plugfn.providers import github_provider

async def main():
    plug = PlugFn(
        database=adapter,
        auth=auth_provider,
        base_url="https://myapp.com",
        encryption_key="your-32-character-key-here!!!!",
        integrations={
            "github": {
                "client_id": "your-client-id",
                "client_secret": "your-client-secret",
                "scopes": ["repo", "issues", "user"]
            }
        }
    )
    
    plug.providers.register(github_provider)
    
    # Execute an action
    issue = await plug.github.issues.create(
        user_id="user-123",
        params={
            "owner": "myorg",
            "repo": "myrepo",
            "title": "Bug report",
            "body": "Something is broken"
        }
    )
    
    print(f"Created issue #{issue['number']}")

if __name__ == "__main__":
    asyncio.run(main())
```

## Features

- ✅ **Type hints**: Full Python type hints
- ✅ **Async/await**: Native async support
- ✅ **OAuth built-in**: Complete OAuth 2.0 flow
- ✅ **Webhooks**: Real-time event handling with FastAPI/Flask
- ✅ **Workflows**: Chain actions together
- ✅ **Pydantic models**: Data validation with Pydantic
- ✅ **Testing utilities**: Mock providers and pytest fixtures

## Coming Soon

The Python SDK is under active development. Current status:
- 🚧 Core architecture (in progress)
- 📋 Provider implementations (planned)
- 📋 HTTP adapters (FastAPI, Flask) (planned)
- 📋 CLI tool integration (planned)

## Planned API

### Basic Usage

```python
from plugfn import PlugFn, Config
from plugfn.providers import GitHubProvider, SlackProvider

# Configure
config = Config(
    base_url="https://myapp.com",
    encryption_key="your-key",
    integrations={
        "github": {"client_id": "...", "client_secret": "..."},
        "slack": {"client_id": "...", "client_secret": "..."}
    }
)

plug = PlugFn(config)
plug.providers.register(GitHubProvider())
plug.providers.register(SlackProvider())
```

### Webhooks

```python
from fastapi import FastAPI
from plugfn.adapters.fastapi import mount_plugfn

app = FastAPI()
mount_plugfn(app, plug, prefix="/api/plugfn")

@plug.webhooks.on("github", "issues.opened")
async def handle_issue(event):
    await plug.slack.chat.post_message(
        user_id=event.user_id,
        params={
            "channel": "#engineering",
            "text": f"New issue: {event.data.issue.title}"
        }
    )
```

### Workflows

```python
from plugfn import Workflow

workflow = (
    Workflow("github-to-linear")
    .trigger(plug.github.on("issues.opened"))
    .action(lambda ctx: plug.linear.issues.create(
        user_id=ctx.user_id,
        params={
            "team_id": "team-123",
            "title": ctx.trigger.issue.title,
            "description": ctx.trigger.issue.body
        }
    ))
    .action(lambda ctx: plug.slack.chat.post_message(
        user_id="system",
        params={
            "channel": "#synced",
            "text": f"Synced issue to Linear: {ctx.data.linear_issue.url}"
        }
    ))
    .enable()
)
```

## Development

```bash
# Install dependencies
pip install -e ".[dev]"

# Run tests
pytest

# Type checking
mypy plugfn

# Linting
ruff check plugfn
```

## Architecture

```
python/
├── plugfn/
│   ├── __init__.py
│   ├── core/
│   │   ├── plug_fn.py
│   │   ├── connection_manager.py
│   │   ├── action_executor.py
│   │   └── workflow_engine.py
│   ├── auth/
│   │   ├── oauth.py
│   │   ├── api_key.py
│   │   └── jwt.py
│   ├── providers/
│   │   ├── github.py
│   │   ├── slack.py
│   │   ├── discord.py
│   │   ├── linear.py
│   │   └── stripe.py
│   ├── storage/
│   │   ├── connection_storage.py
│   │   ├── workflow_storage.py
│   │   └── adapters/
│   ├── middleware/
│   │   ├── retry.py
│   │   ├── rate_limiter.py
│   │   ├── cache.py
│   │   └── logging.py
│   ├── webhooks/
│   │   └── webhook_handler.py
│   ├── adapters/
│   │   ├── fastapi.py
│   │   └── flask.py
│   ├── testing/
│   │   ├── mock_provider.py
│   │   └── fixtures.py
│   └── types.py
├── tests/
├── examples/
└── docs/
```

## Contributing

See [CONTRIBUTING.md](../CONTRIBUTING.md) for guidelines.

## License

Apache-2.0


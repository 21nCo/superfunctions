# PlugFn Python SDK - Implementation Guide

This document describes the implementation of the PlugFn Python SDK.

## Overview

The Python SDK is a feature-complete implementation of PlugFn that mirrors the TypeScript SDK's API while following Python conventions and best practices.

## Architecture

```
plugfn/
├── __init__.py              # Main exports
├── types.py                 # Type definitions using Pydantic
├── core/                    # Core functionality
│   ├── plug_fn.py          # Main PlugFn class
│   ├── connection_manager.py
│   ├── provider_registry.py
│   ├── action_executor.py
│   └── workflow_engine.py
├── auth/                    # Authentication
│   ├── oauth_flow.py       # OAuth 2.0 flow handler
│   └── token_store.py      # Temporary token storage
├── storage/                 # Storage layer
│   ├── connection_storage.py
│   ├── workflow_storage.py
│   └── token_storage.py    # Secure encryption
├── http/                    # HTTP client
│   └── http_client.py      # Async HTTP with auth
├── webhooks/               # Webhook handling
│   └── webhook_handler.py
├── providers/              # Provider implementations
│   ├── github.py
│   └── slack.py
├── adapters/               # Framework adapters
│   ├── fastapi.py
│   └── flask.py
└── utils/                  # Utilities
    └── logger.py
```

## Key Components

### 1. PlugFn Core (`core/plug_fn.py`)

Main SDK entry point that orchestrates all components:

- **PlugFnConfig**: Configuration class for initialization
- **PlugFn**: Main SDK class with dynamic provider access
- **ProviderProxy**: Dynamic proxy for executing provider actions
- **ConnectionsAPI**: API for managing OAuth connections
- **WorkflowsAPI**: API for managing workflows
- **WebhooksAPI**: API for handling webhooks
- **ProvidersAPI**: API for managing providers

### 2. Connection Manager (`core/connection_manager.py`)

Handles OAuth flows and connection management:

- `get_auth_url()`: Generate OAuth authorization URL
- `handle_callback()`: Process OAuth callback and create connection
- `list_connections()`: List user connections
- `get_connection()`: Get connection by ID
- `disconnect()`: Delete a connection
- `refresh_connection()`: Refresh OAuth tokens
- `get_credentials()`: Get decrypted credentials

### 3. Provider Registry (`core/provider_registry.py`)

Manages available providers:

- `register_provider()`: Register a new provider
- `get_provider()`: Get provider by name
- `list_providers()`: List all providers
- `mark_configured()`: Mark provider as configured
- `is_configured()`: Check if provider is configured

### 4. Action Executor (`core/action_executor.py`)

Executes provider actions with middleware:

- `execute()`: Execute a single action with retry logic
- `batch()`: Execute multiple actions in parallel
- `get_metrics()`: Get execution metrics

Features:
- Automatic retry with exponential backoff
- Rate limiting (configurable)
- Caching (configurable)
- Action logging for metrics

### 5. Workflow Engine (`core/workflow_engine.py`)

Manages workflow definitions and execution:

- `create_workflow()`: Create new workflow
- `list_workflows()`: List workflows
- `enable_workflow()`: Enable a workflow
- `disable_workflow()`: Disable a workflow
- `execute_workflow()`: Execute workflow steps
- `get_workflow_stats()`: Get execution statistics

### 6. OAuth Flow Handler (`auth/oauth_flow.py`)

Handles OAuth 2.0 authorization flows:

- `get_authorization_url()`: Generate authorization URL
- `exchange_code_for_token()`: Exchange code for tokens
- `refresh_token()`: Refresh access token

### 7. HTTP Client (`http/http_client.py`)

Async HTTP client with authentication:

- Supports OAuth2, API Key, Basic Auth, JWT
- Automatic header injection
- Methods: `get()`, `post()`, `put()`, `patch()`, `delete()`

### 8. Webhook Handler (`webhooks/webhook_handler.py`)

Processes incoming webhooks:

- `register_handler()`: Register event handler
- `handle_webhook()`: Process incoming webhook
- `_verify_signature()`: Verify webhook signatures (GitHub, Slack)

### 9. Storage Layer

#### ConnectionStorage (`storage/connection_storage.py`)
Wraps database adapter for connection operations.

#### WorkflowStorage (`storage/workflow_storage.py`)
Wraps database adapter for workflow operations.

#### SecureTokenStorage (`storage/token_storage.py`)
Encrypts/decrypts credentials using Fernet symmetric encryption.

## Type System

All types are defined using Pydantic models in `types.py`:

- **AuthType**: Enum for authentication types
- **ConnectionStatus**: Enum for connection states
- **WorkflowStatus**: Enum for workflow states
- **Connection**: User connection model
- **Workflow**: Workflow definition model
- **Provider**: Provider definition model
- **DatabaseAdapter**: Protocol for database adapters
- **AuthProvider**: Protocol for auth providers

## Provider Implementation

Providers are defined as Python objects with:

1. **Metadata**: name, display_name, description, version, etc.
2. **Auth Config**: OAuth URLs, scopes, etc.
3. **Actions**: Executable functions with Pydantic validation
4. **Triggers**: Webhook event definitions

Example provider structure:

```python
github_provider = Provider(
    name="github",
    display_name="GitHub",
    version="1.0.0",
    description="GitHub API integration",
    base_url="https://api.github.com",
    auth_type=AuthType.OAUTH2,
)

github_provider.auth_config = {
    "authorization_url": "https://github.com/login/oauth/authorize",
    "token_url": "https://github.com/login/oauth/access_token",
    "scopes": ["repo", "user"],
}

github_provider.actions = {
    "issues.create": GitHubIssuesCreateAction(),
    "repos.get": GitHubReposGetAction(),
}
```

## Framework Adapters

### FastAPI Adapter (`adapters/fastapi.py`)

Provides endpoints for:
- OAuth authorization
- OAuth callback
- Connection management
- Webhook handling
- Provider listing

Usage:
```python
from fastapi import FastAPI
from plugfn.adapters.fastapi import mount_plugfn_fastapi

app = FastAPI()
mount_plugfn_fastapi(app, plug, prefix="/api/plugfn")
```

### Flask Adapter (`adapters/flask.py`)

Same endpoints as FastAPI, adapted for Flask with sync wrapper.

## Dependencies

Core dependencies:
- `httpx`: Async HTTP client
- `pydantic`: Data validation
- `cryptography`: Token encryption
- `python-jose`: JWT support (optional)

Optional dependencies:
- `fastapi`: For FastAPI adapter
- `flask`: For Flask adapter
- `pytest`: For testing
- `pytest-asyncio`: For async tests

## Usage Examples

### Basic Usage

```python
from plugfn import PlugFn
from plugfn.providers import github_provider

plug = PlugFn(
    database=adapter,
    auth=auth_provider,
    base_url="https://myapp.com",
    encryption_key="your-32-char-key",
    integrations={
        "github": {
            "client_id": "...",
            "client_secret": "...",
        }
    }
)

plug.providers.register(github_provider)

# Execute action
issue = await plug.github.issues.create(
    user_id="user-123",
    params={
        "owner": "myorg",
        "repo": "myrepo",
        "title": "Bug report"
    }
)
```

### Webhook Handling

```python
@plug.webhooks.on("github", "issues.opened")
async def handle_issue(event):
    print(f"Issue opened: {event['issue']['title']}")
    return {"processed": True}
```

### FastAPI Integration

```python
from fastapi import FastAPI
from plugfn.adapters.fastapi import mount_plugfn_fastapi

app = FastAPI()
mount_plugfn_fastapi(app, plug, prefix="/api/plugfn")
```

## Testing

Tests use pytest with async support:

```bash
pytest tests/
```

Mock adapters are provided for testing without a real database.

## Future Enhancements

1. **Rate Limiting**: Implement per-provider rate limiting
2. **Caching**: Add Redis-backed caching layer
3. **More Providers**: Add more provider implementations
4. **Workflow Builder**: Visual workflow builder
5. **CLI Tool**: Command-line tool for managing connections
6. **Type Stubs**: Better IDE support with type stubs

## Comparison with TypeScript SDK

| Feature | TypeScript | Python | Notes |
|---------|-----------|--------|-------|
| Core API | ✅ | ✅ | Identical API surface |
| OAuth Flow | ✅ | ✅ | Full OAuth 2.0 support |
| Providers | ✅ | ✅ | GitHub, Slack implemented |
| Webhooks | ✅ | ✅ | Signature verification |
| Workflows | ✅ | ✅ | Basic implementation |
| Type Safety | ✅ | ✅ | Pydantic models |
| Async/Await | ✅ | ✅ | Native async support |
| Framework Adapters | ✅ | ✅ | FastAPI, Flask |
| Testing | ✅ | ✅ | pytest with fixtures |

## Contributing

See the main CONTRIBUTING.md for guidelines on adding new providers or features.

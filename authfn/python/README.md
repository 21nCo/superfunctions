# authfn Python SDK

> API key authentication library using Superfunctions abstractions for Python

Python implementation of authfn with async/await support for API key-based authentication.

## Overview

`authfn` is a reference implementation of authentication that provides API key-based authentication. It includes:

- **Auth Provider**: Async authentication and authorization
- **Database Storage**: Uses database adapters for storing API keys
- **Key Management**: Secure API key generation and validation
- **Type Safety**: Full type hints with Pydantic models

## Installation

```bash
pip install authfn
```

## Quick Start

### 1. Setup Database

You'll need a database adapter that implements the `DatabaseAdapter` protocol:

```python
from authfn.types import DatabaseAdapter, WhereClause, OrderByClause
from typing import Any, Dict, List, Optional


class MyDatabaseAdapter:
    """Your database adapter implementation."""
    
    async def find_one(
        self,
        model: str,
        where: List[WhereClause],
        namespace: str,
    ) -> Optional[Dict[str, Any]]:
        # Your implementation here
        pass
    
    async def find_many(
        self,
        model: str,
        where: List[WhereClause],
        order_by: Optional[List[OrderByClause]],
        namespace: str,
    ) -> List[Dict[str, Any]]:
        # Your implementation here
        pass
    
    async def create(
        self,
        model: str,
        data: Dict[str, Any],
        namespace: str,
    ) -> None:
        # Your implementation here
        pass
    
    async def update(
        self,
        model: str,
        where: List[WhereClause],
        data: Dict[str, Any],
        namespace: str,
    ) -> None:
        # Your implementation here
        pass
```

### 2. Create authfn Instance

```python
from authfn import create_authfn, AuthFnConfig

adapter = MyDatabaseAdapter()

auth = create_authfn(
    AuthFnConfig(
        database=adapter,
        namespace="authfn",
        enable_api=True,
        api_config={
            "admin_key": "your-admin-key",  # Optional: protect management API
        },
    )
)
```

### 3. Create API Keys

```python
from authfn.types import ApiKeyCreate

# Create a new API key
result = await auth.create_key(
    ApiKeyCreate(
        name="Production API Key",
        resourceIds=["resource-1", "resource-2"],
        scopes=["read", "write"],
        metadata={"environment": "production"},
    )
)

print(f"API Key ID: {result.id}")
print(f"API Key: {result.key}")  # Save this securely!
```

### 4. Authenticate Requests

```python
from authfn.types import Request

class MyRequest:
    """Your request wrapper."""
    
    def __init__(self, headers: Dict[str, str]):
        self._headers = headers
    
    @property
    def headers(self) -> Dict[str, str]:
        return self._headers


# Authenticate a request
request = MyRequest({"Authorization": "Bearer ak_..."})

try:
    session = await auth.provider.authenticate(request)
    if session:
        print(f"Authenticated as: {session.name}")
        print(f"Resource IDs: {session.resource_ids}")
        print(f"Scopes: {session.scopes}")
except Exception as e:
    print(f"Authentication failed: {e}")
```

### 5. Authorize Resource Access

```python
# Check if session has access to a resource
if session:
    has_access = await auth.provider.authorize(session, "resource-1")
    if has_access:
        print("Access granted to resource-1")
    else:
        print("Access denied to resource-1")
```

### 6. Manage API Keys

```python
# Get API key by ID
key = await auth.get_key("key_...")
if key:
    print(f"Key name: {key.name}")
    print(f"Created at: {key.created_at}")

# List all API keys
keys = await auth.list_keys()
for key in keys:
    print(f"- {key.name} ({key.id})")

# List keys for a specific resource
keys = await auth.list_keys(filters={"resourceId": "resource-1"})

# Revoke an API key
await auth.revoke_key("key_...")
```

## Complete Example

```python
import asyncio
from authfn import create_authfn, AuthFnConfig
from authfn.types import ApiKeyCreate


async def main():
    # Setup (you would use your actual database adapter)
    adapter = MyDatabaseAdapter()
    
    auth = create_authfn(
        AuthFnConfig(
            database=adapter,
            namespace="authfn",
        )
    )
    
    # Create an API key
    result = await auth.create_key(
        ApiKeyCreate(
            name="My App Key",
            resourceIds=["app-1", "app-2"],
            scopes=["read", "write"],
        )
    )
    
    print(f"Created API key: {result.key}")
    
    # Simulate authentication
    class SimpleRequest:
        def __init__(self, token: str):
            self._headers = {"Authorization": f"Bearer {token}"}
        
        @property
        def headers(self):
            return self._headers
    
    request = SimpleRequest(result.key)
    session = await auth.provider.authenticate(request)
    
    if session:
        print(f"Authenticated as: {session.name}")
        
        # Check authorization
        can_access = await auth.provider.authorize(session, "app-1")
        print(f"Can access app-1: {can_access}")


if __name__ == "__main__":
    asyncio.run(main())
```

## Schema Definition

Get the schema definition for creating database tables:

```python
from authfn.schema import get_schema

schema = get_schema({"namespace": "authfn"})
print(schema)
# {
#   "version": 1,
#   "schemas": [
#     {
#       "modelName": "apiKeys",
#       "fields": {...},
#       "indexes": [...]
#     }
#   ]
# }
```

## API Reference

### `create_authfn(config: AuthFnConfig) -> AuthFn`

Create an authfn instance.

### `AuthFn`

Main authfn class with the following methods:

- `provider: AuthFnProvider` - Auth provider for authentication
- `async create_key(data: ApiKeyCreate) -> ApiKeyResponse` - Create a new API key
- `async revoke_key(key_id: str) -> None` - Revoke an API key
- `async get_key(key_id: str) -> Optional[ApiKeySanitized]` - Get an API key by ID
- `async list_keys(filters: Optional[Dict]) -> List[ApiKeySanitized]` - List API keys

### `AuthFnProvider`

Auth provider with the following methods:

- `async authenticate(request: Request) -> Optional[ApiKeySession]` - Authenticate a request
- `async authorize(session: ApiKeySession, resource_id: str) -> bool` - Authorize resource access
- `async revoke(session_id: str) -> None` - Revoke a session

## Type Safety

The SDK uses Pydantic models for full type safety:

```python
from authfn.types import (
    ApiKey,
    ApiKeyCreate,
    ApiKeyResponse,
    ApiKeySanitized,
    ApiKeySession,
    AuthFnConfig,
)
```

## Error Handling

```python
from authfn.types import (
    InvalidCredentialsError,
    ExpiredCredentialsError,
    UnauthorizedError,
    NotFoundError,
)

try:
    session = await auth.provider.authenticate(request)
except InvalidCredentialsError:
    print("Invalid API key")
except ExpiredCredentialsError:
    print("API key has expired")
```

## Development

```bash
# Install dependencies
pip install -e ".[dev]"

# Run tests
pytest

# Type checking
mypy authfn

# Linting
ruff check authfn

# Format code
black authfn
```

## License

MIT

## Repository

https://github.com/21nCo/super-functions

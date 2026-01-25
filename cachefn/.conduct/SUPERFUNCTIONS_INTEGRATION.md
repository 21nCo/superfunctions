# CacheFn Integration with SuperFunctions Ecosystem

This document describes how CacheFn integrates with the superfunctions ecosystem and uses core superfunctions packages.

## Overview

CacheFn follows the established patterns from other superfunctions Python SDKs (authfn, plugfn, secfn) and is designed to integrate seamlessly with the superfunctions ecosystem.

## Core Superfunctions Package Usage

### Current Usage

CacheFn V0.1.0 is self-contained and doesn't require `superfunctions` core packages for basic functionality. This follows the principle of minimal dependencies while maintaining compatibility.

### Future Integration (V0.2+)

#### With `superfunctions.db`

Future versions will integrate with the database adapter system:

```python
from superfunctions.db import create_adapter
from superfunctions_sqlalchemy import SQLAlchemyAdapter
from cachefn import cache_fn

# Create database adapter
db_adapter = SQLAlchemyAdapter(database_url="postgresql://...")

# Create cache with database storage
cache = cache_fn(
    name="persistent-cache",
    storage="db",
    db_adapter=db_adapter,
    namespace="cachefn"
)
```

#### With `superfunctions.http`

Framework middleware will use HTTP abstractions:

```python
from superfunctions.http import Request, Response
from cachefn.middleware import create_middleware

# Framework-agnostic middleware
middleware = create_middleware(cache, adapter)
```

## Pattern Consistency

CacheFn follows established superfunctions patterns:

### 1. Configuration with Pydantic

Like authfn and plugfn:

```python
from pydantic import BaseModel

class CacheFnConfig(BaseModel):
    name: str
    storage: StorageType = "memory"
    max_size: Optional[int] = None
    # ...
```

### 2. Factory Function Pattern

Similar to other SDKs:

```python
# authfn pattern
auth = create_authfn(AuthFnConfig(...))

# plugfn pattern
plug = PlugFn(PlugFnConfig(...))

# cachefn pattern
cache = cache_fn(name="cache", storage="memory")
```

### 3. Async/Await First

Consistent with modern Python superfunctions:

```python
# All operations are async
await cache.set(key, value)
await cache.get(key)
```

### 4. Type Safety

Strong typing throughout:

```python
from typing import Optional, Any
from cachefn.core.types import CacheStats

stats: CacheStats = await cache.get_stats()
```

### 5. Event-Driven Architecture

Similar to other SDKs:

```python
cache.on("hit", lambda event: handle_hit(event))
cache.on("miss", lambda event: handle_miss(event))
```

## Integration Examples

### With AuthFn

Cache authentication sessions:

```python
from authfn import create_authfn, AuthFnConfig
from cachefn import cache_fn

# Setup
auth = create_authfn(AuthFnConfig(...))
session_cache = cache_fn(name="sessions", default_ttl=3600000)

# Cache session validation
@memoize(ttl=300000, tags=["auth"])
async def validate_session(session_id: str):
    return await auth.provider.authenticate(session_id)

# Invalidate on logout
async def logout(session_id: str):
    await auth.provider.revoke(session_id)
    await session_cache.invalidate_by_tag("auth")
```

### With PlugFn

Cache integration responses:

```python
from plugfn import PlugFn, PlugFnConfig
from cachefn import memoize

plug = PlugFn(PlugFnConfig(...))

# Cache GitHub API responses
@memoize(ttl=300000, tags=["github"])
async def get_github_repo(user_id: str, repo: str):
    return await plug.github.repos.get(
        user_id=user_id,
        params={"repo": repo}
    )

# Invalidate on webhook
async def handle_github_webhook(event):
    if event.type == "repository.updated":
        await get_github_repo.cache.invalidate_by_tag("github")
```

### With SecFn

Cache with encryption:

```python
from secfn import SecFn
from cachefn import cache_fn

sec = SecFn(...)
cache = cache_fn(name="secure-cache")

# Encrypt cached values
async def set_secure(key: str, value: Any):
    encrypted = await sec.encrypt(value)
    await cache.set(key, encrypted)

async def get_secure(key: str):
    encrypted = await cache.get(key)
    if encrypted:
        return await sec.decrypt(encrypted)
```

## Package Structure Alignment

CacheFn follows the established superfunctions package structure:

```
superfunctions/
├── packages/
│   ├── python-core/          # superfunctions
│   ├── python-sqlalchemy/    # superfunctions-sqlalchemy
│   └── python-fastapi/       # superfunctions-fastapi
│
├── authfn/python/           # authfn package
├── plugfn/python/           # plugfn package
├── secfn/python/            # secfn package
└── cachefn/python/          # cachefn package ← NEW
```

## Namespace Conventions

CacheFn supports namespacing similar to other superfunctions:

```python
# AuthFn namespace
auth = create_authfn(AuthFnConfig(namespace="authfn"))

# CacheFn namespace
cache = cache_fn(name="cache", namespace="cachefn")

# Both can use the same underlying storage
# without key collisions
```

## Error Handling Patterns

Consistent error handling:

```python
from cachefn.core.types import CacheFnError

try:
    await cache.set("key", value)
except CacheFnError as e:
    # Handle cache-specific errors
    pass
```

## Testing Patterns

Similar testing approaches:

```python
import pytest
from cachefn import cache_fn

@pytest.fixture
def cache():
    return cache_fn(name="test-cache")

@pytest.mark.asyncio
async def test_cache_operations(cache):
    await cache.set("key", "value")
    assert await cache.get("key") == "value"
```

## Future SuperFunctions Integrations

### Database Adapter (V0.2)

```python
from superfunctions.db import Adapter
from cachefn.storage import DatabaseStorage

class CacheFnDatabaseStorage(DatabaseStorage):
    def __init__(self, adapter: Adapter):
        self.adapter = adapter
        # Use superfunctions db abstractions
```

### HTTP Middleware (V0.2)

```python
from superfunctions.http import Request, Response, Middleware
from cachefn.middleware import CacheFnMiddleware

class CacheFnHTTPMiddleware(Middleware):
    async def process_request(self, request: Request) -> Response:
        # Use superfunctions HTTP abstractions
        ...
```

### Distributed Coordination (V1)

```python
from superfunctions.messaging import PubSub
from cachefn.distributed import DistributedCache

cache = DistributedCache(
    pubsub=superfunctions_pubsub,
    coordination=superfunctions_coordination
)
```

## Design Principles

CacheFn follows superfunctions design principles:

1. **Self-contained but compatible** - Works standalone but integrates seamlessly
2. **Protocol-based** - Uses protocols for extensibility
3. **Type-safe** - Full type hints and Pydantic models
4. **Async-first** - Modern async/await patterns
5. **Observable** - Events and statistics for monitoring
6. **Testable** - Easy to mock and test
7. **Well-documented** - Comprehensive docs and examples

## Contributing to Ecosystem

When extending CacheFn:

1. Follow superfunctions patterns from authfn/plugfn/secfn
2. Use Pydantic for configuration and types
3. Implement protocol-based abstractions
4. Maintain async/await patterns
5. Add comprehensive tests
6. Document integrations

## Version Compatibility

| CacheFn | SuperFunctions Core | Notes |
|---------|-------------------|-------|
| 0.1.0 | Optional | Self-contained |
| 0.2.0 (planned) | >=0.1.0 | Database adapters |
| 1.0.0 (planned) | >=0.2.0 | Full integration |

## Resources

- **SuperFunctions Core**: `packages/python-core/`
- **AuthFn**: `authfn/python/`
- **PlugFn**: `plugfn/python/`
- **SecFn**: `secfn/python/`
- **Package Guidelines**: `packages/.conduct/PYTHON_PACKAGES.md`

## Questions?

See the main [superfunctions repository](https://github.com/21nCo/super-functions) for:
- Architecture documentation
- Integration guidelines
- Contributing guide
- Community discussions

# secfn Python SDK

> Comprehensive self-hosted security platform for Python developers

Python implementation of secfn providing secrets management, access control, rate limiting, security monitoring, and secret scanning.

## Overview

`secfn` is a comprehensive security toolkit that provides:

- **Secrets Vault**: Encrypted secret storage with AES-256-GCM, rotation, and access logging
- **Access Control (RBAC)**: Role-based permissions with wildcard matching and caching
- **Rate Limiting**: Token bucket algorithm with per-user, per-IP, and per-endpoint limits
- **Security Monitoring**: Event logging, metrics, and anomaly detection
- **Secret Scanning**: Detect hardcoded secrets in code with pattern matching

## Installation

```bash
pip install secfn
```

## Quick Start

### 1. Create SecFn Instance

```python
from secfn import create_secfn, SecFnConfig

secfn = create_secfn(
    SecFnConfig(
        master_key="your-secure-master-key",
        storage_path=".secfn",
    )
)
```

### 2. Secrets Vault

```python
# Create vault
vault = secfn.create_secrets_vault()

# Store a secret
await vault.set("stripe_api_key", "sk_live_...", options={
    "tags": ["payment", "production"],
    "environment": "production",
    "rotateEvery": 90 * 24 * 60 * 60 * 1000,  # 90 days
})

# Retrieve secret
api_key = await vault.get("stripe_api_key")

# List secrets (without values)
secrets = await vault.list(filter={"environment": "production"})

# Rotate secret
await vault.rotate("stripe_api_key", "sk_live_new...")

# Get access log
log = await vault.get_access_log("stripe_api_key", limit=100)
```

### 3. Access Control (RBAC)

```python
# Create access control
access = secfn.create_access_control()

# Create roles
admin_role_id = await access.create_role(
    name="admin",
    permissions=["*:*"],
    description="Full system access"
)

editor_role_id = await access.create_role(
    name="editor",
    permissions=["project:read", "project:write", "file:read", "file:write"],
    description="Can edit projects and files"
)

# Assign role to user
await access.assign_role(
    user_id="user_123",
    role_id=editor_role_id,
    resource_ids=["project_abc", "project_def"]
)

# Check permission
from secfn import AccessRequest

allowed = await access.check(AccessRequest(
    userId="user_123",
    action="project:write",
    resourceId="project_abc"
))

if allowed:
    print("Access granted!")
```

### 4. Rate Limiting

```python
from secfn import RateLimitRule

# Create rate limiter
limiter = secfn.create_rate_limiter(
    rules={
        "global": RateLimitRule(requests=1000, window=60000),
        "perUser": RateLimitRule(requests=100, window=60000),
        "perIP": RateLimitRule(
            requests=50,
            window=60000,
            blockDuration=300000  # Block for 5 minutes
        ),
    }
)

# Check rate limit
try:
    result = await limiter.check(
        user_id="user_123",
        ip="192.168.1.1",
        endpoint="/api/search"
    )
    print(f"Allowed! Remaining: {result.remaining}")
except RateLimitExceededError as e:
    print(f"Rate limit exceeded: {e}")
```

### 5. Security Monitoring

```python
from secfn import SecurityEventType, Severity

# Create monitor
monitor = secfn.create_monitoring()

# Log security event
event_id = await monitor.log_event(
    type=SecurityEventType.AUTH_FAILURE,
    severity=Severity.MEDIUM,
    ip="192.168.1.1",
    user_id="user_123",
    resource="/api/login",
    metadata={"reason": "invalid_password"}
)

# Query events
from secfn import EventQuery

events = await monitor.query_events(EventQuery(
    type=SecurityEventType.AUTH_FAILURE,
    severity=[Severity.HIGH, Severity.CRITICAL],
    startDate=int(time.time() * 1000) - 24 * 60 * 60 * 1000,
))

# Get metrics
import time
metrics = await monitor.get_metrics(
    start=int(time.time() * 1000) - 7 * 24 * 60 * 60 * 1000,
    end=int(time.time() * 1000)
)
print(f"Total events: {metrics.total_events}")
print(f"Events by type: {metrics.events_by_type}")
```

### 6. Secret Scanning

```python
# Create scanner
scanner = secfn.create_secret_scanner(
    exclude_paths=["node_modules/**", "*.test.py"]
)

# Scan a file
results = await scanner.scan_file("./config.py")
for result in results:
    print(f"Found {result.pattern} at {result.file}:{result.line}")
    print(f"  Severity: {result.severity}")
    print(f"  Match: {result.redacted_match}")

# Scan directory
results = await scanner.scan_directory("./src", recursive=True)
critical = [r for r in results if r.severity == Severity.CRITICAL]
print(f"Found {len(critical)} critical secrets!")
```

## Complete Example

```python
import asyncio
from secfn import create_secfn, SecFnConfig, Severity, SecurityEventType

async def main():
    # Initialize secfn
    secfn = create_secfn(SecFnConfig(
        master_key="my-secure-master-key",
        storage_path=".secfn"
    ))

    # Create modules
    vault = secfn.create_secrets_vault()
    access = secfn.create_access_control()
    monitor = secfn.create_monitoring()

    # Store a secret
    await vault.set("database_url", "postgresql://user:pass@localhost/db")

    # Create admin role
    admin_role = await access.create_role(
        name="admin",
        permissions=["*:*"],
        description="Administrator"
    )

    # Assign role
    await access.assign_role("user_1", admin_role)

    # Log an event
    await monitor.log_event(
        type=SecurityEventType.SECRET_ACCESSED,
        severity=Severity.INFO,
        ip="127.0.0.1",
        user_id="user_1",
        resource="database_url"
    )

    print("✓ Secrets vault, access control, and monitoring configured!")

if __name__ == "__main__":
    asyncio.run(main())
```

## API Reference

### `create_secfn(config: SecFnConfig) -> SecFn`

Create a SecFn instance.

### `SecFn`

Main class with factory methods:

- `create_secrets_vault()` - Create encrypted secrets vault
- `create_access_control()` - Create RBAC access control
- `create_rate_limiter(rules)` - Create rate limiter
- `create_monitoring()` - Create security monitor
- `create_secret_scanner()` - Create secret scanner

### `SecretsVault`

- `async set(key, value, options)` - Store encrypted secret
- `async get(key, user_id)` - Retrieve secret
- `async list(filter)` - List secrets (without values)
- `async rotate(key, new_value, user_id)` - Rotate secret
- `async delete(key, user_id)` - Delete secret
- `async get_access_log(key, limit)` - Get access log

### `AccessControl`

- `async create_role(name, permissions, description)` - Create role
- `async assign_role(user_id, role_id, resource_ids)` - Assign role
- `async check(request)` - Check permission
- `async get_user_permissions(user_id)` - Get user permissions
- `async get_user_roles(user_id)` - Get user roles

### `RateLimiter`

- `async check(user_id, ip, endpoint)` - Check rate limit

### `SecurityMonitor`

- `async log_event(type, severity, ip, ...)` - Log event
- `async query_events(query)` - Query events
- `async get_metrics(start, end)` - Get metrics
- `async resolve_event(event_id, resolved_by, notes)` - Resolve event

### `SecretScanner`

- `async scan_file(file_path)` - Scan file
- `async scan_directory(directory, recursive)` - Scan directory

## Development

```bash
# Install dependencies
make install-dev

# Run tests
make test

# Type checking
make typecheck

# Linting
make lint

# Format code
make format
```

## License

MIT

## Repository

https://github.com/21nCo/super-functions

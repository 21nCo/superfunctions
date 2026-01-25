"""Basic usage example for secfn."""

import asyncio
import time

from secfn import (
    AccessRequest,
    RateLimitRule,
    SecFnConfig,
    SecurityEventType,
    Severity,
    SetSecretOptions,
    create_secfn,
)


async def main() -> None:
    """Demonstrate basic secfn usage."""
    print("=== SecFn Python SDK Example ===\n")

    # Initialize secfn
    print("1. Initializing SecFn...")
    secfn = create_secfn(
        SecFnConfig(master_key="example-master-key-change-in-production", storage_path=".secfn-example")
    )

    # === Secrets Vault ===
    print("\n2. Creating Secrets Vault...")
    vault = secfn.create_secrets_vault()

    # Store secrets
    print("   - Storing secrets...")
    await vault.set(
        "database_url",
        "postgresql://user:password@localhost:5432/mydb",
        SetSecretOptions(
            tags=["database", "production"],
            environment="production",
            createdBy="admin",
        ),
    )

    await vault.set(
        "api_key",
        "sk_live_1234567890abcdef",
        SetSecretOptions(tags=["api", "stripe"], createdBy="admin"),
    )

    # Retrieve secret
    db_url = await vault.get("database_url", user_id="admin")
    print(f"   ✓ Retrieved database_url: {db_url[:20]}...")

    # List secrets
    secrets = await vault.list()
    print(f"   ✓ Total secrets stored: {len(secrets)}")

    # === Access Control ===
    print("\n3. Setting up Access Control...")
    access = secfn.create_access_control()

    # Create roles
    admin_role = await access.create_role(
        name="admin", permissions=["*:*"], description="Full system access"
    )

    editor_role = await access.create_role(
        name="editor",
        permissions=["project:read", "project:write", "file:read", "file:write"],
        description="Can edit projects and files",
    )

    viewer_role = await access.create_role(
        name="viewer", permissions=["project:read", "file:read"], description="Read-only access"
    )

    print(f"   ✓ Created 3 roles: admin, editor, viewer")

    # Assign roles
    await access.assign_role("user_alice", admin_role)
    await access.assign_role("user_bob", editor_role, resource_ids=["project_1", "project_2"])
    await access.assign_role("user_charlie", viewer_role)

    # Check permissions
    alice_can_delete = await access.check(
        AccessRequest(userId="user_alice", action="project:delete", resourceId="project_1")
    )

    bob_can_write = await access.check(
        AccessRequest(userId="user_bob", action="project:write", resourceId="project_1")
    )

    charlie_can_write = await access.check(
        AccessRequest(userId="user_charlie", action="project:write", resourceId="project_1")
    )

    print(f"   ✓ Alice can delete: {alice_can_delete}")
    print(f"   ✓ Bob can write to project_1: {bob_can_write}")
    print(f"   ✓ Charlie can write: {charlie_can_write}")

    # === Rate Limiting ===
    print("\n4. Configuring Rate Limiting...")
    limiter = secfn.create_rate_limiter(
        rules={
            "global": RateLimitRule(requests=1000, window=60000),
            "perUser": RateLimitRule(requests=100, window=60000),
            "perIP": RateLimitRule(requests=50, window=60000, blockDuration=300000),
        }
    )

    # Check rate limits
    try:
        result = await limiter.check(user_id="user_alice", ip="192.168.1.1", endpoint="/api/data")
        print(f"   ✓ Rate limit check passed. Remaining: {result.remaining}")
    except Exception as e:
        print(f"   ✗ Rate limit exceeded: {e}")

    # === Security Monitoring ===
    print("\n5. Setting up Security Monitoring...")
    monitor = secfn.create_monitoring()

    # Log events
    await monitor.log_event(
        type=SecurityEventType.SECRET_ACCESSED,
        severity=Severity.INFO,
        ip="192.168.1.1",
        user_id="admin",
        resource="database_url",
        action="read",
        metadata={"method": "vault.get"},
    )

    await monitor.log_event(
        type=SecurityEventType.PERMISSION_DENIED,
        severity=Severity.MEDIUM,
        ip="192.168.1.100",
        user_id="user_charlie",
        resource="project_1",
        action="write",
        metadata={"reason": "insufficient_permissions"},
    )

    print("   ✓ Logged 2 security events")

    # Get metrics
    now = int(time.time() * 1000)
    metrics = await monitor.get_metrics(start=now - 24 * 60 * 60 * 1000, end=now)

    print(f"   ✓ Total events in last 24h: {metrics.total_events}")
    print(f"   ✓ Events by type: {metrics.events_by_type}")

    # === Secret Scanning ===
    print("\n6. Secret Scanning...")
    scanner = secfn.create_secret_scanner(exclude_paths=["node_modules/**", ".git/**"])

    # Create a test file with a secret
    test_file = ".secfn-example/test_code.py"
    import os

    os.makedirs(os.path.dirname(test_file), exist_ok=True)
    with open(test_file, "w") as f:
        f.write('api_key = "sk_live_abcdef123456789012345678"\n')
        f.write('db_url = "postgresql://admin:secret123@localhost/db"\n')

    results = await scanner.scan_file(test_file)
    print(f"   ✓ Scanned test file, found {len(results)} potential secrets")
    for result in results:
        print(f"     - {result.pattern} at line {result.line}: {result.redacted_match}")

    print("\n=== Example Complete ===")
    print("\nAll secfn modules are working correctly!")
    print("Data stored in: .secfn-example/")


if __name__ == "__main__":
    asyncio.run(main())

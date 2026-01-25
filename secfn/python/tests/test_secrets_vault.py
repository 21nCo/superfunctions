"""Tests for SecretsVault class."""

import pytest

from secfn.secrets import SecretsVault, SecretsVaultConfig
from secfn.types import SecretNotFoundError, SetSecretOptions


@pytest.mark.asyncio
async def test_set_and_get_secret(file_storage, master_key):
    """Test setting and getting a secret."""
    config = SecretsVaultConfig(storage=file_storage, master_key=master_key)
    vault = SecretsVault(config)

    # Set secret
    secret_id = await vault.set("test_key", "test_value")
    assert secret_id is not None

    # Get secret
    value = await vault.get("test_key")
    assert value == "test_value"


@pytest.mark.asyncio
async def test_set_secret_with_options(file_storage, master_key):
    """Test setting secret with options."""
    config = SecretsVaultConfig(storage=file_storage, master_key=master_key)
    vault = SecretsVault(config)

    options = SetSecretOptions(
        tags=["production", "api"], environment="production", createdBy="admin"
    )

    secret_id = await vault.set("api_key", "secret_value", options)
    assert secret_id is not None

    # Verify secret was stored
    value = await vault.get("api_key")
    assert value == "secret_value"


@pytest.mark.asyncio
async def test_list_secrets(file_storage, master_key):
    """Test listing secrets."""
    config = SecretsVaultConfig(storage=file_storage, master_key=master_key)
    vault = SecretsVault(config)

    # Create multiple secrets
    await vault.set("secret1", "value1")
    await vault.set("secret2", "value2")

    # List all secrets
    secrets = await vault.list()
    assert len(secrets) == 2
    assert all("value" not in str(s) for s in secrets)  # Values should not be included


@pytest.mark.asyncio
async def test_rotate_secret(file_storage, master_key):
    """Test rotating a secret."""
    config = SecretsVaultConfig(storage=file_storage, master_key=master_key)
    vault = SecretsVault(config)

    # Create secret
    await vault.set("rotate_test", "old_value")

    # Rotate
    await vault.rotate("rotate_test", "new_value")

    # Verify new value
    value = await vault.get("rotate_test")
    assert value == "new_value"


@pytest.mark.asyncio
async def test_delete_secret(file_storage, master_key):
    """Test deleting a secret."""
    config = SecretsVaultConfig(storage=file_storage, master_key=master_key)
    vault = SecretsVault(config)

    # Create secret
    await vault.set("delete_test", "value")

    # Delete
    await vault.delete("delete_test")

    # Verify deleted
    value = await vault.get("delete_test")
    assert value is None


@pytest.mark.asyncio
async def test_get_nonexistent_secret(file_storage, master_key):
    """Test getting a nonexistent secret."""
    config = SecretsVaultConfig(storage=file_storage, master_key=master_key)
    vault = SecretsVault(config)

    value = await vault.get("nonexistent")
    assert value is None


@pytest.mark.asyncio
async def test_access_logging(file_storage, master_key):
    """Test access logging."""
    config = SecretsVaultConfig(storage=file_storage, master_key=master_key)
    vault = SecretsVault(config)

    # Create and access secret
    await vault.set("logged_secret", "value", SetSecretOptions(createdBy="admin"))
    await vault.get("logged_secret", user_id="user1")
    await vault.get("logged_secret", user_id="user2")

    # Get access log
    log = await vault.get_access_log("logged_secret")
    assert len(log) >= 3  # write + 2 reads
    assert any(entry.action == "write" for entry in log)
    assert any(entry.action == "read" for entry in log)

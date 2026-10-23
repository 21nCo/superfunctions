"""Tests for AccessControl class."""

import pytest

from secfn.access_control import AccessControl, AccessControlConfig
from secfn.types import AccessRequest


@pytest.mark.asyncio
async def test_create_role(file_storage):
    """Test creating a role."""
    config = AccessControlConfig(storage=file_storage)
    access = AccessControl(config)

    role_id = await access.create_role(
        name="admin", permissions=["*:*"], description="Full access"
    )

    assert role_id is not None


@pytest.mark.asyncio
async def test_assign_and_check_permission(file_storage):
    """Test assigning role and checking permission."""
    config = AccessControlConfig(storage=file_storage)
    access = AccessControl(config)

    # Create role
    role_id = await access.create_role(
        name="editor", permissions=["project:read", "project:write"], description="Editor"
    )

    # Assign role
    await access.assign_role("user1", role_id)

    # Check permission
    allowed = await access.check(AccessRequest(userId="user1", action="project:write"))
    assert allowed is True

    # Check denied permission
    denied = await access.check(AccessRequest(userId="user1", action="project:delete"))
    assert denied is False


@pytest.mark.asyncio
async def test_wildcard_permissions(file_storage):
    """Test wildcard permissions."""
    config = AccessControlConfig(storage=file_storage)
    access = AccessControl(config)

    # Create admin role with wildcard
    role_id = await access.create_role(name="admin", permissions=["*:*"], description="Admin")

    await access.assign_role("admin_user", role_id)

    # Should allow any action
    assert await access.check(AccessRequest(userId="admin_user", action="project:delete"))
    assert await access.check(AccessRequest(userId="admin_user", action="file:write"))
    assert await access.check(AccessRequest(userId="admin_user", action="anything:anything"))


@pytest.mark.asyncio
async def test_resource_scoped_permissions(file_storage):
    """Test resource-scoped permissions."""
    config = AccessControlConfig(storage=file_storage)
    access = AccessControl(config)

    role_id = await access.create_role(
        name="editor", permissions=["project:write"], description="Editor"
    )

    # Assign role with resource scope
    await access.assign_role("user1", role_id, resource_ids=["project1", "project2"])

    # Should allow for scoped resources
    assert await access.check(
        AccessRequest(userId="user1", action="project:write", resourceId="project1")
    )

    # Should deny for non-scoped resources
    assert not await access.check(
        AccessRequest(userId="user1", action="project:write", resourceId="project3")
    )


@pytest.mark.asyncio
async def test_get_user_permissions(file_storage):
    """Test getting user permissions."""
    config = AccessControlConfig(storage=file_storage)
    access = AccessControl(config)

    role_id = await access.create_role(
        name="viewer", permissions=["project:read", "file:read"], description="Viewer"
    )

    await access.assign_role("user1", role_id)

    permissions = await access.get_user_permissions("user1")
    assert "project:read" in permissions
    assert "file:read" in permissions

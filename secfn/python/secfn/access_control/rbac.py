"""Role-Based Access Control (RBAC) implementation."""

import time
from typing import Dict, List, Optional

from ..storage.file_storage import FileStorage
from ..types import AccessDeniedError, AccessRequest, Role, UserRole
from ..utils.helpers import generate_id, is_expired


class AccessControlConfig:
    """Configuration for access control."""

    def __init__(
        self,
        storage: FileStorage,
        cache_ttl: int = 300000,  # 5 minutes
        cache_max_size: int = 1000,
    ):
        """Initialize access control config.
        
        Args:
            storage: Storage backend
            cache_ttl: Cache TTL in milliseconds
            cache_max_size: Maximum cache size
        """
        self.storage = storage
        self.cache_ttl = cache_ttl
        self.cache_max_size = cache_max_size


class AccessControl:
    """Role-based access control with permission checking."""

    def __init__(self, config: AccessControlConfig):
        """Initialize access control.
        
        Args:
            config: Access control configuration
        """
        self.storage = config.storage
        self.cache_ttl = config.cache_ttl
        self.cache_max_size = config.cache_max_size
        self._cache: Dict[str, tuple[bool, int]] = {}

    async def create_role(
        self,
        name: str,
        permissions: List[str],
        description: str = "",
        inherits: Optional[List[str]] = None,
    ) -> str:
        """Create a new role.
        
        Args:
            name: Role name
            permissions: List of permissions (e.g., ['resource:action'])
            description: Role description
            inherits: List of role IDs to inherit from
            
        Returns:
            Role ID
        """
        now = int(time.time() * 1000)

        role = Role(
            id=generate_id("role"),
            name=name,
            description=description,
            permissions=permissions,
            inherits=inherits,
            createdAt=now,
            updatedAt=now,
        )

        await self.storage.save_role(role)
        return role.id

    async def assign_role(
        self,
        user_id: str,
        role_id: str,
        resource_ids: Optional[List[str]] = None,
        expires_at: Optional[int] = None,
    ) -> None:
        """Assign a role to a user.
        
        Args:
            user_id: User ID
            role_id: Role ID
            resource_ids: Optional list of resource IDs to scope the role to
            expires_at: Optional expiration timestamp
        """
        user_role = UserRole(
            userId=user_id,
            roleId=role_id,
            resourceIds=resource_ids,
            expiresAt=expires_at,
            assignedAt=int(time.time() * 1000),
        )

        await self.storage.save_user_role(user_role)
        # Clear cache for this user
        self._clear_user_cache(user_id)

    async def check(self, request: AccessRequest) -> bool:
        """Check if user has permission.
        
        Args:
            request: Access request with user_id, action, resource_id, context
            
        Returns:
            True if allowed, False otherwise
        """
        # Check cache first
        cache_key = f"{request.user_id}:{request.action}:{request.resource_id or ''}"
        if cache_key in self._cache:
            result, timestamp = self._cache[cache_key]
            if int(time.time() * 1000) - timestamp < self.cache_ttl:
                return result

        # Get user roles
        user_roles = await self.storage.get_user_roles(request.user_id)

        # Check each role
        for user_role in user_roles:
            # Check if role assignment expired
            if is_expired(user_role.expires_at):
                continue

            # Check if resource is in scope
            if user_role.resource_ids and request.resource_id:
                if request.resource_id not in user_role.resource_ids:
                    continue

            # Get role permissions
            role = await self.storage.get_role(user_role.role_id)
            if not role:
                continue

            # Check permissions
            if self._matches_permission(role.permissions, request.action):
                # Cache result
                self._cache_result(cache_key, True)
                return True

        # Cache negative result
        self._cache_result(cache_key, False)
        return False

    async def get_user_permissions(self, user_id: str) -> List[str]:
        """Get all permissions for a user.
        
        Args:
            user_id: User ID
            
        Returns:
            List of permission strings
        """
        user_roles = await self.storage.get_user_roles(user_id)
        permissions = set()

        for user_role in user_roles:
            if is_expired(user_role.expires_at):
                continue

            role = await self.storage.get_role(user_role.role_id)
            if role:
                permissions.update(role.permissions)

        return list(permissions)

    async def get_user_roles(self, user_id: str) -> List[Role]:
        """Get all roles for a user.
        
        Args:
            user_id: User ID
            
        Returns:
            List of roles
        """
        user_roles = await self.storage.get_user_roles(user_id)
        roles = []

        for user_role in user_roles:
            if is_expired(user_role.expires_at):
                continue

            role = await self.storage.get_role(user_role.role_id)
            if role:
                roles.append(role)

        return roles

    def _matches_permission(self, permissions: List[str], action: str) -> bool:
        """Check if action matches any permission.
        
        Args:
            permissions: List of permission strings
            action: Action to check (e.g., 'resource:read')
            
        Returns:
            True if matches
        """
        for permission in permissions:
            # Handle wildcard permissions
            if permission == "*:*":
                return True

            perm_parts = permission.split(":")
            action_parts = action.split(":")

            if len(perm_parts) != 2 or len(action_parts) != 2:
                continue

            perm_resource, perm_action = perm_parts
            action_resource, action_action = action_parts

            # Check resource match
            resource_match = perm_resource == "*" or perm_resource == action_resource

            # Check action match
            action_match = perm_action == "*" or perm_action == action_action

            if resource_match and action_match:
                return True

        return False

    def _cache_result(self, key: str, result: bool) -> None:
        """Cache a permission check result.
        
        Args:
            key: Cache key
            result: Permission check result
        """
        # Simple cache eviction if too large
        if len(self._cache) >= self.cache_max_size:
            # Remove oldest entries (first 10%)
            to_remove = len(self._cache) // 10
            for k in list(self._cache.keys())[:to_remove]:
                del self._cache[k]

        self._cache[key] = (result, int(time.time() * 1000))

    def _clear_user_cache(self, user_id: str) -> None:
        """Clear cache entries for a user.
        
        Args:
            user_id: User ID
        """
        keys_to_remove = [k for k in self._cache.keys() if k.startswith(f"{user_id}:")]
        for key in keys_to_remove:
            del self._cache[key]

"""File-based storage for secfn data."""

import json
import os
from pathlib import Path
from typing import Any, Dict, List, Optional

from ..types import Secret, SecretAccess, SecurityEvent, Role, UserRole, RateLimitEntry


class FileStorage:
    """Simple file-based JSON storage for secfn data."""

    def __init__(self, base_path: str = ".secfn"):
        """Initialize file storage.
        
        Args:
            base_path: Base directory for storage files
        """
        self.base_path = Path(base_path)
        self.base_path.mkdir(parents=True, exist_ok=True)

    def _get_collection_path(self, collection: str) -> Path:
        """Get path for a collection file.
        
        Args:
            collection: Collection name
            
        Returns:
            Path to collection JSON file
        """
        return self.base_path / f"{collection}.json"

    def _load_collection(self, collection: str) -> Dict[str, Any]:
        """Load collection from file.
        
        Args:
            collection: Collection name
            
        Returns:
            Dictionary of items keyed by ID
        """
        path = self._get_collection_path(collection)
        if not path.exists():
            return {}

        with open(path, "r") as f:
            return json.load(f)

    def _save_collection(self, collection: str, data: Dict[str, Any]) -> None:
        """Save collection to file.
        
        Args:
            collection: Collection name
            data: Dictionary of items to save
        """
        path = self._get_collection_path(collection)
        # Write to temp file first, then rename for atomicity
        temp_path = path.with_suffix(".tmp")
        with open(temp_path, "w") as f:
            json.dump(data, f, indent=2)
        temp_path.replace(path)

    async def save(self, collection: str, id: str, data: Dict[str, Any]) -> None:
        """Save an item to a collection.
        
        Args:
            collection: Collection name
            id: Item ID
            data: Item data
        """
        items = self._load_collection(collection)
        items[id] = data
        self._save_collection(collection, items)

    async def get(self, collection: str, id: str) -> Optional[Dict[str, Any]]:
        """Get an item from a collection.
        
        Args:
            collection: Collection name
            id: Item ID
            
        Returns:
            Item data or None if not found
        """
        items = self._load_collection(collection)
        return items.get(id)

    async def find(
        self, collection: str, query: Optional[Dict[str, Any]] = None
    ) -> List[Dict[str, Any]]:
        """Find items in a collection matching query.
        
        Args:
            collection: Collection name
            query: Query dict (simple key-value matching)
            
        Returns:
            List of matching items
        """
        items = self._load_collection(collection)
        results = list(items.values())

        if query:
            filtered = []
            for item in results:
                match = True
                for key, value in query.items():
                    if key not in item or item[key] != value:
                        match = False
                        break
                if match:
                    filtered.append(item)
            results = filtered

        return results

    async def delete(self, collection: str, id: str) -> None:
        """Delete an item from a collection.
        
        Args:
            collection: Collection name
            id: Item ID
        """
        items = self._load_collection(collection)
        if id in items:
            del items[id]
            self._save_collection(collection, items)

    # Convenience methods for specific collections
    async def save_secret(self, secret: Secret) -> None:
        """Save a secret."""
        await self.save("secrets", secret.id, secret.model_dump(by_alias=True))

    async def get_secret_by_key(self, key: str) -> Optional[Secret]:
        """Get secret by key."""
        secrets = await self.find("secrets", {"key": key})
        if secrets:
            return Secret(**secrets[0])
        return None

    async def list_secrets(
        self, filter: Optional[Dict[str, Any]] = None
    ) -> List[Secret]:
        """List all secrets with optional filter."""
        query = {}
        if filter:
            if "environment" in filter:
                query["environment"] = filter["environment"]
        secrets_data = await self.find("secrets", query)
        return [Secret(**s) for s in secrets_data]

    async def delete_secret(self, secret_id: str) -> None:
        """Delete a secret."""
        await self.delete("secrets", secret_id)

    async def log_secret_access(self, access: SecretAccess) -> None:
        """Log secret access."""
        await self.save("secret_access", access.id, access.model_dump(by_alias=True))

    async def get_secret_access_log(
        self, secret_id: str, limit: int = 100
    ) -> List[SecretAccess]:
        """Get access log for a secret."""
        all_access = await self.find("secret_access", {"secretId": secret_id})
        # Sort by timestamp descending
        all_access.sort(key=lambda x: x.get("timestamp", 0), reverse=True)
        return [SecretAccess(**a) for a in all_access[:limit]]

    async def save_event(self, event: SecurityEvent) -> None:
        """Save a security event."""
        await self.save("events", event.id, event.model_dump(by_alias=True))

    async def query_events(
        self, query: Optional[Dict[str, Any]] = None
    ) -> List[SecurityEvent]:
        """Query security events."""
        events_data = await self.find("events", query)
        return [SecurityEvent(**e) for e in events_data]

    async def save_role(self, role: Role) -> None:
        """Save a role."""
        await self.save("roles", role.id, role.model_dump(by_alias=True))

    async def get_role(self, role_id: str) -> Optional[Role]:
        """Get a role by ID."""
        role_data = await self.get("roles", role_id)
        if role_data:
            return Role(**role_data)
        return None

    async def save_user_role(self, user_role: UserRole) -> None:
        """Save a user role assignment."""
        key = f"{user_role.user_id}:{user_role.role_id}"
        await self.save("user_roles", key, user_role.model_dump(by_alias=True))

    async def get_user_roles(self, user_id: str) -> List[UserRole]:
        """Get all roles for a user."""
        all_roles = await self.find("user_roles")
        user_roles = [r for r in all_roles if r.get("userId") == user_id]
        return [UserRole(**r) for r in user_roles]

    async def save_rate_limit_entry(self, entry: RateLimitEntry) -> None:
        """Save a rate limit entry."""
        await self.save("rate_limits", entry.key, entry.model_dump(by_alias=True))

    async def get_rate_limit_entry(self, key: str) -> Optional[RateLimitEntry]:
        """Get a rate limit entry."""
        entry_data = await self.get("rate_limits", key)
        if entry_data:
            return RateLimitEntry(**entry_data)
        return None

"""Main authfn implementation."""

import secrets
import time
from datetime import datetime
from typing import Any, Dict, List, Optional

from superfunctions.db import Adapter as DatabaseAdapter, OrderBy, WhereClause
from .types import (
    ApiKey,
    ApiKeyCreate,
    ApiKeyResponse,
    ApiKeySanitized,
    ApiKeySession,
    AuthFnConfig,
    ExpiredCredentialsError,
    InvalidCredentialsError,
    NotFoundError,
    Request,
)


def generate_api_key(prefix: str = "ak") -> str:
    """Generate a secure API key."""
    random_bytes = secrets.token_bytes(32)
    key = random_bytes.hex()
    return f"{prefix}_{key}"


def generate_id(prefix: str) -> str:
    """Generate unique ID."""
    timestamp = format(int(time.time() * 1000), "x")
    random_str = secrets.token_hex(5)[:7]
    return f"{prefix}_{timestamp}{random_str}"


class AuthFnProvider:
    """Auth provider implementation for authfn."""

    def __init__(self, database: DatabaseAdapter, namespace: str = "authfn"):
        self.database = database
        self.namespace = namespace

    async def authenticate(self, request: Request) -> Optional[ApiKeySession]:
        """Authenticate a request and return session."""
        auth_header = request.headers.get("authorization") or request.headers.get("Authorization")

        if not auth_header:
            return None

        # Extract token from Bearer scheme
        token = auth_header
        if token.lower().startswith("bearer "):
            token = token[7:].strip()

        if not token:
            return None

        # Look up API key in database
        api_key_data = await self.database.find_one(
            model="apiKeys",
            where=[WhereClause(field="key", operator="eq", value=token)],
            namespace=self.namespace,
        )

        if not api_key_data:
            raise InvalidCredentialsError("Invalid API key")

        # Convert to ApiKey model
        api_key = ApiKey(**api_key_data)

        # Check if revoked
        if api_key.revoked_at:
            raise InvalidCredentialsError("API key has been revoked")

        # Check if expired
        if api_key.expires_at:
            if api_key.expires_at < datetime.utcnow():
                raise ExpiredCredentialsError("API key has expired")

        # Update last used timestamp
        await self.database.update(
            model="apiKeys",
            where=[WhereClause(field="id", operator="eq", value=api_key.id)],
            data={"lastUsedAt": datetime.utcnow().isoformat()},
            namespace=self.namespace,
        )

        return ApiKeySession(
            id=api_key.id,
            type="api-key",
            keyId=api_key.id,
            name=api_key.name,
            resourceIds=api_key.resource_ids,
            scopes=api_key.scopes,
            expiresAt=api_key.expires_at,
            metadata=api_key.metadata,
        )

    async def authorize(self, session: ApiKeySession, resource_id: str) -> bool:
        """Authorize a session to access a resource."""
        return resource_id in session.resource_ids

    async def revoke(self, session_id: str) -> None:
        """Revoke a session."""
        await self.database.update(
            model="apiKeys",
            where=[WhereClause(field="id", operator="eq", value=session_id)],
            data={"revokedAt": datetime.utcnow().isoformat()},
            namespace=self.namespace,
        )


class AuthFn:
    """AuthFn instance with provider and key management."""

    def __init__(self, config: AuthFnConfig):
        """Initialize AuthFn instance."""
        self.config = config
        self.database = config.database
        self.namespace = config.namespace
        self._provider = AuthFnProvider(self.database, self.namespace)

    @property
    def provider(self) -> AuthFnProvider:
        """Get the auth provider."""
        return self._provider

    async def create_key(self, data: ApiKeyCreate) -> ApiKeyResponse:
        """Create a new API key."""
        key_id = generate_id("key")
        key = generate_api_key("ak")

        key_data = {
            "id": key_id,
            "key": key,
            "name": data.name,
            "resourceIds": data.resource_ids,
            "scopes": data.scopes,
            "metadata": data.metadata,
            "expiresAt": data.expires_at.isoformat() if data.expires_at else None,
            "lastUsedAt": None,
            "revokedAt": None,
            "createdAt": datetime.utcnow().isoformat(),
        }

        await self.database.create(
            model="apiKeys",
            data=key_data,
            namespace=self.namespace,
        )

        return ApiKeyResponse(id=key_id, key=key)

    async def revoke_key(self, key_id: str) -> None:
        """Revoke an API key."""
        await self.database.update(
            model="apiKeys",
            where=[WhereClause(field="id", operator="eq", value=key_id)],
            data={"revokedAt": datetime.utcnow().isoformat()},
            namespace=self.namespace,
        )

    async def get_key(self, key_id: str) -> Optional[ApiKeySanitized]:
        """Get API key by ID (without the secret key)."""
        key_data = await self.database.find_one(
            model="apiKeys",
            where=[WhereClause(field="id", operator="eq", value=key_id)],
            namespace=self.namespace,
        )

        if not key_data:
            return None

        # Remove the secret key field
        key_data_copy = key_data.copy()
        key_data_copy.pop("key", None)

        return ApiKeySanitized(**key_data_copy)

    async def list_keys(
        self, filters: Optional[Dict[str, Any]] = None
    ) -> List[ApiKeySanitized]:
        """List API keys (without the secret keys)."""
        where: List[WhereClause] = []

        if filters and filters.get("resourceId"):
            where.append(
                WhereClause(field="resourceIds", operator="contains", value=filters["resourceId"])
            )

        keys_data = await self.database.find_many(
            model="apiKeys",
            where=where,
            order_by=[OrderBy(field="createdAt", direction="desc")],
            namespace=self.namespace,
        )

        # Sanitize results by removing the secret key field
        sanitized_keys = []
        for key_data in keys_data:
            key_data_copy = key_data.copy()
            key_data_copy.pop("key", None)
            sanitized_keys.append(ApiKeySanitized(**key_data_copy))

        return sanitized_keys


def create_authfn(config: AuthFnConfig) -> AuthFn:
    """Create authfn instance."""
    return AuthFn(config)

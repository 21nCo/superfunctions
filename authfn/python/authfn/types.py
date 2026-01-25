"""Core type definitions for authfn Python SDK."""

from datetime import datetime
from typing import Any, Dict, List, Optional
from pydantic import BaseModel, Field

from superfunctions.db import Adapter as DatabaseAdapter


class ApiKeySession(BaseModel):
    """API key session extends base auth session."""

    id: str
    type: str = "api-key"
    key_id: str = Field(alias="keyId")
    name: str
    resource_ids: List[str] = Field(alias="resourceIds")
    scopes: Optional[List[str]] = None
    expires_at: Optional[datetime] = Field(None, alias="expiresAt")
    metadata: Optional[Dict[str, Any]] = None

    class Config:
        populate_by_name = True


class ApiKey(BaseModel):
    """API key data stored in database."""

    id: str
    key: str
    name: str
    resource_ids: List[str] = Field(alias="resourceIds")
    scopes: Optional[List[str]] = None
    metadata: Optional[Dict[str, Any]] = None
    expires_at: Optional[datetime] = Field(None, alias="expiresAt")
    last_used_at: Optional[datetime] = Field(None, alias="lastUsedAt")
    revoked_at: Optional[datetime] = Field(None, alias="revokedAt")
    created_at: datetime = Field(alias="createdAt")

    class Config:
        populate_by_name = True


class ApiKeyCreate(BaseModel):
    """Data for creating a new API key."""

    name: str
    resource_ids: List[str] = Field(alias="resourceIds")
    scopes: Optional[List[str]] = None
    metadata: Optional[Dict[str, Any]] = None
    expires_at: Optional[datetime] = Field(None, alias="expiresAt")

    class Config:
        populate_by_name = True


class ApiKeyResponse(BaseModel):
    """Response when creating an API key."""

    id: str
    key: str


class ApiKeySanitized(BaseModel):
    """API key without the secret key field."""

    id: str
    name: str
    resource_ids: List[str] = Field(alias="resourceIds")
    scopes: Optional[List[str]] = None
    metadata: Optional[Dict[str, Any]] = None
    expires_at: Optional[datetime] = Field(None, alias="expiresAt")
    last_used_at: Optional[datetime] = Field(None, alias="lastUsedAt")
    revoked_at: Optional[datetime] = Field(None, alias="revokedAt")
    created_at: datetime = Field(alias="createdAt")

    class Config:
        populate_by_name = True


class AuthFnConfig(BaseModel):
    """Configuration for authfn."""

    database: Any  # Database adapter
    namespace: str = "authfn"
    enable_api: bool = Field(False, alias="enableApi")
    api_config: Optional[Dict[str, Any]] = Field(None, alias="apiConfig")

    class Config:
        populate_by_name = True
        arbitrary_types_allowed = True


# Database adapter is now from superfunctions.db


class Request(Protocol):
    """Protocol for HTTP requests."""

    @property
    def headers(self) -> Dict[str, str]:
        """Request headers."""
        ...


class AuthProvider(Protocol):
    """Protocol for auth providers."""

    async def authenticate(self, request: Request) -> Optional[ApiKeySession]:
        """Authenticate a request and return session."""
        ...

    async def authorize(self, session: ApiKeySession, resource_id: str) -> bool:
        """Authorize a session to access a resource."""
        ...

    async def revoke(self, session_id: str) -> None:
        """Revoke a session."""
        ...


# Exceptions
class AuthFnError(Exception):
    """Base exception for authfn."""

    pass


class InvalidCredentialsError(AuthFnError):
    """Invalid credentials error."""

    pass


class ExpiredCredentialsError(AuthFnError):
    """Expired credentials error."""

    pass


class UnauthorizedError(AuthFnError):
    """Unauthorized error."""

    pass


class NotFoundError(AuthFnError):
    """Not found error."""

    pass

"""
authfn - API key authentication library using Superfunctions abstractions for Python.

Example usage:
    >>> from authfn import create_authfn, AuthFnConfig
    >>> from authfn.types import ApiKeyCreate
    >>>
    >>> auth = create_authfn(
    ...     AuthFnConfig(
    ...         database=adapter,
    ...         namespace="authfn",
    ...     )
    ... )
    >>> result = await auth.create_key(
    ...     ApiKeyCreate(
    ...         name="My App Key",
    ...         resourceIds=["app-1"],
    ...         scopes=["read", "write"],
    ...     )
    ... )
    >>> session = await auth.provider.authenticate(request)
"""

__version__ = "0.0.1"
__author__ = "21n"
__license__ = "MIT"

from .authfn import AuthFn, AuthFnProvider, create_authfn
from .schema import get_schema
from .types import (
    ApiKey,
    ApiKeyCreate,
    ApiKeyResponse,
    ApiKeySanitized,
    ApiKeySession,
    AuthFnConfig,
    AuthFnError,
    ExpiredCredentialsError,
    InvalidCredentialsError,
    NotFoundError,
    UnauthorizedError,
)

__all__ = [
    "__version__",
    "__author__",
    "__license__",
    # Main classes
    "AuthFn",
    "AuthFnProvider",
    "create_authfn",
    # Configuration
    "AuthFnConfig",
    # Types
    "ApiKey",
    "ApiKeyCreate",
    "ApiKeyResponse",
    "ApiKeySanitized",
    "ApiKeySession",
    # Exceptions
    "AuthFnError",
    "InvalidCredentialsError",
    "ExpiredCredentialsError",
    "UnauthorizedError",
    "NotFoundError",
    # Schema
    "get_schema",
]

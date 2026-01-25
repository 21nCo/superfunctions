"""
secfn - Comprehensive self-hosted security platform for Python developers.

Example usage:
    >>> from secfn import create_secfn, SecFnConfig
    >>> 
    >>> secfn = create_secfn(
    ...     SecFnConfig(
    ...         master_key="your-master-key",
    ...         storage_path=".secfn",
    ...     )
    ... )
    >>> 
    >>> # Create a secrets vault
    >>> vault = secfn.create_secrets_vault()
    >>> await vault.set("api_key", "secret-value")
    >>> 
    >>> # Create access control
    >>> access = secfn.create_access_control()
    >>> await access.create_role("admin", ["*:*"], "Full access")
"""

__version__ = "0.1.0"
__author__ = "21n"
__license__ = "MIT"

from .access_control import AccessControl, AccessControlConfig
from .monitoring import MonitoringConfig, SecurityMonitor
from .rate_limiting import RateLimiter, RateLimiterConfig
from .scanning import DEFAULT_PATTERNS, SecretScanner, SecretScannerConfig
from .schema import get_schema
from .secfn import SecFn, SecFnConfig, create_secfn
from .secrets import SecretEncryption, SecretsVault, SecretsVaultConfig
from .storage import FileStorage
from .types import (
    AccessDeniedError,
    AccessRequest,
    AnomalyType,
    EncryptionError,
    Environment,
    EventQuery,
    Permission,
    PolicyCondition,
    RateLimitEntry,
    RateLimitExceededError,
    RateLimitResult,
    RateLimitRule,
    RateLimitViolation,
    Role,
    Secret,
    SecretAccess,
    SecFnError,
    SecretNotFoundError,
    SecretPattern,
    SecretScanResult,
    SecurityAnomaly,
    SecurityEvent,
    SecurityEventType,
    SecurityMetrics,
    SetSecretOptions,
    Severity,
    StorageConfig,
    UserRole,
)
from .utils import (
    calculate_entropy,
    generate_id,
    is_expired,
    redact_secret,
    sanitize_for_log,
)

__all__ = [
    "__version__",
    "__author__",
    "__license__",
    # Main classes
    "SecFn",
    "create_secfn",
    "SecFnConfig",
    # Secrets vault
    "SecretsVault",
    "SecretsVaultConfig",
    "SecretEncryption",
    # Access control
    "AccessControl",
    "AccessControlConfig",
    # Rate limiting
    "RateLimiter",
    "RateLimiterConfig",
    # Monitoring
    "SecurityMonitor",
    "MonitoringConfig",
    # Scanning
    "SecretScanner",
    "SecretScannerConfig",
    "DEFAULT_PATTERNS",
    # Storage
    "FileStorage",
    # Types
    "Secret",
    "SecretAccess",
    "SetSecretOptions",
    "Role",
    "Permission",
    "UserRole",
    "PolicyCondition",
    "AccessRequest",
    "RateLimitRule",
    "RateLimitEntry",
    "RateLimitResult",
    "RateLimitViolation",
    "SecurityEvent",
    "SecurityMetrics",
    "SecurityAnomaly",
    "EventQuery",
    "SecretPattern",
    "SecretScanResult",
    "StorageConfig",
    # Enums
    "Severity",
    "Environment",
    "SecurityEventType",
    "AnomalyType",
    # Exceptions
    "SecFnError",
    "EncryptionError",
    "SecretNotFoundError",
    "AccessDeniedError",
    "RateLimitExceededError",
    # Utils
    "generate_id",
    "calculate_entropy",
    "redact_secret",
    "is_expired",
    "sanitize_for_log",
    # Schema
    "get_schema",
]

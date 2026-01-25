"""Core type definitions for secfn Python SDK."""

from datetime import datetime
from enum import Enum
from typing import Any, Dict, List, Literal, Optional, Protocol, Union

from pydantic import BaseModel, Field


# Enums
class Severity(str, Enum):
    """Security severity levels."""

    CRITICAL = "critical"
    HIGH = "high"
    MEDIUM = "medium"
    LOW = "low"
    INFO = "info"


class Environment(str, Enum):
    """Deployment environments."""

    DEVELOPMENT = "development"
    STAGING = "staging"
    PRODUCTION = "production"


class SecurityEventType(str, Enum):
    """Types of security events."""

    AUTH_FAILURE = "auth_failure"
    RATE_LIMIT_EXCEEDED = "rate_limit_exceeded"
    UNAUTHORIZED_ACCESS = "unauthorized_access"
    SECRET_ACCESSED = "secret_accessed"
    PERMISSION_DENIED = "permission_denied"
    SUSPICIOUS_ACTIVITY = "suspicious_activity"
    SECRET_EXPOSED = "secret_exposed"
    POLICY_VIOLATION = "policy_violation"


class AnomalyType(str, Enum):
    """Types of security anomalies."""

    UNUSUAL_ACCESS_PATTERN = "unusual_access_pattern"
    GEOGRAPHIC_ANOMALY = "geographic_anomaly"
    SPIKE_IN_FAILURES = "spike_in_failures"
    NEW_ENDPOINT_ACCESS = "new_endpoint_access"
    UNUSUAL_TIME = "unusual_time"


# Secrets Vault Models
class Secret(BaseModel):
    """Encrypted secret with metadata."""

    id: str
    key: str
    value: str
    encrypted: bool
    version: int
    tags: List[str] = Field(default_factory=list)
    environment: Optional[Environment] = None
    expires_at: Optional[int] = Field(None, alias="expiresAt")
    rotate_every: Optional[int] = Field(None, alias="rotateEvery")
    last_rotated: Optional[int] = Field(None, alias="lastRotated")
    last_accessed: Optional[int] = Field(None, alias="lastAccessed")
    access_count: int = Field(default=0, alias="accessCount")
    created_by: str = Field(alias="createdBy")
    created_at: int = Field(alias="createdAt")
    updated_at: int = Field(alias="updatedAt")

    class Config:
        populate_by_name = True


class SecretAccess(BaseModel):
    """Audit log for secret access."""

    id: str
    secret_id: str = Field(alias="secretId")
    user_id: str = Field(alias="userId")
    action: Literal["read", "write", "delete", "rotate"]
    timestamp: int
    ip: Optional[str] = None
    user_agent: Optional[str] = Field(None, alias="userAgent")

    class Config:
        populate_by_name = True


class SetSecretOptions(BaseModel):
    """Options for setting a secret."""

    tags: Optional[List[str]] = None
    environment: Optional[Environment] = None
    expires_at: Optional[int] = Field(None, alias="expiresAt")
    rotate_every: Optional[int] = Field(None, alias="rotateEvery")
    created_by: Optional[str] = Field(None, alias="createdBy")

    class Config:
        populate_by_name = True


# Access Control Models
class PolicyCondition(BaseModel):
    """Conditional access rule."""

    field: str
    operator: Literal["eq", "ne", "in", "nin", "gt", "lt", "contains"]
    value: Any


class Permission(BaseModel):
    """Resource-action permission."""

    id: str
    resource: str
    action: str
    conditions: Optional[List[PolicyCondition]] = None


class Role(BaseModel):
    """Role definition with permissions."""

    id: str
    name: str
    description: str
    permissions: List[str]
    inherits: Optional[List[str]] = None
    metadata: Optional[Dict[str, Any]] = None
    created_at: int = Field(alias="createdAt")
    updated_at: int = Field(alias="updatedAt")

    class Config:
        populate_by_name = True


class UserRole(BaseModel):
    """User-role assignment."""

    user_id: str = Field(alias="userId")
    role_id: str = Field(alias="roleId")
    resource_ids: Optional[List[str]] = Field(None, alias="resourceIds")
    expires_at: Optional[int] = Field(None, alias="expiresAt")
    assigned_at: int = Field(alias="assignedAt")

    class Config:
        populate_by_name = True


class AccessRequest(BaseModel):
    """Permission check request."""

    user_id: str = Field(alias="userId")
    action: str
    resource_id: Optional[str] = Field(None, alias="resourceId")
    context: Optional[Dict[str, Any]] = None

    class Config:
        populate_by_name = True


# Rate Limiting Models
class RateLimitRule(BaseModel):
    """Rate limit configuration."""

    id: Optional[str] = None
    name: Optional[str] = None
    type: Optional[Literal["global", "perUser", "perIP", "perEndpoint"]] = None
    requests: int
    window: int
    block_duration: Optional[int] = Field(None, alias="blockDuration")
    endpoints: Optional[List[str]] = None

    class Config:
        populate_by_name = True


class RateLimitEntry(BaseModel):
    """Current state of rate limit bucket."""

    key: str
    count: int
    reset_at: int = Field(alias="resetAt")
    blocked: bool
    blocked_until: Optional[int] = Field(None, alias="blockedUntil")

    class Config:
        populate_by_name = True


class RateLimitResult(BaseModel):
    """Result of rate limit check."""

    allowed: bool
    remaining: int
    reset_at: int = Field(alias="resetAt")
    retry_after: Optional[int] = Field(None, alias="retryAfter")
    limit: Optional[int] = None

    class Config:
        populate_by_name = True


class RateLimitViolation(BaseModel):
    """Rate limit violation event."""

    id: str
    timestamp: int
    key: str
    ip: str
    user_id: Optional[str] = Field(None, alias="userId")
    endpoint: str
    request_count: int = Field(alias="requestCount")
    limit: int
    window: int
    blocked: bool

    class Config:
        populate_by_name = True


# Security Monitoring Models
class SecurityEvent(BaseModel):
    """Security event with full metadata."""

    id: str
    timestamp: int
    type: SecurityEventType
    severity: Severity
    user_id: Optional[str] = Field(None, alias="userId")
    ip: str
    user_agent: Optional[str] = Field(None, alias="userAgent")
    resource: Optional[str] = None
    action: Optional[str] = None
    metadata: Dict[str, Any] = Field(default_factory=dict)
    resolved: bool = False
    resolved_at: Optional[int] = Field(None, alias="resolvedAt")
    resolved_by: Optional[str] = Field(None, alias="resolvedBy")
    notes: Optional[str] = None

    class Config:
        populate_by_name = True


class SecurityAnomaly(BaseModel):
    """Detected security anomaly."""

    id: str
    timestamp: int
    type: AnomalyType
    score: float
    description: str
    related_events: List[str] = Field(alias="relatedEvents")
    user_id: Optional[str] = Field(None, alias="userId")
    ip: Optional[str] = None

    class Config:
        populate_by_name = True


class SecurityMetrics(BaseModel):
    """Aggregated security metrics."""

    time_range: Dict[str, int] = Field(alias="timeRange")
    total_events: int = Field(alias="totalEvents")
    events_by_type: Dict[str, int] = Field(alias="eventsByType")
    events_by_severity: Dict[str, int] = Field(alias="eventsBySeverity")
    top_ips: List[Dict[str, Union[str, int]]] = Field(alias="topIPs")
    top_users: List[Dict[str, Union[str, int]]] = Field(alias="topUsers")
    anomalies: Optional[List[SecurityAnomaly]] = None

    class Config:
        populate_by_name = True


class EventQuery(BaseModel):
    """Query parameters for events."""

    type: Optional[Union[SecurityEventType, List[SecurityEventType]]] = None
    severity: Optional[Union[Severity, List[Severity]]] = None
    user_id: Optional[str] = Field(None, alias="userId")
    ip: Optional[str] = None
    start_date: Optional[int] = Field(None, alias="startDate")
    end_date: Optional[int] = Field(None, alias="endDate")
    resolved: Optional[bool] = None
    limit: Optional[int] = None
    offset: Optional[int] = None

    class Config:
        populate_by_name = True


# Secret Scanning Models
class SecretPattern(BaseModel):
    """Pattern definition for secret detection."""

    name: str
    pattern: str  # Will be compiled to regex
    entropy: Optional[float] = None
    description: str
    severity: Severity


class SecretScanResult(BaseModel):
    """Detected secret with location and context."""

    id: str
    timestamp: int
    file: str
    line: int
    column: int
    pattern: str
    match: str
    redacted_match: str = Field(alias="redactedMatch")
    severity: Severity
    entropy: float
    context: str
    resolved: bool = False
    false_positive: bool = Field(False, alias="falsePositive")
    metadata: Optional[Dict[str, Any]] = None

    class Config:
        populate_by_name = True


# Storage Configuration
class StorageConfig(BaseModel):
    """Storage configuration."""

    type: Literal["file", "db"]
    path: Optional[str] = None
    db_name: Optional[str] = Field(None, alias="dbName")
    adapter: Optional[Any] = None
    retention_days: Optional[int] = Field(None, alias="retentionDays")

    class Config:
        populate_by_name = True
        arbitrary_types_allowed = True


# Database Adapter is now superfunctions.db.Adapter
from superfunctions.db import Adapter as DatabaseAdapter


# Exceptions
class SecFnError(Exception):
    """Base exception for secfn."""

    pass


class EncryptionError(SecFnError):
    """Encryption/decryption error."""

    pass


class SecretNotFoundError(SecFnError):
    """Secret not found error."""

    pass


class AccessDeniedError(SecFnError):
    """Permission denied error."""

    pass


class RateLimitExceededError(SecFnError):
    """Rate limit exceeded error."""

    pass

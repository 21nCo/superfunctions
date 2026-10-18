from enum import Enum
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, field_validator


class BugSeverity(str, Enum):
    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"
    CRITICAL = "critical"


class BreadcrumbType(str, Enum):
    NAVIGATION = "navigation"
    CONSOLE = "console"
    NETWORK = "network"
    USER = "user"
    CUSTOM = "custom"


class Breadcrumb(BaseModel):
    type: BreadcrumbType
    timestamp: float
    message: str | None = None
    data: dict[str, Any] | None = None
    category: str | None = None
    level: str | None = None


class ConsoleLogEntry(BaseModel):
    level: str
    args: list[Any]
    timestamp: float


class NetworkRequest(BaseModel):
    url: str
    method: str
    status: int | None = None
    statusText: str | None = None
    duration: float | None = None
    timestamp: float
    requestHeaders: dict[str, str] | None = None
    responseHeaders: dict[str, str] | None = None


class DeviceInfo(BaseModel):
    userAgent: str | None = None
    platform: str | None = None
    language: str | None = None
    screenResolution: str | None = None
    viewportSize: str | None = None
    timezone: str | None = None
    nodeVersion: str | None = None
    memoryUsage: dict[str, float] | None = None


class AttachmentReference(BaseModel):
    id: str
    name: str
    type: str
    size: int = Field(ge=0)
    kind: str | None = None
    mimeType: str | None = None
    annotationScene: dict[str, Any] | None = None
    url: str | None = None
    dataUrl: str | None = None


class UserContext(BaseModel):
    id: str | None = None
    email: str | None = None
    username: str | None = None

    model_config = ConfigDict(extra="allow")


class AppContext(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    version: str | None = None


class BugReportEvent(BaseModel):
    model_config = ConfigDict(extra="allow", allow_inf_nan=False)
    id: str = Field(min_length=1, max_length=200)
    timestamp: float = Field(ge=0)
    title: str = Field(min_length=1, max_length=2000)

    @field_validator("title")
    @classmethod
    def title_is_nonempty(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("Bug title is required")
        return value

    description: str | None = None
    steps: list[str] | None = None
    app: AppContext | None = None
    sessionId: str | None = None
    replayId: str | None = None
    severity: BugSeverity
    tags: list[str] | None = Field(default=None, max_length=100)

    # Context
    breadcrumbs: list[Breadcrumb] | None = None
    consoleLogs: list[ConsoleLogEntry] | None = None
    networkRequests: list[NetworkRequest] | None = None
    deviceInfo: DeviceInfo | None = None

    # User context
    user: UserContext | None = None

    # Environment
    environment: str | None = None
    release: str | None = None

    # Attachments
    attachments: list[AttachmentReference] | None = None

    # Integration
    integration: dict[str, str] | None = None

    # Custom metadata
    metadata: dict[str, Any] | None = None

    # Internal
    receivedAt: float | None = None

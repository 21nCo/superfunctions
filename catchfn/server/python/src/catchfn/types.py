from typing import List, Optional, Any, Dict, Union
from enum import Enum
from pydantic import BaseModel, Field

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
    message: Optional[str] = None
    data: Optional[Dict[str, Any]] = None
    category: Optional[str] = None
    level: Optional[str] = None

class ConsoleLogEntry(BaseModel):
    level: str
    args: List[Any]
    timestamp: float

class NetworkRequest(BaseModel):
    url: str
    method: str
    status: Optional[int] = None
    statusText: Optional[str] = None
    duration: Optional[float] = None
    timestamp: float
    requestHeaders: Optional[Dict[str, str]] = None
    responseHeaders: Optional[Dict[str, str]] = None

class DeviceInfo(BaseModel):
    userAgent: Optional[str] = None
    platform: Optional[str] = None
    language: Optional[str] = None
    screenResolution: Optional[str] = None
    viewportSize: Optional[str] = None
    timezone: Optional[str] = None
    nodeVersion: Optional[str] = None
    memoryUsage: Optional[Dict[str, float]] = None

class AttachmentReference(BaseModel):
    id: str
    name: str
    type: str
    size: int
    url: Optional[str] = None
    dataUrl: Optional[str] = None

class UserContext(BaseModel):
    id: Optional[str] = None
    email: Optional[str] = None
    username: Optional[str] = None
    
    class Config:
        extra = "allow"

class BugReportEvent(BaseModel):
    id: str
    timestamp: float
    title: str
    description: Optional[str] = None
    severity: BugSeverity
    tags: Optional[List[str]] = None

    # Context
    breadcrumbs: Optional[List[Breadcrumb]] = None
    consoleLogs: Optional[List[ConsoleLogEntry]] = None
    networkRequests: Optional[List[NetworkRequest]] = None
    deviceInfo: Optional[DeviceInfo] = None

    # User context
    user: Optional[UserContext] = None

    # Environment
    environment: Optional[str] = None
    release: Optional[str] = None

    # Attachments
    attachments: Optional[List[AttachmentReference]] = None

    # Integration
    integration: Optional[Dict[str, str]] = None

    # Custom metadata
    metadata: Optional[Dict[str, Any]] = None
    
    # Internal
    receivedAt: Optional[float] = None

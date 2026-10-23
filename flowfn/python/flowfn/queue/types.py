"""Queue type definitions."""

from typing import Any, Literal, Optional, Callable, Awaitable
from pydantic import BaseModel, Field
from enum import Enum


class JobStatus(str, Enum):
    """Job status enum."""
    WAITING = "waiting"
    ACTIVE = "active"
    COMPLETED = "completed"
    FAILED = "failed"
    DELAYED = "delayed"
    PAUSED = "paused"


class BackoffType(str, Enum):
    """Backoff strategy type."""
    FIXED = "fixed"
    EXPONENTIAL = "exponential"
    CUSTOM = "custom"


class BackoffOptions(BaseModel):
    """Backoff configuration."""
    type: BackoffType = BackoffType.EXPONENTIAL
    delay: int = 1000
    max_delay: Optional[int] = None


class JobOptions(BaseModel):
    """Job configuration options."""
    priority: int = 5
    delay: int = 0
    attempts: int = 3
    backoff: Optional[BackoffOptions] = None
    timeout: Optional[int] = None
    remove_on_complete: bool | int = False
    remove_on_fail: bool | int = False
    job_id: Optional[str] = None
    prevent_duplicates: bool = False
    deduplication_key: Optional[str] = None
    wait_for: Optional[list[str]] = None


class Job(BaseModel):
    """Job model."""
    id: str
    name: str
    data: Any
    opts: JobOptions = Field(default_factory=JobOptions)
    
    # Status
    state: JobStatus = JobStatus.WAITING
    progress: int = 0
    returnvalue: Optional[Any] = None
    
    # Timing
    timestamp: int
    processed_on: Optional[int] = None
    finished_on: Optional[int] = None
    delay: int = 0
    
    # Retries
    attempts_made: int = 0
    failed_reason: Optional[str] = None
    stacktrace: list[str] = Field(default_factory=list)
    
    class Config:
        arbitrary_types_allowed = True


class QueueStats(BaseModel):
    """Queue statistics."""
    waiting: int = 0
    active: int = 0
    completed: int = 0
    failed: int = 0
    delayed: int = 0
    paused: int = 0


class BatchOptions(BaseModel):
    """Batch processing options."""
    batch_size: int = 10
    max_wait: int = 5000


# Type aliases
JobHandler = Callable[[Job], Awaitable[Any]]
BatchHandler = Callable[[list[Job]], Awaitable[list[Any]]]

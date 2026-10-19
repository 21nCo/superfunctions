"""Queue type definitions."""

from typing import Any, Literal, Optional, Callable, Awaitable, Union
from pydantic import BaseModel, Field, PrivateAttr, field_validator
from enum import Enum


class JobLeaseError(ValueError):
    """A queue claim expired or was replaced by another worker."""


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
    delay: int = Field(default=1000, ge=0)
    max_delay: Optional[int] = Field(default=None, ge=0)
    strategy: Optional[Callable[[int], int]] = Field(default=None, exclude=True)


class JobOptions(BaseModel):
    """Job configuration options."""

    priority: int = 5
    delay: int = Field(default=0, ge=0)
    attempts: int = Field(default=3, ge=1)
    backoff: Optional[BackoffOptions] = None
    timeout: Optional[int] = Field(default=None, gt=0)
    remove_on_complete: Union[bool, int] = False
    remove_on_fail: Union[bool, int] = False
    job_id: Optional[str] = None
    prevent_duplicates: bool = False
    deduplication_key: Optional[str] = None
    wait_for: Optional[list[str]] = None

    @field_validator("remove_on_complete", "remove_on_fail")
    @classmethod
    def validate_retention(cls, value: Union[bool, int]) -> Union[bool, int]:
        if isinstance(value, int) and value < 0:
            raise ValueError("Retention count must be nonnegative")
        return value


class Job(BaseModel):
    """Job model."""

    id: str
    name: str
    data: Any
    opts: JobOptions = Field(default_factory=JobOptions)

    # Status
    state: JobStatus = JobStatus.WAITING
    progress: int = 0
    lease_token: Optional[str] = None
    lease_expires_at: Optional[int] = None
    returnvalue: Optional[Any] = None

    # Transient receipt from the atomic enqueue operation; never persisted.
    _enqueue_created: Optional[bool] = PrivateAttr(default=None)

    trace_context: Optional[dict[str, str]] = None

    # Timing
    timestamp: int
    available_at: Optional[int] = None
    processed_on: Optional[int] = None
    finished_on: Optional[int] = None
    delay: int = Field(default=0, ge=0)

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

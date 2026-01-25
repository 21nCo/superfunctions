"""Workflow type definitions."""

from typing import Any, Optional, Callable, Awaitable
from pydantic import BaseModel, Field
from enum import Enum


class ExecutionStatus(str, Enum):
    """Workflow execution status."""
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCELLED = "cancelled"


class WorkflowExecution(BaseModel):
    """Workflow execution state."""
    id: str
    workflow_id: str
    input: Any
    status: ExecutionStatus
    context: dict[str, Any] = Field(default_factory=dict)
    result: Optional[Any] = None
    error: Optional[str] = None
    started_at: int
    completed_at: Optional[int] = None
    created_at: int
    updated_at: int
    state: dict[str, Any] = Field(default_factory=dict)
    
    class Config:
        arbitrary_types_allowed = True


class WorkflowEvent(BaseModel):
    """Workflow execution event."""
    id: str
    execution_id: str
    type: str
    timestamp: int
    data: Optional[dict[str, Any]] = None


class ListOptions(BaseModel):
    """List query options."""
    status: Optional[ExecutionStatus] = None
    limit: int = 100
    offset: int = 0


# Type aliases
StepHandler = Callable[[Any], Awaitable[None]]
ConditionFunc = Callable[[Any], bool]


class WorkflowContext:
    """Execution context for workflow steps."""
    
    def __init__(self, input_data: Any, state: dict[str, Any]):
        self.input = input_data
        self._state = state
    
    def get(self, key: str, default: Any = None) -> Any:
        """Get value from context."""
        return self._state.get(key, default)
    
    def set(self, key: str, value: Any) -> None:
        """Set value in context."""
        self._state[key] = value
    
    def has(self, key: str) -> bool:
        """Check if key exists."""
        return key in self._state
    
    def delete(self, key: str) -> None:
        """Delete key from context."""
        self._state.pop(key, None)
    
    @property
    def state(self) -> dict[str, Any]:
        """Get full state."""
        return self._state

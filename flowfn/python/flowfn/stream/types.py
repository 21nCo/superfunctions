"""Stream type definitions."""

from typing import Any, Optional, Callable, Awaitable
from pydantic import BaseModel, Field


class PublishOptions(BaseModel):
    """Message publish options."""
    key: Optional[str] = None
    headers: Optional[dict[str, str]] = None
    partition: Optional[int] = None


class Message(BaseModel):
    """Stream message."""
    id: str
    stream: str
    data: Any
    headers: Optional[dict[str, str]] = None
    timestamp: int
    partition: Optional[int] = None
    offset: Optional[int] = None
    key: Optional[str] = None
    
    class Config:
        arbitrary_types_allowed = True
    
    async def ack(self) -> None:
        """Acknowledge message."""
        pass
    
    async def nack(self, requeue: bool = False) -> None:
        """Negative acknowledge."""
        pass


class SubscribeOptions(BaseModel):
    """Subscribe options."""
    pass


class ConsumerOptions(BaseModel):
    """Consumer group options."""
    group_id: str
    from_beginning: bool = False
    auto_commit: bool = False
    commit_interval: int = 1000
    max_in_flight: int = 100


class StreamInfo(BaseModel):
    """Stream information."""
    name: str
    length: int
    groups: int = 0


class TrimStrategy(BaseModel):
    """Stream trim strategy."""
    max_length: Optional[int] = None
    max_age_seconds: Optional[int] = None


# Type aliases
MessageHandler = Callable[[Message], Awaitable[None]]

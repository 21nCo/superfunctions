"""Stream type definitions."""

from typing import Any, Optional, Callable, Awaitable
from pydantic import BaseModel, Field, PrivateAttr


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

    _acknowledge: Optional[Callable[[bool], Awaitable[None]]] = PrivateAttr(default=None)

    async def ack(self) -> None:
        """Acknowledge message."""
        if self._acknowledge is not None:
            await self._acknowledge(False)

    async def nack(self, requeue: bool = False) -> None:
        """Negative acknowledge."""
        if self._acknowledge is not None:
            await self._acknowledge(requeue)


class SubscribeOptions(BaseModel):
    """Subscribe options."""

    pass


class ConsumerOptions(BaseModel):
    """Consumer group options."""

    group_id: str = Field(min_length=1)
    from_beginning: bool = False
    auto_commit: bool = False
    commit_interval: int = Field(default=1000, gt=0)
    max_in_flight: int = Field(default=100, ge=1, le=10000)


class StreamInfo(BaseModel):
    """Stream information."""

    name: str
    length: int
    groups: int = 0


class TrimStrategy(BaseModel):
    """Stream trim strategy."""

    max_length: Optional[int] = Field(default=None, ge=0)
    max_age_seconds: Optional[int] = Field(default=None, ge=0)


# Type aliases
MessageHandler = Callable[[Message], Awaitable[None]]

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, List, Sequence

from ..core.errors import ValidationError


@dataclass
class BufferMemory:
    max_messages: int = 10
    _messages: List[Dict[str, Any]] = field(default_factory=list)

    def __post_init__(self) -> None:
        if self.max_messages < 0:
            raise ValidationError("BufferMemory max_messages must be non-negative", metadata={"max_messages": self.max_messages})

    async def add(self, message: Dict[str, Any]) -> None:
        self._messages.append(dict(message))
        if self.max_messages == 0:
            self._messages = []
            return
        if len(self._messages) > self.max_messages:
            self._messages = self._messages[-self.max_messages :]

    async def extend(self, messages: Sequence[Dict[str, Any]]) -> None:
        for message in messages:
            await self.add(message)

    async def get(self) -> List[Dict[str, Any]]:
        return [dict(message) for message in self._messages]

    async def clear(self) -> None:
        self._messages = []

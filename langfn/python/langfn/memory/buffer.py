from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, List, Sequence


@dataclass
class BufferMemory:
    max_messages: int = 10
    _messages: List[Dict[str, Any]] = field(default_factory=list)

    async def add(self, message: Dict[str, Any]) -> None:
        self._messages.append(message)
        if len(self._messages) > self.max_messages:
            self._messages = self._messages[-self.max_messages :]

    async def extend(self, messages: Sequence[Dict[str, Any]]) -> None:
        for m in messages:
            await self.add(dict(m))

    async def get(self) -> List[Dict[str, Any]]:
        return list(self._messages)


from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Dict, List, Literal, Sequence

from .template import PromptTemplate

Role = Literal["system", "user", "assistant", "tool"]


@dataclass(frozen=True)
class ChatMessageTemplate:
    role: Role
    content: str

    def format(self, values: Dict[str, Any]) -> Dict[str, Any]:
        return {"role": self.role, "content": self.content.format_map(values)}


@dataclass(frozen=True)
class ChatTemplate:
    messages: Sequence[ChatMessageTemplate]

    def format(self, values: Dict[str, Any]) -> List[Dict[str, Any]]:
        return [m.format(values) for m in self.messages]


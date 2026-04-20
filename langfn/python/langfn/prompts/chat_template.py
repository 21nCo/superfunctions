from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Dict, Iterable, List, Literal, Mapping, Sequence, Tuple

from .template import PromptTemplate, _normalize_values

Role = Literal["system", "user", "assistant", "tool"]


@dataclass(frozen=True)
class ChatMessageTemplate:
    role: Role
    content: str

    def format(self, values: Mapping[str, Any]) -> Dict[str, Any]:
        prompt = PromptTemplate(self.content)
        return {"role": self.role, "content": prompt.format(values)}


@dataclass(frozen=True)
class ChatTemplate:
    messages: Sequence[ChatMessageTemplate]

    @classmethod
    def from_messages(cls, messages: Iterable[Tuple[Role, str]]) -> "ChatTemplate":
        return cls([ChatMessageTemplate(role=role, content=content) for role, content in messages])

    def format_messages(self, values: Mapping[str, Any] | None = None, **kwargs: Any) -> List[Dict[str, Any]]:
        payload = _normalize_values(values, **kwargs)
        return [message.format(payload) for message in self.messages]

    def format(self, values: Mapping[str, Any] | None = None, **kwargs: Any) -> List[Dict[str, Any]]:
        return self.format_messages(values, **kwargs)

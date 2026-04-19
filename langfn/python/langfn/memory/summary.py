from __future__ import annotations

from typing import Any, Callable, Dict, List, Optional

from ..client import LangFn
from ..core.errors import ValidationError

Summarizer = Callable[[dict[str, Any]], Any]


class SummaryMemory:
    def __init__(
        self,
        lang: Optional[LangFn] = None,
        max_messages: int = 10,
        summary_prompt: str = "Summarize the following conversation history concisely, retaining all key information:",
        summarizer: Optional[Summarizer] = None,
    ):
        if max_messages < 0:
            raise ValidationError("SummaryMemory max_messages must be non-negative", metadata={"max_messages": max_messages})
        self._lang = lang
        self._max_messages = max_messages
        self._summary_prompt = summary_prompt
        self._summarizer = summarizer
        self._messages: List[Dict[str, Any]] = []
        self._summary: Optional[str] = None

    async def add(self, message: Dict[str, Any]) -> None:
        self._messages.append(dict(message))
        await self._compact_if_needed()

    async def extend(self, messages: List[Dict[str, Any]]) -> None:
        for message in messages:
            await self.add(message)

    async def get(self) -> List[Dict[str, Any]]:
        history: List[Dict[str, Any]] = []
        if self._summary:
            history.append({"role": "system", "content": f"Previous conversation summary: {self._summary}"})
        history.extend(dict(message) for message in self._messages)
        return history

    def get_summary(self) -> Optional[str]:
        return self._summary

    async def clear(self) -> None:
        self._messages = []
        self._summary = None

    async def _compact_if_needed(self) -> None:
        if len(self._messages) <= self._max_messages:
            return
        overflow_count = len(self._messages) - self._max_messages
        to_summarize = self._messages[:overflow_count]
        self._summary = await self._create_summary(to_summarize)
        self._messages = self._messages[overflow_count:]

    async def _create_summary(self, messages: List[Dict[str, Any]]) -> str:
        payload = {"existing_summary": self._summary, "messages": [dict(message) for message in messages]}
        if self._summarizer is not None:
            result = self._summarizer(payload)
            if hasattr(result, "__await__"):
                return await result
            return str(result)
        if self._lang is None:
            lines = [self._summary] if self._summary else []
            lines.extend(f"{message['role']}: {message['content']}" for message in messages)
            return "\n".join(line for line in lines if line)

        prompt = "\n".join(
            [
                self._summary_prompt,
                "",
                f"Existing Summary: {self._summary or 'None'}",
                "",
                "New Messages:",
                *[f"{message['role']}: {message['content']}" for message in messages],
            ]
        )
        response = await self._lang.complete(prompt)
        return response.content

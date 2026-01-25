from __future__ import annotations

from typing import Any, Dict, List, Optional

from ..client import LangFn


class SummaryMemory:
    def __init__(
        self,
        lang: LangFn,
        max_tokens: int = 2000,
        summary_prompt: str = "Summarize the following conversation history concisely, retaining all key information:",
    ):
        self._lang = lang
        self._max_tokens = max_tokens
        self._summary_prompt = summary_prompt
        self._messages: List[Dict[str, Any]] = []
        self._summary: Optional[str] = None

    async def add(self, message: Dict[str, Any]) -> None:
        self._messages.append(message)
        # In a real app, we would check token count here
        if len(self._messages) > 10:  # Placeholder for token limit
            await self._summarize()

    async def _summarize(self) -> None:
        history = "\n".join([f"{m['role']}: {m['content']}" for m in self._messages])
        prompt = f"{self._summary_prompt}\n\nExisting Summary: {self._summary or 'None'}\n\nNew Messages:\n{history}"
        
        response = await self._lang.complete(prompt)
        self._summary = response.content
        # Clear messages after summarizing to keep context window clean
        self._messages = []

    async def get(self) -> List[Dict[str, Any]]:
        history: List[Dict[str, Any]] = []
        if self._summary:
            history.append({"role": "system", "content": f"Previous conversation summary: {self._summary}"})
        history.extend(self._messages)
        return history

    async def clear(self) -> None:
        self._messages = []
        self._summary = None

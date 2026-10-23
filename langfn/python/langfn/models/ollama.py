from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any, AsyncIterator, Dict, Optional

import httpx

from ..core.errors import ProviderError
from ..core.types import (
    ChatRequest,
    ChatResponse,
    CompletionRequest,
    CompletionResponse,
    ContentEvent,
    EndEvent,
    Message,
    StreamEvent,
    TokenUsage,
)
from .base import ChatModel
from .transport import get_async_client


@dataclass
class OllamaChatModel(ChatModel):
    model: str = "llama3"
    base_url: str = "http://localhost:11434"
    timeout: float = 120.0
    transport: Optional[Any] = None
    provider: str = "ollama"

    def _client(self):
        return get_async_client(
            base_url=self.base_url,
            headers={"content-type": "application/json"},
            timeout=self.timeout,
            transport=self.transport,
        )

    async def complete(self, request: CompletionRequest) -> CompletionResponse:
        return await self._complete_from_chat(request)

    async def chat(self, request: ChatRequest) -> ChatResponse:
        payload: Dict[str, Any] = {"model": self.model, "messages": request.messages, "stream": False}
        try:
            resp = await self._client().post("/api/chat", json=payload)
        except httpx.ConnectError as exc:
            raise ProviderError("Could not connect to Ollama", provider=self.provider) from exc
        self._raise_for_status(resp)
        data = resp.json()
        message = data.get("message") or {}
        return ChatResponse(
            message=Message(role=message.get("role", "assistant"), content=message.get("content", "")),
            raw=data,
            usage=TokenUsage.from_counts(
                prompt_tokens=int(data.get("prompt_eval_count", 0)),
                completion_tokens=int(data.get("eval_count", 0)),
            ),
        )

    async def stream(self, request: CompletionRequest) -> AsyncIterator[StreamEvent]:
        payload: Dict[str, Any] = {"model": self.model, "messages": [{"role": "user", "content": request.prompt}], "stream": True}
        try:
            async with self._client().stream("POST", "/api/chat", json=payload) as resp:
                self._raise_for_status(resp)
                async for line in resp.aiter_lines():
                    if not line:
                        continue
                    try:
                        chunk = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    if chunk.get("done"):
                        yield EndEvent(finish_reason="stop")
                        return
                    content = (chunk.get("message") or {}).get("content", "")
                    if content:
                        yield ContentEvent(content=content, delta=content)
        except httpx.ConnectError as exc:
            raise ProviderError("Could not connect to Ollama", provider=self.provider) from exc
        yield EndEvent(finish_reason="stop")

    def _raise_for_status(self, resp) -> None:
        if 200 <= resp.status_code < 300:
            return
        raise ProviderError(
            f"Ollama request failed ({resp.status_code})",
            provider=self.provider,
            metadata={"status": resp.status_code, "body": resp.text},
        )

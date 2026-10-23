from __future__ import annotations

from dataclasses import dataclass
from typing import Any, AsyncIterator, Dict, Optional

from ..core.errors import ProviderAuthError, ProviderError, RateLimitError
from ..core.types import (
    ChatRequest,
    ChatResponse,
    CompletionRequest,
    CompletionResponse,
    ContentEvent,
    EndEvent,
    Message,
    StreamEvent,
)
from .base import ChatModel
from .transport import get_async_client


@dataclass
class GoogleChatModel(ChatModel):
    api_key: str = ""
    model: str = "gemini-1.5-flash"
    base_url: str = "https://generativelanguage.googleapis.com/v1beta"
    timeout: float = 60.0
    transport: Optional[Any] = None
    provider: str = "google"

    def _client(self):
        return get_async_client(base_url=self.base_url, headers={"content-type": "application/json"}, timeout=self.timeout, transport=self.transport)

    async def complete(self, request: CompletionRequest) -> CompletionResponse:
        chat = await self.chat(ChatRequest(messages=[{"role": "user", "content": request.prompt}], metadata=request.metadata))
        return CompletionResponse(content=chat.message.content, raw=chat.raw, usage=chat.usage)

    async def chat(self, request: ChatRequest) -> ChatResponse:
        payload = {
            "contents": [
                {"role": m["role"], "parts": [{"text": m["content"]}]}
                for m in request.messages
                if m["role"] in {"user", "assistant"}
            ]
        }
        client = self._client()
        resp = await client.post(f"/models/{self.model}:generateContent", params={"key": self.api_key}, json=payload)
        self._raise_for_status(resp)
        data = resp.json()
        parts = (((data.get("candidates") or [{}])[0]).get("content") or {}).get("parts") or []
        text = "".join(part.get("text", "") for part in parts)
        return ChatResponse(message=Message(role="assistant", content=text), raw=data)

    async def stream(self, request: CompletionRequest) -> AsyncIterator[StreamEvent]:
        response = await self.complete(request)
        yield ContentEvent(content=response.content, delta=response.content)
        yield EndEvent(finish_reason="stop")

    def _raise_for_status(self, resp) -> None:
        if 200 <= resp.status_code < 300:
            return
        body = resp.text
        if resp.status_code == 401:
            raise ProviderAuthError(provider=self.provider, metadata={"status": resp.status_code, "body": body})
        if resp.status_code == 429:
            raise RateLimitError(provider=self.provider, metadata={"status": resp.status_code, "body": body})
        raise ProviderError(provider=self.provider, metadata={"status": resp.status_code, "body": body})
